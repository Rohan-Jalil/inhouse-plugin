# inhouse-plugin

Reports each Claude Code session — who ran it, on which Claude account, in which
project, how many tokens it used, and a one-line summary — to an internal API,
and shows it on a dashboard.

Nothing is sent to Anthropic. The plugin reads the transcript files Claude Code
already writes locally and posts a summary to your own server.

## Install (developers)

```bash
curl -fsSL https://raw.githubusercontent.com/Rohan-Jalil/inhouse-plugin/main/install.sh \
  | bash -s -- --endpoint <INGEST_URL> --token <INGEST_TOKEN>
```

It asks for your name and email, installs the plugin, and verifies it can reach
the server. Reporting starts with your next session.

Config lives at `~/.config/claude-usage-tracker/config.json`:

| key | |
|---|---|
| `enabled` | set `false` to stop reporting |
| `flushIntervalSec` | how often a running session reports (default 60) |
| `redactContent` | send counts only — no titles, prompts or transcripts |
| `captureLastReply` | include Claude's last reply (off by default) |
| `uploadTranscripts` | set `false` to stop uploading full transcripts |

At the end of each session the full transcript (plus subagent transcripts) is
gzipped and uploaded in the background, so it never slows the session down. If
the server can't take it yet, it waits in `~/.cache/claude-usage-tracker/uploads`
(capped at 300 MB) and retries later.

### Jev model routing (opt-in)

```bash
curl -fsSL https://raw.githubusercontent.com/Rohan-Jalil/inhouse-plugin/main/install.sh \
  | bash -s -- --endpoint <INGEST_URL> --token <INGEST_TOKEN> --jev
```

`--jev` points Claude Code at a small local proxy (`127.0.0.1:47821`, via
`ANTHROPIC_BASE_URL` in Claude's `settings.json`). On each session's first
prompt the proxy asks the server, and [Jev](https://www.jevai.org/) picks
Opus 5.5 or Sonnet 5.5; the rest of that session goes to the chosen model.
Hooks can't do this — Claude Code only switches models via `/model` — so the
proxy rewrites the request's `model` field instead.

- Once per session, before there is any history, so no prompt cache is lost.
- Only the conversation's own model is rerouted; Haiku background calls and
  subagents pinned to another model pass through untouched.
- Any failure — server down, Jev slow, spend cap reached — sends the request
  exactly as Claude Code wrote it. Decisions are logged (no content) to
  `~/.cache/claude-usage-tracker/proxy.log`.
- Claude Code's own UI still names the model you picked; the dashboard shows
  the one that actually answered, Jev's choice, and the estimated saving.

Turn it off with `--no-jev` (restores any `ANTHROPIC_BASE_URL` you had before).

Update to the latest version:

```bash
claude plugin marketplace update inhouse-plugin && claude plugin update inhouse-plugin@inhouse-plugin
```

Remove entirely with `claude plugin uninstall inhouse-plugin@inhouse-plugin`.

## Server

Node 22.5+ (uses the built-in `node:sqlite`, no native modules).

```bash
cd server && npm install
cp .env.example .env      # set INGEST_TOKEN, DASHBOARD_USER, DASHBOARD_PASS
node --env-file=.env src/server.mjs
```

| | |
|---|---|
| `POST /api/ingest` | session reports (Bearer token) |
| `GET /api/overview` | totals, per-developer and per-day rollups |
| `GET /api/sessions` | filtered session list (`developer=`, `account=` take several, comma-separated) |
| `GET /api/filters` | developers and accounts in a date range |
| `POST /api/transcripts/:session/:file` | one ≤1 MB chunk of a gzipped transcript (Bearer token) |
| `GET /api/transcripts/:session[/:file]` | list / download stored transcripts (login required) |
| `GET /transcripts/:session/:file` | read a stored transcript in the browser (login required) |
| `GET /api/spend` | this month's estimated Cloudflare spend against the cap |
| `POST /api/route` | Jev's model choice for a session (Bearer token; used by the proxy) |
| `GET /api/health` | liveness, no auth |
| `GET /` | dashboard (login required) |

**Transcripts** are stored in Cloudflare R2 when `R2_ACCOUNT_ID`, `R2_BUCKET`,
`R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` are set; without them the upload
route answers 503 and clients keep their copy. Objects are stored as
`sessions/<developer email>/<YYYY-MM-DD>/<session id>/main.jsonl.gz` plus one
`agent-<id>.jsonl.gz` per subagent; the dashboard links to each (View /
Download) through the server, since the bucket stays private. They are deleted after
`TRANSCRIPT_RETENTION_DAYS` (default 90).

On the deployed server these credentials are repository **secrets**, written
into `.env` by the deploy workflow (`deploy/apply-env.sh`) — set them under
Settings → Secrets and variables → Actions and re-run the workflow; nobody
edits the server by hand. Unset secrets are skipped, never blanked; a change
that leaves the service unhealthy is rolled back.

**Spend cap.** Cloudflare has no hard spending limit, so the server enforces one:
every R2 (and Jev) call is estimated first and refused once the month's total
would pass `SPEND_CAP_USD` (default 10). Estimates ignore Cloudflare's free
allowances, so the real bill is at or below the figure shown.

**Jev** runs on Cloudflare (`POST /accounts/{id}/ai/run`, model `typesafe/jev`)
when `CF_ACCOUNT_ID` and `CF_AI_TOKEN` (Account › Workers AI › Read) are set.
It is a third-party model billed through AI Gateway Unified Billing, so the
account needs prepaid AI Gateway credits; see `.env.example` for the confidence threshold and whether upgrades
are allowed. Without them `/api/route` answers "not configured" and every
request passes through unchanged.

Put TLS in front of it, and keep it off the open internet if you can — reports
contain prompt text. `BASE_PATH` mounts it under a sub-path behind a shared
vhost.

## Accuracy

Three things this gets right that a naive reader would not:

- **Deduplication.** Claude Code writes one API response's usage across two or
  three transcript lines. Summing them overstated a real session by 59%; usage
  is deduped on `requestId`.
- **Subagents.** Agent-tool work goes to separate transcripts under
  `<session>/subagents/` and never appears in the main one. Ignoring it
  undercounted an agent-heavy session by 15.7%.
- **Interrupted sessions.** Reports are cumulative and upserted per session, so
  a session killed before it ends still lands with everything up to its last
  turn. Failed sends spool locally and retry.

Cost figures convert tokens at public API list prices (`server/pricing.json`).
Developers on Max/Pro seats are not billed these amounts — it is a comparable
measure of work done, not an invoice.

## Consent

This records what people are working on, including prompts and session titles.
Tell your team before enabling it. `redactContent: true` gives counts with no
free text.
