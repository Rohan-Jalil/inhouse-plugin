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
| `redactContent` | send counts only — no titles or prompts |
| `captureLastReply` | include Claude's last reply (off by default) |

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
| `GET /api/sessions` | filtered session list |
| `GET /api/health` | liveness, no auth |
| `GET /` | dashboard (login required) |

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
