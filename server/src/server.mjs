/**
 * Claude Usage Tracker - ingest API + dashboard.
 *
 *   POST /api/ingest        session reports from the plugin (Bearer token)
 *   GET  /api/overview      cards, developer x account rollup, per-day series
 *   GET  /api/sessions      filtered session list
 *   GET  /api/sessions/:id  one session with per-model + tool breakdown
 *   GET  /api/filters       developers and accounts available in a date range
 *   POST /api/transcripts/:session/:file   one chunk of a gzipped transcript (Bearer token)
 *   GET  /api/transcripts/:session         transcript files stored for a session
 *   GET  /api/transcripts/:session/:file   download one (gzip)
 *   GET  /api/spend         this month's estimated Cloudflare spend against the cap
 *   GET  /                  dashboard
 */

import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { openDb, makeStore } from './db.mjs';
import { loadPricing } from './pricing.mjs';
import { makeStorage } from './storage.mjs';
import { makeBudget } from './budget.mjs';

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
const storage = makeStorage();
const budget = makeBudget(db);

// Transcripts arrive in chunks small enough for the proxy's body limit and are
// reassembled here before one PUT to R2. Kept beside the database, outside the
// checkout, so a deploy never wipes an upload in progress.
const TRANSCRIPT_TMP = process.env.TRANSCRIPT_TMP_DIR || path.join(path.dirname(DB_FILE), 'upload-tmp');
const TRANSCRIPT_RETENTION_DAYS = Number(process.env.TRANSCRIPT_RETENTION_DAYS ?? 90);
const MAX_TRANSCRIPT_BYTES = Number(process.env.MAX_TRANSCRIPT_MB || 200) * 1024 * 1024;
const CHUNK_LIMIT = '1536kb';

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

/** Values of a repeatable or comma-separated query param, e.g. ?developer=a,b&developer=c. */
function listParam(v) {
  const raw = Array.isArray(v) ? v : (v == null ? [] : [v]);
  return [...new Set(raw.flatMap((x) => String(x).split(','))
    .map((x) => x.trim().toLowerCase()).filter(Boolean))].slice(0, 100);
}

/**
 * The dashboard's filter, as one WHERE clause every read query shares, so that
 * picking developers or accounts changes every number on the page - not just
 * the session list. `a` is the sessions table alias used by the caller.
 */
function sessionFilter(q, a = '') {
  const col = (c) => (a ? `${a}.${c}` : c);
  const { from, to } = range(q);
  const where = [`${col('day')} BETWEEN ? AND ?`];
  const args = [from, to];
  const devs = listParam(q.developer);
  const accts = listParam(q.account);
  if (devs.length) { where.push(`${col('developer_email')} IN (${devs.map(() => '?').join(',')})`); args.push(...devs); }
  if (accts.length) { where.push(`${col('account_email')} IN (${accts.map(() => '?').join(',')})`); args.push(...accts); }
  return { from, to, sql: where.join(' AND '), args, devs, accts };
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
  const f = sessionFilter(req.query);
  const fs = sessionFilter(req.query, 's');

  const totals = db.prepare(
    `SELECT ${SUMMARY_COLS},
            COUNT(DISTINCT developer_email) AS developers,
            COUNT(DISTINCT account_email)   AS accounts
       FROM sessions WHERE ${f.sql}`).get(...f.args);

  // The core question: who is on which Claude account, and how much did they use.
  const byDeveloper = db.prepare(
    `SELECT developer_email, developer_name, account_email, account_display_name,
            MIN(identity_source) AS identity_source,
            COUNT(DISTINCT machine_id) AS machines,
            COUNT(DISTINCT day)        AS active_days,
            MAX(last_activity_at)      AS last_seen,
            ${SUMMARY_COLS}
       FROM sessions WHERE ${f.sql}
      GROUP BY developer_email, account_email
      ORDER BY total_tokens DESC`).all(...f.args);

  const byDay = db.prepare(
    `SELECT day, developer_email, COUNT(*) AS sessions,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(cost_usd), 0)     AS cost_usd
       FROM sessions WHERE ${f.sql}
      GROUP BY day, developer_email ORDER BY day`).all(...f.args);

  const byModel = db.prepare(
    `SELECT m.model,
            SUM(m.requests) AS requests,
            SUM(m.input_tokens + m.output_tokens + m.cache_creation_tokens + m.cache_read_tokens) AS total_tokens,
            SUM(m.cost_usd) AS cost_usd
       FROM session_models m JOIN sessions s ON s.session_id = m.session_id
      WHERE ${fs.sql}
      GROUP BY m.model
     -- Name the aggregate explicitly: the sessions table also has a
     -- total_tokens column, and a bare alias here binds to that instead.
     HAVING SUM(m.input_tokens + m.output_tokens + m.cache_creation_tokens + m.cache_read_tokens) > 0
      ORDER BY total_tokens DESC`).all(...fs.args);

  const byProject = db.prepare(
    `SELECT project_name, COUNT(*) AS sessions,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(cost_usd), 0)     AS cost_usd
       FROM sessions WHERE ${f.sql} AND project_name != ''
      GROUP BY project_name ORDER BY total_tokens DESC LIMIT 12`).all(...f.args);

  res.json({
    range: { from: f.from, to: f.to, tz: TZ },
    filter: { developers: f.devs, accounts: f.accts },
    totals, byDeveloper, byDay, byModel, byProject,
  });
});

/**
 * Everything the filter dropdowns can offer for the date range, ignoring the
 * developer/account selection itself - otherwise picking one developer would
 * shrink the list to that developer and you could never add a second.
 */
app.get(`${BASE_PATH}/api/filters`, readLimiter, requireDashboardAuth, (req, res) => {
  const { from, to } = range(req.query);
  const developers = db.prepare(
    `SELECT developer_email AS value, MAX(developer_name) AS label, COUNT(*) AS sessions
       FROM sessions WHERE day BETWEEN ? AND ? AND developer_email != ''
      GROUP BY developer_email ORDER BY label COLLATE NOCASE`).all(from, to);
  const accounts = db.prepare(
    `SELECT account_email AS value, MAX(account_display_name) AS label, COUNT(*) AS sessions
       FROM sessions WHERE day BETWEEN ? AND ? AND account_email != ''
      GROUP BY account_email ORDER BY account_email COLLATE NOCASE`).all(from, to);
  res.json({ range: { from, to }, developers, accounts });
});

app.get(`${BASE_PATH}/api/sessions`, readLimiter, requireDashboardAuth, (req, res) => {
  const f = sessionFilter(req.query);
  const { from, to } = f;
  const where = [f.sql];
  const args = [...f.args];

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
            total_tokens, cost_usd, is_final, end_reason, report_count,
            -- The model that did most of the work, by cost, plus how many
            -- others the session also touched.
            (SELECT m.model FROM session_models m WHERE m.session_id = sessions.session_id
               AND (m.input_tokens + m.output_tokens + m.cache_creation_tokens + m.cache_read_tokens) > 0
             ORDER BY m.cost_usd DESC, m.requests DESC LIMIT 1) AS primary_model,
            (SELECT COUNT(*) FROM session_models m WHERE m.session_id = sessions.session_id
               AND (m.input_tokens + m.output_tokens + m.cache_creation_tokens + m.cache_read_tokens) > 0) AS model_count
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

/* ------------------------------------------------------------ transcripts */

const SID_RE = /^[A-Za-z0-9-]{1,100}$/;
const FILE_RE = /^(main|agent-[A-Za-z0-9_-]{1,80})\.jsonl$/;

/**
 * Receives one chunk of a gzipped transcript file. The client sends
 * ?part=N&parts=M&sha256=<hex of the whole .gz>&raw=<uncompressed bytes>.
 * When the last missing part arrives the file is reassembled, its hash checked,
 * and it is written to R2 in one PUT.
 */
app.post(`${BASE_PATH}/api/transcripts/:sid/:file`, ingestLimiter, requireIngestAuth,
  express.raw({ type: () => true, limit: CHUNK_LIMIT }), async (req, res) => {
  if (!storage.enabled) return res.status(503).json({ error: 'transcript storage is not configured' });

  const { sid, file } = req.params;
  const part = int(req.query.part), parts = int(req.query.parts);
  const sha = String(req.query.sha256 || '').toLowerCase();
  const raw = int(req.query.raw);
  if (!SID_RE.test(sid) || !FILE_RE.test(file)) return res.status(400).json({ error: 'bad session or file name' });
  if (!(parts >= 1 && parts <= 1000 && part < parts) || !/^[0-9a-f]{64}$/.test(sha)) {
    return res.status(400).json({ error: 'part, parts and sha256 are required' });
  }
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: 'empty chunk' });

  // Already stored with this exact content: nothing to do (idempotent retries).
  const existing = db.prepare('SELECT sha256 FROM transcripts WHERE session_id = ? AND file = ? AND deleted_at = \'\'').get(sid, file);
  if (existing?.sha256 === sha) return res.json({ ok: true, complete: true, unchanged: true });

  // One directory per upload attempt, keyed by content hash, so two different
  // versions of the same file can never interleave their chunks.
  const dir = path.join(TRANSCRIPT_TMP, sid, `${file}.${sha}`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${part}.part`), req.body);

    // Tell the client exactly which parts are still needed, so a client that
    // resumed after this server discarded or never got earlier parts can fill
    // the gaps instead of assuming they are here.
    const missing = [];
    for (let i = 0; i < parts; i++) if (!fs.existsSync(path.join(dir, `${i}.part`))) missing.push(i);
    if (missing.length) return res.json({ ok: true, complete: false, parts, missing: missing.slice(0, 50) });

    const chunks = [];
    for (let i = 0; i < parts; i++) chunks.push(fs.readFileSync(path.join(dir, `${i}.part`)));
    const gz = Buffer.concat(chunks);
    if (gz.length > MAX_TRANSCRIPT_BYTES) {
      fs.rmSync(dir, { recursive: true, force: true });
      return res.status(413).json({ error: 'transcript too large' });
    }
    const got = crypto.createHash('sha256').update(gz).digest('hex');
    if (got !== sha) {
      fs.rmSync(dir, { recursive: true, force: true });
      return res.status(422).json({ error: 'checksum mismatch; resend the file' });
    }

    const est = budget.est.r2Write(1) + budget.est.r2Storage(gz.length);
    if (!budget.allow(est)) {
      // Parts are kept so the upload can finish next month without resending;
      // the sweep removes them if nobody comes back within a day.
      return res.status(402).json({ error: 'monthly Cloudflare spend cap reached', spend: budget.spent() });
    }

    const s = db.prepare('SELECT developer_email, day FROM sessions WHERE session_id = ?').get(sid);
    const who = (s?.developer_email || 'unknown').replace(/[^A-Za-z0-9@._-]/g, '_');
    const day = s?.day || new Date().toISOString().slice(0, 10);
    const key = `${who}/${day}/${sid}/${file}.gz`;

    await storage.put(key, gz);
    budget.record('r2_write', 1, budget.est.r2Write(1));
    db.prepare(`
      INSERT INTO transcripts (session_id, file, r2_key, gz_bytes, raw_bytes, sha256, uploaded_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, '')
      ON CONFLICT(session_id, file) DO UPDATE SET
        r2_key = excluded.r2_key, gz_bytes = excluded.gz_bytes, raw_bytes = excluded.raw_bytes,
        sha256 = excluded.sha256, uploaded_at = excluded.uploaded_at, deleted_at = ''`)
      .run(sid, file, key, gz.length, raw, sha, new Date().toISOString());
    fs.rmSync(dir, { recursive: true, force: true });
    res.json({ ok: true, complete: true, bytes: gz.length });
  } catch (e) {
    console.error('[transcripts] upload failed', e.message);
    res.status(502).json({ error: 'upload failed; retry later' });
  }
});

app.get(`${BASE_PATH}/api/transcripts/:sid`, readLimiter, requireDashboardAuth, (req, res) => {
  const files = db.prepare(
    `SELECT file, gz_bytes, raw_bytes, uploaded_at, deleted_at FROM transcripts
      WHERE session_id = ? ORDER BY file = 'main.jsonl' DESC, file`).all(req.params.sid);
  res.json({ enabled: storage.enabled, retention_days: TRANSCRIPT_RETENTION_DAYS, files });
});

app.get(`${BASE_PATH}/api/transcripts/:sid/:file`, readLimiter, requireDashboardAuth, async (req, res) => {
  const t = db.prepare(
    "SELECT r2_key FROM transcripts WHERE session_id = ? AND file = ? AND deleted_at = ''")
    .get(req.params.sid, req.params.file);
  if (!t) return res.status(404).json({ error: 'not stored' });
  if (!storage.enabled) return res.status(503).json({ error: 'transcript storage is not configured' });
  if (!budget.allow(budget.est.r2Read(1))) return res.status(402).json({ error: 'monthly Cloudflare spend cap reached' });
  try {
    const r = await storage.get(t.r2_key);
    budget.record('r2_read', 1, budget.est.r2Read(1));
    res.set('content-type', 'application/gzip');
    res.set('content-disposition', `attachment; filename="${req.params.sid}-${req.params.file}.gz"`);
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error('[transcripts] download failed', e.message);
    res.status(502).json({ error: 'download failed' });
  }
});

app.get(`${BASE_PATH}/api/spend`, readLimiter, requireDashboardAuth, (_req, res) => {
  res.json({ ...budget.spent(), transcripts_enabled: storage.enabled });
});

/** Retention: remove transcripts older than the window, and abandoned partial uploads. */
async function sweepTranscripts() {
  try {
    if (storage.enabled && TRANSCRIPT_RETENTION_DAYS > 0) {
      const cutoff = new Date(Date.now() - TRANSCRIPT_RETENTION_DAYS * 86400_000).toISOString();
      const old = db.prepare("SELECT session_id, file, r2_key FROM transcripts WHERE deleted_at = '' AND uploaded_at < ?").all(cutoff);
      for (const t of old) {
        await storage.del(t.r2_key); // R2 deletes are free, so nothing is booked
        db.prepare('UPDATE transcripts SET deleted_at = ? WHERE session_id = ? AND file = ?')
          .run(new Date().toISOString(), t.session_id, t.file);
      }
      if (old.length) console.log(`[transcripts] retention removed ${old.length} file(s) older than ${TRANSCRIPT_RETENTION_DAYS}d`);
    }
    if (fs.existsSync(TRANSCRIPT_TMP)) {
      const stale = Date.now() - 86400_000;
      for (const sid of fs.readdirSync(TRANSCRIPT_TMP)) {
        const d = path.join(TRANSCRIPT_TMP, sid);
        if (fs.statSync(d).mtimeMs < stale) fs.rmSync(d, { recursive: true, force: true });
      }
    }
  } catch (e) {
    console.error('[transcripts] sweep failed', e.message);
  }
}
setTimeout(sweepTranscripts, 60_000).unref();
setInterval(sweepTranscripts, 6 * 3600_000).unref();

// Liveness only - deliberately does no database work, so it can't be used as a
// free query amplifier. The row count moved to /api/stats, behind auth.
app.get(`${BASE_PATH}/api/health`, readLimiter, (_req, res) => {
  res.json({ ok: true, commit: COMMIT, started_at: STARTED_AT, pricing_updated: pricing.updated, tz: TZ,
    transcripts: storage.enabled });
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
  console.log(`[usage-tracker] transcripts: ${storage.enabled ? `R2 bucket ${storage.bucket}, keep ${TRANSCRIPT_RETENTION_DAYS}d` : 'disabled (R2_* not set)'}; spend cap $${budget.capUsd}/month`);
  console.log(`[usage-tracker] rate limits: ingest ${INGEST_PER_MIN}/min, read ${READ_PER_MIN}/min per IP; trust proxy=${TRUST_PROXY}`);
});
