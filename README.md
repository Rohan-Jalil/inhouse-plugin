# Claude Code usage tracker

Reports every Claude Code session — who ran it, on which Claude account, in which
project, how many tokens it burned and what it was about — to a small internal
API, and shows it on a dashboard.

```
Employee machine                                  Your server
┌────────────────────────────┐                   ┌──────────────────────┐
│ Claude Code                │                   │  Express (Node 22)   │
│   usage-tracker plugin     │  POST /api/ingest │    │                 │
│    ├ SessionStart  ────────┼──────────────────▶│    ▼                 │
│    ├ Stop (each turn)      │   JSON, Bearer    │  usage.sqlite        │
│    └ SessionEnd            │                   │    │                 │
│         reads the session  │                   │    ▼                 │
│         transcript .jsonl  │                   │  Dashboard  :4317    │
└────────────────────────────┘                   └──────────────────────┘
```

Nothing is sent to Anthropic. The plugin reads transcript files Claude Code
already writes on the developer's own disk and posts a summary to your server.

## What gets reported

| | |
|---|---|
| **Who** | name + email captured at enrollment, plus OS user, hostname and a stable machine id |
| **Which account** | the Claude account the machine is logged into (`oauthAccount.emailAddress`), its org and plan type |
| **Tokens** | input, output, cache-write, cache-read and thinking, split per model |
| **What it was about** | Claude Code's own session title, the first prompt, files touched, tool histogram |
| **Where** | project directory name, full cwd, git branch |
| **When** | start, last activity, duration, and the day it is grouped under |

## Quick start

### 1. Server

```bash
cd server
npm install
cp .env.example .env      # set INGEST_TOKEN and DASHBOARD_PASS
node --env-file=.env src/server.mjs
```

Open <http://127.0.0.1:4317>. For production see `server/deploy/` — a systemd
unit and an nginx TLS front end. **Put TLS in front of it**: reports contain
prompt text.

Requires **Node 22.5+** (it uses the built-in `node:sqlite`; no native modules
to compile).

### 2. Enroll a developer

One command on their machine — nothing to clone, nothing else to configure:

```bash
curl -fsSL https://raw.githubusercontent.com/Rohan-Jalil/inhouse-plugin/main/install.sh \
  | bash -s -- --endpoint https://usage.example.com/api/ingest --token <INGEST_TOKEN>
```

It asks for their name and email (defaulting to their git identity), installs
the plugin from GitHub, and checks it can reach your server. Reporting starts
with their next Claude Code session.

Add `--name` and `--email` to skip the questions entirely:

```bash
curl -fsSL https://raw.githubusercontent.com/Rohan-Jalil/inhouse-plugin/main/install.sh \
  | bash -s -- --endpoint https://usage.example.com/api/ingest --token <TOKEN> \
      --name "Full Name" --email person@company.com --yes
```

> Installing the plugin by itself (`claude plugin install inhouse-plugin@inhouse-plugin`)
> is **not** enough — without an endpoint the plugin stays silent and reports
> nothing. Use the command above, or push the settings file below.

## Does it auto-install on developer machines?

**Yes — if you can place one settings file on the machine. No, if you're hoping
that logging into your Claude account is enough on its own.**

Tested on Claude Code 2.1.263: dropping this block into a machine's
`settings.json` is sufficient on its own — no `install.sh`, no
`claude plugin install`. The first session after the file appears fetches the
marketplace; **from the second session onward the hooks fire.**

```json
{
  "extraKnownMarketplaces": {
    "inhouse-plugin": { "source": { "source": "github", "repo": "Rohan-Jalil/inhouse-plugin" } }
  },
  "enabledPlugins": { "inhouse-plugin@inhouse-plugin": true },
  "env": {
    "CLAUDE_USAGE_ENDPOINT": "https://usage.example.com/api/ingest",
    "CLAUDE_USAGE_TOKEN": "…"
  }
}
```

The `env` block is also honored — verified reaching the hook process — so the
same file carries the endpoint and token. Nothing else has to be installed.

Where you can put that file, strongest first:

| Path | Automatic? | Notes |
|---|---|---|
| `/etc/claude-code/managed-settings.json` (MDM) | Yes, enforced | Developer cannot disable it. Needs device management. |
| `~/.claude/settings.json` (dotfiles, Ansible, onboarding image) | Yes | Developer *can* remove it. |
| Remote managed settings (Anthropic Console) | Yes, account-wide | **Team/Enterprise only** — see below. |
| `.claude/settings.json` committed to a repo | **No** — did not activate in testing | Covers only that repo even where it does work. |
| `./install.sh` | No — one command per person | The fallback when you can't place a file. |

### The account-level channel

Claude Code does pull *remote managed settings* from `/api/claude_code/settings`
for the logged-in account, and every machine on that account applies them. Two
caveats:

1. It is configured by an org admin in the Anthropic Console and is a
   **Team/Enterprise** feature. It is not available on personal Pro/Max orgs
   (`organizationType: claude_max`), so check your plan before relying on it.
2. Hooks count as dangerous settings, so Claude Code shows a one-time security
   consent dialog before applying a remote push containing them.

If you move to Team/Enterprise, the block above is exactly what you'd push, and
it becomes true zero-touch install for anyone on the account.

### Identity when nobody runs the installer

A shared settings file can't carry a per-person name. If no enrollment is
present the reporter falls back to `$USER@$HOSTNAME` and marks the session
`identity_source: "os-account"`; the dashboard tags those rows **auto** so you
can see who still needs a real name attached. Set `CLAUDE_USAGE_NAME` /
`CLAUDE_USAGE_EMAIL` per machine, or run `install.sh`, to make it authoritative.

## Client configuration

`~/.config/claude-usage-tracker/config.json`:

```json
{
  "enabled": true,
  "endpoint": "https://usage.example.com/api/ingest",
  "token": "…",
  "developer": { "name": "Full Name", "email": "you@company.com" },
  "flushIntervalSec": 60,
  "redactContent": false,
  "captureLastReply": false
}
```

- `flushIntervalSec` — `Stop` fires after every turn; this throttles how often it
  actually posts. `SessionStart` and `SessionEnd` always post.
- `redactContent` — send counts only: no title, no prompt, no reply text.
- `captureLastReply` — off by default. Claude's last reply is the field most
  likely to contain a secret it just generated or read, and the title and first
  prompt already answer "what was this session about".

Every value can be overridden by an env var (`CLAUDE_USAGE_ENDPOINT`, etc.).
Set `CLAUDE_USAGE_DEBUG=1` to see the reporter's stderr.

## How it stays accurate

Three things that are easy to get wrong, and what this does about them:

**Double counting.** Claude Code writes the *same* API response's `usage` on two
or three consecutive `assistant` lines — one per content block. Summing rows
overstates a session by ~60% (measured: 282,424 vs the true 177,168 on one real
transcript). Usage is deduped on `requestId`.

**Subagent tokens.** Work done by the Agent tool is written to separate
transcripts under `<session-id>/subagents/` and never appears in the main
transcript. Ignoring them undercounted one real session by 15.7%. The reporter
folds those files in and counts them as `sidechain_requests`.

**Lost sessions.** `SessionEnd` doesn't fire if the terminal is killed. Reports
are cumulative and upserted by `session_id`, and one is sent every turn (subject
to `flushIntervalSec`), so a crashed session still lands with everything up to
its last turn. Sessions with no final report show as `live` on the dashboard.
If the server is unreachable, reports spool to `~/.cache/claude-usage-tracker/spool/`
and are retried on the next hook.

Cost of running it: the reporter re-reads only the bytes appended since the last
run (byte offsets per file), so a long session doesn't re-parse a 30 MB
transcript every turn. It consumes zero Claude tokens — the session summary is
built from the title Claude Code already writes, plus the tool and file counts.

## The cost column

`Est. cost` converts tokens at Anthropic's public per-model API list prices
(`server/pricing.json`). **Developers on Claude Max/Pro seats are not billed
these amounts.** Treat it as one comparable number for how much work a session
did, which raw token counts don't give you when sessions mix models. Update
`pricing.json` when prices change; cache-write defaults to 1.25× input and
cache-read to 0.10× input unless a model overrides them.

## Deploying the server

Deployed at `deploy@REDACTED_IP` (`REDACTED`), listening on
**127.0.0.1:4317** — not reachable from the internet until an nginx vhost is
added (see below).

Layout on the server:

```
~/inhouse-plugin/          checkout of this repo
~/inhouse-plugin/server/.env   secrets, 0600, generated on the box
~/REDACTED/         usage.sqlite lives here, outside the checkout
~/.config/systemd/user/inhouse-plugin.service
```

The service runs as a **systemd user unit** because the deploy account has no
root:

```bash
systemctl --user status inhouse-plugin
systemctl --user restart inhouse-plugin
journalctl --user -u inhouse-plugin -f
```

### Auto-deploy

Pushing to `main` with changes under `server/` or `deploy/` runs
`.github/workflows/deploy.yml`, which SSHes in and pipes `deploy/server-deploy.sh`
to the box. That script pulls, runs `npm ci`, restarts the unit, then polls
`/api/health` for 20s — **and rolls back to the previous commit if the health
check fails.**

Three repository secrets are required (Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | `REDACTED_IP` |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_SSH_KEY` | private key, read it with the command below |

```bash
ssh devflow-server 'cat ~/.ssh/github-actions-deploy'
```

That key is dedicated to CI and already authorized on the box; it grants shell
as `deploy`, so treat it as a production credential.

### Two things still need root

The deploy account's sudo is limited to a single unrelated command, so these
were left for someone with root:

```bash
# 1. survive a reboot (without this the service stops when the user session ends)
sudo loginctl enable-linger deploy

# 2. TLS + a hostname, so developers can actually reach it
#    (see server/deploy/nginx.conf.example; proxy_pass http://127.0.0.1:4317)
sudo certbot --nginx -d REDACTED
```

**Until step 2 the server is unreachable from anywhere but the box itself.**
The host sets `AllowTcpForwarding no`, so an SSH tunnel does *not* work — check
it from a shell on the server instead:

```bash
ssh devflow-server
curl -s localhost:4317/api/health
curl -s -u "usage:$(grep ^DASHBOARD_PASS= ~/inhouse-plugin/server/.env | cut -d= -f2)" \
     localhost:4317/api/overview
```

Nothing can report to it until it has a hostname, so do step 2 before enrolling
anyone. Reports spool client-side and retry, so enrolling early is not
destructive — developers' sessions simply queue until the endpoint answers.

## Exposing this safely

Publishing the code does not expose your server: the repo contains no endpoint
URL and no token. What it does mean is that anyone can read exactly how the API
works — which only matters once they know where it lives.

Built-in protections:

| | |
|---|---|
| `POST /api/ingest` | Bearer token, constant-time compare. Rate limited **before** auth, and the JSON body is parsed **after** auth and capped at 256 KB — an unauthenticated flood is rejected without the server parsing anything. |
| Read APIs + dashboard | HTTP basic auth, rate limited. |
| `GET /api/health` | Open, but does zero database work, so it can't be used as a free query amplifier. The row count lives at `/api/stats`, behind auth. |
| `TRUST_PROXY` | Defaults to 1 hop. Never set it to `true` — that trusts any `X-Forwarded-For` and lets a caller spoof their IP past the limiter. |

The in-process limiter is a first line, not a shield. A single Node process on
SQLite will not survive a distributed flood, and nothing in application code
can. If this is reachable from the open internet, put something in front of it:

1. **Don't expose it at all** — bind to a VPN/Tailscale address, or IP-allowlist
   your offices in nginx. Strongest option, and usually sufficient for an
   internal tool. Reports spool on the client and retry, so developers off the
   VPN lose nothing; their sessions land when they reconnect.
2. **Cloudflare (free tier) or your WAF** in front, with the origin locked to
   Cloudflare IPs.
3. **nginx `limit_req`** as a second layer, since it sheds load before Node.

Keep `INGEST_TOKEN` long and random (`openssl rand -hex 32`), rotate it by
updating the pushed settings, and remember the token is distributed to every
developer machine — it authenticates *the fleet*, not individuals, so treat a
leak as "rotate", not "breach".

## API

| Method | Path | Auth | |
|---|---|---|---|
| POST | `/api/ingest` | `Bearer INGEST_TOKEN` | a session report |
| GET | `/api/overview?from=&to=` | basic | cards, developer×account rollup, per-day and per-model series |
| GET | `/api/sessions?from=&to=&developer=&project=&q=` | basic | filtered session list |
| GET | `/api/sessions/:id` | basic | one session + per-model and tool breakdown |
| GET | `/api/health` | none | liveness |

## Turning it off

```bash
# one developer, keep the plugin installed
#   set "enabled": false in ~/.config/claude-usage-tracker/config.json
claude plugin uninstall inhouse-plugin@inhouse-plugin    # remove entirely
```

## A note on consent

This records what people are working on — prompts and session titles included —
and ships it to a server. On company accounts that is ordinary telemetry, but
tell the team it is on before you roll it out. `redactContent: true` gives you
tokens and session counts with no free text, if that is the trade you want.
