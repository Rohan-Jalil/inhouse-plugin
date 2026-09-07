/**
 * Claude Usage Tracker - ingest API + dashboard.
 *
 *   POST /api/ingest        session reports from the plugin (Bearer token)
 *   GET  /api/overview      cards, developer x account rollup, per-day series
 *   GET  /api/sessions      filtered session list
 *   GET  /api/sessions/:id  one session with per-model + tool breakdown
 *   GET  /                  dashboard
 */

import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb, makeStore } from './db.mjs';
import { loadPricing } from './pricing.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const PORT = Number(process.env.PORT || 4317);
const HOST = process.env.HOST || '127.0.0.1';
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'usage.sqlite');
const INGEST_TOKEN = process.env.INGEST_TOKEN || '';
const DASHBOARD_USER = process.env.DASHBOARD_USER || '';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS || '';
const TZ = process.env.REPORT_TZ || process.env.TZ || 'UTC';
// Path this app is mounted at behind a shared vhost, e.g. "/usage". Empty when
// it owns the whole host. nginx must pass the full URI (proxy_pass without a
// trailing slash) so links and the session cookie stay scoped to this prefix.
const BASE_PATH = (process.env.BASE_PATH || '').replace(/\/+$/, '');
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
// Signing key for session cookies. Derived from the password so sessions
// survive restarts and are invalidated when the password is rotated.
const SESSION_SECRET = process.env.DASHBOARD_SECRET
  || crypto.createHash('sha256').update(`session:${DASHBOARD_USER}:${DASHBOARD_PASS}`).digest('hex');
const COOKIE = 'usage_session';

const db = openDb(DB_FILE);
const store = makeStore(db);
const pricing = loadPricing(path.join(ROOT, 'pricing.json'));

/** Commit currently running, so a deploy can be verified from outside the box. */
const COMMIT = (() => {
  if (process.env.COMMIT_SHA) return process.env.COMMIT_SHA.slice(0, 12);
  try {
    return execFileSync('git', ['-C', ROOT, 'rev-parse', '--short=12', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();
  } catch { return 'unknown'; }
})();

/** Process start time, so a restart is visible without reading the journal. */
const STARTED_AT = new Date().toISOString();

const TRUST_PROXY = process.env.TRUST_PROXY ?? '1';
const INGEST_PER_MIN = Number(process.env.RATE_LIMIT_INGEST_PER_MIN || 600);
const READ_PER_MIN = Number(process.env.RATE_LIMIT_READ_PER_MIN || 240);

const app = express();
app.disable('x-powered-by');
// Number of proxy hops to trust for the client IP. Trusting *every* hop would
// let a caller spoof X-Forwarded-For and walk straight past the rate limiter.
app.set('trust proxy', /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);
// NOTE: no global body parser. JSON is parsed per-route, *after* auth, so an
// unauthenticated flood is rejected before the server parses anything.

/* ---------------------------------------------------------------- helpers */

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
/** YYYY-MM-DD in the reporting timezone. */
const toDay = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : dayFmt.format(d);
};

const int = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.trunc(Number(v))) : 0);
const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * Fixed-window per-IP rate limit. In-process and dependency-free: this is a
 * cheap first line that keeps a flood from reaching auth, JSON parsing or
 * SQLite. It is not a substitute for a real edge (see README) - a distributed
 * flood needs Cloudflare, an IP allowlist, or a VPN.
 */
function rateLimit({ perMin, name }) {
  const windowMs = 60_000;
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    // Bound memory: drop the whole table once a window's worth of IPs is stale.
    if (hits.size > 10_000) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
      if (hits.size > 10_000) hits.clear();
    }
    const ip = req.ip || 'unknown';
    let e = hits.get(ip);
    if (!e || e.resetAt <= now) { e = { count: 0, resetAt: now + windowMs }; hits.set(ip, e); }
    e.count += 1;
    if (e.count > perMin) {
      const retry = Math.ceil((e.resetAt - now) / 1000);
      res.set('Retry-After', String(retry));
      return res.status(429).json({ error: 'rate limited', retry_after: retry });
    }
    res.set('RateLimit-Remaining', String(Math.max(0, perMin - e.count)));
    next();
  };
}

const ingestLimiter = rateLimit({ perMin: INGEST_PER_MIN, name: 'ingest' });
const readLimiter = rateLimit({ perMin: READ_PER_MIN, name: 'read' });

/** Constant-time compare so a token can't be recovered by timing the endpoint. */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function requireIngestAuth(req, res, next) {
  if (!INGEST_TOKEN) return next(); // unauthenticated mode (local testing only)
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !safeEqual(token, INGEST_TOKEN)) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

/** Stateless session token: "<expiry ms>.<hmac>". No server-side store needed. */
function issueSession() {
  const exp = String(Date.now() + SESSION_HOURS * 3600_000);
  return `${exp}.${sign(exp)}`;
}

function validSession(token) {
  if (typeof token !== 'string') return false;
  const i = token.lastIndexOf('.');
  if (i < 1) return false;
  const exp = token.slice(0, i);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return safeEqual(token.slice(i + 1), sign(exp));
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

const loginPath = () => `${BASE_PATH}/login`;

function setSessionCookie(req, res, token, maxAgeSec) {
  const secure = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https';
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: BASE_PATH || '/',
    maxAge: maxAgeSec * 1000,
  });
}

function requireDashboardAuth(req, res, next) {
  if (!DASHBOARD_USER) return next();

  if (validSession(readCookie(req, COOKIE))) return next();

  // Basic auth stays supported so curl and scripts keep working.
  const header = req.get('authorization') || '';
  if (header.startsWith('Basic ')) {
    const [u, p] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
    if (u === DASHBOARD_USER && safeEqual(p ?? '', DASHBOARD_PASS)) return next();
  }

  // A browser gets the login page; an API client gets JSON it can act on.
  const wantsHtml = (req.get('accept') || '').includes('text/html');
  if (wantsHtml) {
    const back = encodeURIComponent(req.originalUrl || BASE_PATH || '/');
    return res.redirect(302, `${loginPath()}?next=${back}`);
  }
  return res.status(401).json({ error: 'unauthorized' });
}

/** Default window: the last 14 days, inclusive. */
function range(q) {
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.to || '') ? q.to : dayFmt.format(new Date());
  let from = /^\d{4}-\d{2}-\d{2}$/.test(q.from || '') ? q.from : null;
  if (!from) {
    const d = new Date(`${to}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 13);
    from = d.toISOString().slice(0, 10);
  }
  return { from, to };
}


/* ------------------------------------------------------------------- login */

const loginLimiter = rateLimit({ perMin: 20, name: 'login' });

function loginPage(error, next) {
  const action = loginPath();
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Claude Code usage</title>
<style>
:root { color-scheme: light; --surface-0:#f4f4f1; --surface-1:#fcfcfb; --border:#e3e2dd;
  --border-strong:#d2d1ca; --text-primary:#0b0b0b; --text-secondary:#52514e; --text-muted:#7c7b73;
  --accent:#2a78d6; --critical:#d03b3b; }
@media (prefers-color-scheme: dark) { :root:where(:not([data-theme="light"])) {
  color-scheme: dark; --surface-0:#101010; --surface-1:#1a1a19; --border:#302f2c;
  --border-strong:#45443f; --text-primary:#fff; --text-secondary:#c3c2b7; --text-muted:#8f8e85;
  --accent:#3987e5; --critical:#e66767; } }
*{box-sizing:border-box} body{margin:0;min-height:100vh;display:grid;place-items:center;
  background:var(--surface-0);color:var(--text-primary);
  font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.card{background:var(--surface-1);border:1px solid var(--border);border-radius:12px;
  padding:28px;width:min(360px,calc(100vw - 32px))}
h1{font-size:17px;font-weight:640;margin:0 0 4px;letter-spacing:-.01em}
p.sub{margin:0 0 20px;color:var(--text-muted);font-size:12.5px}
label{display:block;font-size:12px;color:var(--text-secondary);margin:0 0 5px}
input{width:100%;font:inherit;padding:9px 11px;border-radius:8px;background:var(--surface-0);
  border:1px solid var(--border-strong);color:var(--text-primary);margin-bottom:14px}
input:focus{outline:2px solid var(--accent);outline-offset:-1px}
button{width:100%;font:inherit;font-weight:560;padding:10px;border:0;border-radius:8px;
  background:var(--accent);color:#fff;cursor:pointer}
button:hover{filter:brightness(1.07)}
.err{background:color-mix(in srgb,var(--critical) 12%,transparent);border:1px solid var(--critical);
  color:var(--critical);border-radius:8px;padding:8px 11px;font-size:12.5px;margin-bottom:14px}
</style></head><body>
<form class="card" method="post" action="${action}">
  <h1>Claude Code usage</h1>
  <p class="sub">Sign in to view team usage.</p>
  ${error ? `<div class="err">${error}</div>` : ''}
  <input type="hidden" name="next" value="${next || ''}">
  <label for="u">Username</label>
  <input id="u" name="username" autocomplete="username" autofocus required>
  <label for="p">Password</label>
  <input id="p" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
</form></body></html>`;
}

/** Only allow redirects back into this app, never to an attacker's URL. */
function safeNext(next) {
  const fallback = `${BASE_PATH}/`;
  if (typeof next !== 'string' || !next.startsWith('/') || next.startsWith('//')) return fallback;
  if (BASE_PATH && !next.startsWith(`${BASE_PATH}/`) && next !== BASE_PATH) return fallback;
  return next;
}

app.get(`${BASE_PATH}/login`, loginLimiter, (req, res) => {
  if (!DASHBOARD_USER || validSession(readCookie(req, COOKIE))) {
    return res.redirect(302, safeNext(req.query.next));
  }
  res.type('html').send(loginPage(null, escapeAttr(req.query.next)));
});

app.post(`${BASE_PATH}/login`, loginLimiter, express.urlencoded({ extended: false, limit: '8kb' }),
  (req, res) => {
    const { username = '', password = '', next } = req.body || {};
    const ok = username === DASHBOARD_USER && safeEqual(password, DASHBOARD_PASS);
    if (!ok) {
      // Same wording either way - don't reveal which field was wrong.
      return res.status(401).type('html').send(loginPage('Incorrect username or password.', escapeAttr(next)));
    }
    setSessionCookie(req, res, issueSession(), SESSION_HOURS * 3600);
    res.redirect(302, safeNext(next));
  });

app.post(`${BASE_PATH}/logout`, (req, res) => {
  setSessionCookie(req, res, '', 0);
  res.redirect(302, loginPath());
});

const escapeAttr = (v) => String(v ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ----------------------------------------------------------------- ingest */

app.post(`${BASE_PATH}/api/ingest`, ingestLimiter, requireIngestAuth,
  express.json({ limit: '256kb' }), (req, res) => {
  const b = req.body;
  if (!b || typeof b !== 'object' || !b.session_id) {
    return res.status(400).json({ error: 'session_id required' });
  }

  const usage = b.usage?.total || {};
  const byModel = b.usage?.by_model || {};
  const startedAt = str(b.timing?.started_at, 40) || new Date().toISOString();
  const lastAt = str(b.timing?.last_activity_at, 40) || startedAt;

  const models = Object.entries(byModel).map(([model, u]) => ({
    model: str(model, 120),
    requests: int(u.requests),
    input_tokens: int(u.input_tokens),
    output_tokens: int(u.output_tokens),
    cache_creation_tokens: int(u.cache_creation_tokens),
    cache_read_tokens: int(u.cache_read_tokens),
    thinking_tokens: int(u.thinking_tokens),
    cost_usd: 0,
  }));
  for (const m of models) m.cost_usd = pricing.costOf(m.model, m);

  const durationSec = Math.max(0,
    Math.round((new Date(lastAt).getTime() - new Date(startedAt).getTime()) / 1000) || 0);

  const row = {
    session_id: str(b.session_id, 100),
    developer_name: str(b.developer?.name, 200),
    developer_email: str(b.developer?.email, 200).toLowerCase(),
    identity_source: str(b.developer?.source, 30),
    machine_id: str(b.machine?.machine_id, 100),
    hostname: str(b.machine?.hostname, 200),
    os_user: str(b.machine?.os_user, 100),
    platform: str(b.machine?.platform, 60),
    cc_version: str(b.machine?.cc_version, 40),

    account_email: str(b.claude_account?.email, 200).toLowerCase(),
    account_uuid: str(b.claude_account?.uuid, 100),
    account_display_name: str(b.claude_account?.display_name, 200),
    account_org: str(b.claude_account?.org, 300),
    account_org_type: str(b.claude_account?.org_type, 60),

    project_name: str(b.project?.name, 200),
    project_cwd: str(b.project?.cwd, 500),
    git_branch: str(b.project?.git_branch, 200),

    started_at: startedAt,
    last_activity_at: lastAt,
    day: toDay(startedAt),
    duration_sec: durationSec,

    headline: str(b.summary?.headline, 500),
    title: str(b.summary?.title, 300),
    first_prompt: str(b.summary?.first_prompt, 1000),
    last_assistant: str(b.summary?.last_assistant, 500),

    turns: int(b.activity?.turns),
    user_messages: int(b.activity?.user_messages),
    sidechain_requests: int(b.activity?.sidechain_requests),
    tool_calls: int(b.activity?.tool_calls),
    tools_json: JSON.stringify(b.activity?.tools || {}).slice(0, 8000),
    files_json: JSON.stringify(b.activity?.files_touched || []).slice(0, 8000),

    requests: int(usage.requests),
    input_tokens: int(usage.input_tokens),
    output_tokens: int(usage.output_tokens),
    cache_creation_tokens: int(usage.cache_creation_tokens),
    cache_read_tokens: int(usage.cache_read_tokens),
    thinking_tokens: int(usage.thinking_tokens),
    total_tokens: 0,
    cost_usd: models.reduce((a, m) => a + m.cost_usd, 0),

    is_final: b.is_final ? 1 : 0,
    end_reason: str(b.end_reason, 60),
    last_seen_at: new Date().toISOString(),
  };
  row.total_tokens = row.input_tokens + row.output_tokens
    + row.cache_creation_tokens + row.cache_read_tokens;

  try {
    store.save(row, models);
  } catch (e) {
    console.error('[ingest] save failed', e.message);
    return res.status(500).json({ error: 'save failed' });
  }
  res.json({ ok: true, session_id: row.session_id });
});

/* --------------------------------------------------------------- read API */

const SUMMARY_COLS = `
  COUNT(*)                    AS sessions,
  COALESCE(SUM(total_tokens), 0)   AS total_tokens,
  COALESCE(SUM(input_tokens), 0)   AS input_tokens,
  COALESCE(SUM(output_tokens), 0)  AS output_tokens,
  COALESCE(SUM(cache_creation_tokens), 0) AS cache_creation_tokens,
  COALESCE(SUM(cache_read_tokens), 0)     AS cache_read_tokens,
  COALESCE(SUM(cost_usd), 0)       AS cost_usd,
  COALESCE(SUM(turns), 0)          AS turns,
  COALESCE(SUM(duration_sec), 0)   AS duration_sec
`;

app.get(`${BASE_PATH}/api/overview`, readLimiter, requireDashboardAuth, (req, res) => {
  const { from, to } = range(req.query);
  const args = [from, to];

  const totals = db.prepare(
    `SELECT ${SUMMARY_COLS},
            COUNT(DISTINCT developer_email) AS developers,
            COUNT(DISTINCT account_email)   AS accounts
       FROM sessions WHERE day BETWEEN ? AND ?`).get(...args);

  // The core question: who is on which Claude account, and how much did they use.
  const byDeveloper = db.prepare(
    `SELECT developer_email, developer_name, account_email, account_display_name,
            MIN(identity_source) AS identity_source,
            COUNT(DISTINCT machine_id) AS machines,
            COUNT(DISTINCT day)        AS active_days,
            MAX(last_activity_at)      AS last_seen,
            ${SUMMARY_COLS}
       FROM sessions WHERE day BETWEEN ? AND ?
      GROUP BY developer_email, account_email
      ORDER BY total_tokens DESC`).all(...args);

  const byDay = db.prepare(
    `SELECT day, developer_email, COUNT(*) AS sessions,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(cost_usd), 0)     AS cost_usd
       FROM sessions WHERE day BETWEEN ? AND ?
      GROUP BY day, developer_email ORDER BY day`).all(...args);

  const byModel = db.prepare(
    `SELECT m.model,
            SUM(m.requests) AS requests,
            SUM(m.input_tokens + m.output_tokens + m.cache_creation_tokens + m.cache_read_tokens) AS total_tokens,
            SUM(m.cost_usd) AS cost_usd
       FROM session_models m JOIN sessions s ON s.session_id = m.session_id
      WHERE s.day BETWEEN ? AND ?
      GROUP BY m.model
     -- Name the aggregate explicitly: the sessions table also has a
     -- total_tokens column, and a bare alias here binds to that instead.
     HAVING SUM(m.input_tokens + m.output_tokens + m.cache_creation_tokens + m.cache_read_tokens) > 0
      ORDER BY total_tokens DESC`).all(...args);

  const byProject = db.prepare(
    `SELECT project_name, COUNT(*) AS sessions,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(cost_usd), 0)     AS cost_usd
       FROM sessions WHERE day BETWEEN ? AND ? AND project_name != ''
      GROUP BY project_name ORDER BY total_tokens DESC LIMIT 12`).all(...args);

  res.json({ range: { from, to, tz: TZ }, totals, byDeveloper, byDay, byModel, byProject });
});

app.get(`${BASE_PATH}/api/sessions`, readLimiter, requireDashboardAuth, (req, res) => {
  const { from, to } = range(req.query);
  const where = ['day BETWEEN ? AND ?'];
  const args = [from, to];

  if (req.query.developer) { where.push('developer_email = ?'); args.push(String(req.query.developer).toLowerCase()); }
  if (req.query.account) { where.push('account_email = ?'); args.push(String(req.query.account).toLowerCase()); }
  if (req.query.project) { where.push('project_name = ?'); args.push(String(req.query.project)); }
  if (req.query.q) {
    where.push('(headline LIKE ? OR title LIKE ? OR first_prompt LIKE ? OR project_name LIKE ?)');
    const like = `%${String(req.query.q).slice(0, 100)}%`;
    args.push(like, like, like, like);
  }

  const limit = Math.min(500, Math.max(1, int(req.query.limit) || 100));
  const offset = int(req.query.offset);

  const total = db.prepare(
    `SELECT COUNT(*) AS n FROM sessions WHERE ${where.join(' AND ')}`).get(...args).n;

  const rows = db.prepare(
    `SELECT session_id, developer_name, developer_email, identity_source, account_email, hostname,
            project_name, project_cwd, git_branch, started_at, last_activity_at, day,
            duration_sec, headline, title, turns, tool_calls,
            input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens,
            total_tokens, cost_usd, is_final, end_reason, report_count
       FROM sessions WHERE ${where.join(' AND ')}
      ORDER BY started_at DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);

  res.json({ range: { from, to }, total, limit, offset, sessions: rows });
});

app.get(`${BASE_PATH}/api/sessions/:id`, readLimiter, requireDashboardAuth, (req, res) => {
  const s = db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'not found' });
  const models = db.prepare(
    'SELECT * FROM session_models WHERE session_id = ? ORDER BY cost_usd DESC').all(req.params.id);
  let tools = {}; let files = [];
  try { tools = JSON.parse(s.tools_json); } catch {}
  try { files = JSON.parse(s.files_json); } catch {}
  res.json({ session: s, models, tools, files });
});

// Liveness only - deliberately does no database work, so it can't be used as a
// free query amplifier. The row count moved to /api/stats, behind auth.
app.get(`${BASE_PATH}/api/health`, readLimiter, (_req, res) => {
  res.json({ ok: true, commit: COMMIT, started_at: STARTED_AT, pricing_updated: pricing.updated, tz: TZ });
});

app.get(`${BASE_PATH}/api/stats`, readLimiter, requireDashboardAuth, (_req, res) => {
  res.json({ sessions: db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n });
});

app.use(BASE_PATH || '/', readLimiter, requireDashboardAuth, express.static(path.join(ROOT, 'public')));

app.use((err, _req, res, _next) => {
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'payload too large' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid json' });
  console.error('[usage-tracker]', err?.message);
  res.status(500).json({ error: 'internal error' });
});

app.listen(PORT, HOST, () => {
  console.log(`[usage-tracker] listening on http://${HOST}:${PORT}`);
  console.log(`[usage-tracker] db=${DB_FILE} tz=${TZ} commit=${COMMIT} basePath=${BASE_PATH || '/'}`);
  if (!INGEST_TOKEN) console.warn('[usage-tracker] WARNING: INGEST_TOKEN unset - the ingest endpoint is open');
  if (!DASHBOARD_USER) console.warn('[usage-tracker] WARNING: DASHBOARD_USER unset - the dashboard is open');
  console.log(`[usage-tracker] rate limits: ingest ${INGEST_PER_MIN}/min, read ${READ_PER_MIN}/min per IP; trust proxy=${TRUST_PROXY}`);
});
