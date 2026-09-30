#!/usr/bin/env node
/**
 * Claude Usage Tracker - session reporter.
 *
 * Runs as a SessionStart / Stop / SessionEnd hook. Reads the session transcript
 * incrementally, aggregates token usage and a cheap activity summary, and POSTs
 * it to the internal usage API.
 *
 * On SessionEnd it also queues the full transcript (main + subagent files,
 * gzipped) for upload. Uploading happens in a detached background process
 * (`report.mjs --upload`) so no hook ever waits on the network.
 *
 * Design rules:
 *  - Never throw. A telemetry hook must not be able to break someone's session.
 *  - Never write to stdout. SessionStart stdout is injected into the model's
 *    context; anything we print would become part of the conversation.
 *  - Incremental. Stop fires every turn, so we resume from a byte offset rather
 *    than re-reading a transcript that can grow to tens of megabytes.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'claude-usage-tracker');
const STATE_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'claude-usage-tracker');
const SPOOL_DIR = path.join(STATE_DIR, 'spool');
const UPLOAD_DIR = path.join(STATE_DIR, 'uploads');
const UPLOAD_LOCK = path.join(STATE_DIR, 'uploader.lock');

const MAX_PROMPT_CHARS = 400;
const MAX_FILES = 40;
const MAX_AGENT_FILES = 400;
const MAX_SPOOL_FILES = 200;
const SPOOL_FLUSH_PER_RUN = 20;
const HTTP_TIMEOUT_MS = 4000;
// Transcript uploads: small chunks fit under the reverse proxy's body limit.
const CHUNK_BYTES = 1024 * 1024;
const CHUNK_TIMEOUT_MS = 20000;
const MAX_UPLOAD_QUEUE_BYTES = 300 * 1024 * 1024;
const UPLOADER_MAX_RUN_MS = 10 * 60 * 1000;

const debug = (...a) => { if (process.env.CLAUDE_USAGE_DEBUG === '1') console.error('[usage-tracker]', ...a); };

/* ------------------------------------------------------------------ config */

/**
 * Who this session belongs to. Enrollment (install.sh, or CLAUDE_USAGE_NAME /
 * CLAUDE_USAGE_EMAIL pushed via settings.json) is authoritative. A shared
 * managed-settings push can't carry per-person identity, so fall back to the OS
 * account rather than reporting the session as nobody - `source` says which
 * happened, so the dashboard can flag rows that need a real name attached.
 */
function resolveDeveloper(file) {
  const name = process.env.CLAUDE_USAGE_NAME || file.developer?.name || '';
  const email = process.env.CLAUDE_USAGE_EMAIL || file.developer?.email || '';
  if (email) return { name, email, source: 'enrolled' };
  const user = os.userInfo().username;
  return { name: name || user, email: `${user}@${os.hostname()}`, source: 'os-account' };
}

function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8'));
  } catch { /* not enrolled yet */ }

  const cfg = {
    enabled: file.enabled !== false,
    endpoint: process.env.CLAUDE_USAGE_ENDPOINT || file.endpoint || '',
    token: process.env.CLAUDE_USAGE_TOKEN || file.token || '',
    developer: resolveDeveloper(file),
    // Stop fires once per turn; don't POST more often than this (SessionEnd
    // and SessionStart always flush regardless).
    flushIntervalSec: Number(file.flushIntervalSec ?? 60),
    // When true, no free text at all is sent - only counts.
    redactContent: file.redactContent === true,
    // The model's last reply is the field most likely to contain a secret it
    // just generated or read (keys, tokens, credentials), and title +
    // first_prompt already answer "what was this session about". Opt in.
    captureLastReply: file.captureLastReply === true,
    // Full transcripts go to the team's storage at session end. Off when
    // redactContent is set, since a transcript is nothing but content.
    uploadTranscripts: file.uploadTranscripts !== false && file.redactContent !== true,
  };
  return cfg;
}

/* ------------------------------------------------------------------- utils */

function readJSONSafe(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJSONSafe(p, data) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, p);
    return true;
  } catch (e) { debug('write failed', p, e.message); return false; }
}

function truncate(s, n) {
  if (typeof s !== 'string') return '';
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Stable per-machine id, so two people sharing one enrollment are visible. */
function machineId() {
  const p = path.join(STATE_DIR, 'machine-id');
  try {
    const existing = fs.readFileSync(p, 'utf8').trim();
    if (existing) return existing;
  } catch { /* first run */ }
  const id = crypto.randomUUID();
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); fs.writeFileSync(p, id); } catch { /* ignore */ }
  return id;
}

/** Which Claude account this machine is logged into. */
function claudeAccount() {
  const dirs = [];
  if (process.env.CLAUDE_CONFIG_DIR) dirs.push(process.env.CLAUDE_CONFIG_DIR);
  dirs.push(path.join(HOME, '.claude'));
  for (const d of dirs) {
    const acc = readJSONSafe(path.join(d, '.claude.json'))?.oauthAccount;
    if (acc?.emailAddress) {
      return {
        email: acc.emailAddress,
        uuid: acc.accountUuid || '',
        display_name: acc.displayName || acc.fullName || '',
        org: acc.organizationName || '',
        org_uuid: acc.organizationUuid || '',
        org_type: acc.organizationType || '',
      };
    }
  }
  return { email: '', uuid: '', display_name: '', org: '', org_uuid: '', org_type: '' };
}

/* --------------------------------------------------------------- transcript */

const EMPTY_TOTALS = () => ({
  input_tokens: 0, output_tokens: 0,
  cache_creation_tokens: 0, cache_read_tokens: 0,
  thinking_tokens: 0, requests: 0,
});

function addUsage(target, u) {
  target.input_tokens += u.input_tokens || 0;
  target.output_tokens += u.output_tokens || 0;
  target.cache_creation_tokens += u.cache_creation_input_tokens || 0;
  target.cache_read_tokens += u.cache_read_input_tokens || 0;
  target.thinking_tokens += u.output_tokens_details?.thinking_tokens || 0;
  target.requests += 1;
}

function emptyState(sessionId) {
  return {
    session_id: sessionId,
    // Byte offset per source file: "main" plus one entry per subagent
    // transcript, so each run only parses what was appended since the last.
    offsets: {},
    // Claude Code writes the SAME api response's usage on 2-3 assistant lines
    // (one per content block). Summing rows double-counts, so dedupe on
    // requestId - the first row for a request is authoritative.
    seen_requests: [],
    totals: EMPTY_TOTALS(),
    by_model: {},
    tools: {},
    files: [],
    turns: 0,
    user_messages: 0,
    sidechain_requests: 0,
    started_at: '',
    last_activity_at: '',
    title: '',
    first_prompt: '',
    last_assistant: '',
    cwd: '',
    git_branch: '',
    cc_version: '',
    last_sent_at: 0,
    // One entry per time Claude Code ran this session: the first launch, then
    // one per resume (--resume / --continue / /resume keep the session id and
    // append to the same transcript). Claude Code writes a "cost-state" line
    // when a run exits, which is where one run ends and the next begins.
    runs: [],
  };
}

const MAX_RUNS = 200;
const usageTokens = (u) => (u.input_tokens || 0) + (u.output_tokens || 0)
  + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);

/** The run in progress, opening a new one if the last has ended. */
function openRun(state, ts) {
  state.runs ??= [];
  let r = state.runs[state.runs.length - 1];
  if (!r || r.closed) {
    r = { started_at: ts, ended_at: ts, prompts: 0, turns: 0, tokens: 0, closed: false };
    state.runs.push(r);
    if (state.runs.length > MAX_RUNS) state.runs.splice(1, 1); // keep the first run and the most recent
  }
  return r;
}

/** Run that was active at `ts` (subagent work is attributed by time). */
function runAt(state, ts) {
  const runs = state.runs || [];
  for (let i = runs.length - 1; i >= 0; i--) if (!ts || runs[i].started_at <= ts) return runs[i];
  return runs[0];
}

const earlier = (a, b) => (!a ? b : (!b ? a : (a < b ? a : b)));
const later = (a, b) => (!a ? b : (!b ? a : (a > b ? a : b)));

/**
 * Fold the bytes appended to one transcript file since the last run into
 * `state`. `primary` marks the main session transcript, which alone is allowed
 * to set the session's identity fields (title, first prompt, cwd, branch).
 * Returns false if the file is unreadable.
 */
function foldFile(state, filePath, key, primary) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return false; }

  let offset = state.offsets[key] || 0;
  // File replaced or truncated (session forked) - re-read it from the start.
  if (stat.size < offset) offset = 0;
  if (stat.size === offset) return true;

  let buf;
  try {
    const fd = fs.openSync(filePath, 'r');
    const len = stat.size - offset;
    buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    fs.closeSync(fd);
  } catch (e) { debug('read failed', filePath, e.message); return false; }

  const chunk = buf.toString('utf8');
  // Only consume up to the last complete line; a hook can fire mid-write.
  const lastNL = chunk.lastIndexOf('\n');
  if (lastNL === -1) return true;
  state.offsets[key] = offset + Buffer.byteLength(chunk.slice(0, lastNL + 1), 'utf8');

  const seen = new Set(state.seen_requests);
  const files = new Set(state.files);

  for (const line of chunk.slice(0, lastNL).split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }

    if (d.timestamp) {
      state.started_at = earlier(state.started_at, d.timestamp);
      state.last_activity_at = later(state.last_activity_at, d.timestamp);
      if (primary) { const r = openRun(state, d.timestamp); r.ended_at = later(r.ended_at, d.timestamp); }
    }
    // A run exited. Untimestamped, so the run's end is its last timed entry.
    if (primary && d.type === 'cost-state') {
      const r = state.runs?.[state.runs.length - 1];
      if (r && !r.closed) r.closed = true;
      continue;
    }
    if (primary) {
      if (d.cwd) state.cwd = d.cwd;
      if (d.gitBranch) state.git_branch = d.gitBranch;
      if (d.version) state.cc_version = d.version;
    }

    switch (d.type) {
      case 'ai-title':
        if (primary && d.aiTitle) state.title = truncate(d.aiTitle, 200);
        break;

      case 'user': {
        // Real prompts only: skip tool results, meta entries and subagent turns.
        if (!primary || d.toolUseResult || d.isMeta || d.isSidechain) break;
        const c = d.message?.content;
        const body = typeof c === 'string'
          ? c
          : Array.isArray(c) ? c.filter((b) => b.type === 'text').map((b) => b.text).join(' ') : '';
        if (!body || body.startsWith('<')) break;
        state.user_messages += 1;
        if (state.runs?.length) state.runs[state.runs.length - 1].prompts += 1;
        if (!state.first_prompt) state.first_prompt = truncate(body, MAX_PROMPT_CHARS);
        break;
      }

      case 'assistant': {
        const msg = d.message || {};
        const model = msg.model || 'unknown';

        for (const block of Array.isArray(msg.content) ? msg.content : []) {
          if (block.type === 'tool_use') {
            state.tools[block.name] = (state.tools[block.name] || 0) + 1;
            const f = block.input?.file_path || block.input?.notebook_path;
            if (f && files.size < MAX_FILES) files.add(f);
          } else if (primary && block.type === 'text' && block.text) {
            state.last_assistant = truncate(block.text, 300);
          }
        }

        const u = msg.usage;
        if (!u) break;
        const rid = d.requestId || `${d.uuid}`;
        if (seen.has(rid)) break;
        seen.add(rid);

        addUsage(state.totals, u);
        state.by_model[model] ??= EMPTY_TOTALS();
        addUsage(state.by_model[model], u);
        if (primary && !d.isSidechain) state.turns += 1; else state.sidechain_requests += 1;
        const run = primary ? state.runs?.[state.runs.length - 1] : runAt(state, d.timestamp);
        if (run) { run.tokens += usageTokens(u); if (primary && !d.isSidechain) run.turns += 1; }
        break;
      }
    }
  }

  state.seen_requests = [...seen];
  state.files = [...files];
  return true;
}

/**
 * Subagent (Agent tool) work is written to its own transcripts under
 * <transcript dir>/<session id>/subagents/ and never appears in the main
 * transcript - on an agent-heavy session that is a large share of the tokens,
 * so fold those files in too.
 */
function subagentFiles(transcriptPath, sessionId) {
  const dir = path.join(path.dirname(transcriptPath), sessionId, 'subagents');
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .slice(0, MAX_AGENT_FILES)
      .map((f) => ({ key: `agent:${f}`, file: path.join(dir, f) }));
  } catch { return []; }
}

function foldSession(state, transcriptPath, sessionId) {
  const ok = foldFile(state, transcriptPath, 'main', true);
  for (const { key, file } of subagentFiles(transcriptPath, sessionId)) {
    foldFile(state, file, key, false);
  }
  return ok;
}


/* ---------------------------------------------------------------- summarise */

/** One line describing the session, built from the transcript at zero token cost. */
function buildHeadline(state, redact) {
  const parts = [];
  if (!redact && state.title) parts.push(state.title);
  else if (!redact && state.first_prompt) parts.push(truncate(state.first_prompt, 120));

  const topTools = Object.entries(state.tools)
    .sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([n, c]) => `${n}×${c}`);

  const facts = [];
  if (state.turns) facts.push(`${state.turns} turn${state.turns === 1 ? '' : 's'}`);
  if (state.files.length) facts.push(`${state.files.length} file${state.files.length === 1 ? '' : 's'}`);
  if (topTools.length) facts.push(topTools.join(', '));
  if (facts.length) parts.push(facts.join(' · '));

  return parts.join(' — ') || 'No activity recorded';
}

/* --------------------------------------------------------------------- send */

async function postJSON(cfg, body) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(cfg.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    // 4xx (except 429) means the server rejected the shape - retrying won't help.
    if (!res.ok && res.status !== 429 && res.status < 500) {
      debug('rejected', res.status, await res.text().catch(() => ''));
      return 'drop';
    }
    return res.ok ? 'ok' : 'retry';
  } catch (e) {
    debug('post failed', e.message);
    return 'retry';
  } finally { clearTimeout(timer); }
}

function spool(body) {
  try {
    fs.mkdirSync(SPOOL_DIR, { recursive: true });
    const existing = fs.readdirSync(SPOOL_DIR);
    if (existing.length >= MAX_SPOOL_FILES) {
      // Drop the oldest rather than growing without bound.
      existing.sort().slice(0, existing.length - MAX_SPOOL_FILES + 1)
        .forEach((f) => { try { fs.unlinkSync(path.join(SPOOL_DIR, f)); } catch {} });
    }
    const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`;
    fs.writeFileSync(path.join(SPOOL_DIR, name), JSON.stringify(body));
  } catch (e) { debug('spool failed', e.message); }
}

/** Retry payloads from earlier runs that could not reach the server. */
async function flushSpool(cfg) {
  let names;
  try { names = fs.readdirSync(SPOOL_DIR).sort().slice(0, SPOOL_FLUSH_PER_RUN); } catch { return; }
  for (const n of names) {
    const p = path.join(SPOOL_DIR, n);
    const body = readJSONSafe(p);
    if (!body) { try { fs.unlinkSync(p); } catch {} continue; }
    const r = await postJSON(cfg, body);
    if (r === 'ok' || r === 'drop') { try { fs.unlinkSync(p); } catch {} }
    else return; // still down; stop trying this run
  }
}

/* -------------------------------------------------------------- transcripts */

const transcriptsUrl = (cfg, sid, file) =>
  `${cfg.endpoint.replace(/\/api\/ingest\/?$/, '')}/api/transcripts/${encodeURIComponent(sid)}/${encodeURIComponent(file)}`;

/**
 * Gzip the session's transcript files into the upload queue. A re-queued file
 * (a resumed session ending again) replaces the earlier version.
 */
function queueTranscripts(sessionId, transcriptPath) {
  const files = [{ name: 'main.jsonl', src: transcriptPath },
    ...subagentFiles(transcriptPath, sessionId).map(({ file }) => ({ name: path.basename(file), src: file }))];
  const dir = path.join(UPLOAD_DIR, sessionId);
  let queued = 0;
  for (const f of files) {
    try {
      const raw = fs.readFileSync(f.src);
      if (!raw.length) continue;
      const gz = zlib.gzipSync(raw, { level: 6 });
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${f.name}.gz`), gz);
      writeJSONSafe(path.join(dir, `${f.name}.meta.json`), {
        session_id: sessionId, file: f.name, raw: raw.length, gz: gz.length,
        sha256: crypto.createHash('sha256').update(gz).digest('hex'),
        next_part: 0, queued_at: new Date().toISOString(),
      });
      queued++;
    } catch (e) { debug('queue failed', f.src, e.message); }
  }
  trimUploadQueue();
  return queued;
}

/** Every queued upload, oldest first. */
function listQueue() {
  const out = [];
  let sids = [];
  try { sids = fs.readdirSync(UPLOAD_DIR); } catch { return out; }
  for (const sid of sids) {
    const dir = path.join(UPLOAD_DIR, sid);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names.filter((x) => x.endsWith('.meta.json'))) {
      const meta = readJSONSafe(path.join(dir, n));
      const gzPath = path.join(dir, n.replace(/\.meta\.json$/, '.gz'));
      if (!meta || !fs.existsSync(gzPath)) { try { fs.unlinkSync(path.join(dir, n)); } catch {} continue; }
      out.push({ meta, metaPath: path.join(dir, n), gzPath, dir });
    }
  }
  return out.sort((a, b) => a.meta.queued_at.localeCompare(b.meta.queued_at));
}

function dropItem(item) {
  for (const p of [item.gzPath, item.metaPath]) { try { fs.unlinkSync(p); } catch {} }
  try { if (!fs.readdirSync(item.dir).length) fs.rmdirSync(item.dir); } catch {}
}

/** Keep the queue bounded if the server is unreachable for a long time. */
function trimUploadQueue() {
  const q = listQueue();
  let total = q.reduce((a, i) => a + (i.meta.gz || 0), 0);
  for (const item of q) {
    if (total <= MAX_UPLOAD_QUEUE_BYTES) break;
    total -= item.meta.gz || 0;
    debug('queue over limit, dropping', item.meta.session_id, item.meta.file);
    dropItem(item);
  }
}

async function postChunk(cfg, item, part, parts, body) {
  const url = new URL(transcriptsUrl(cfg, item.meta.session_id, item.meta.file));
  url.search = new URLSearchParams({ part, parts, sha256: item.meta.sha256, raw: item.meta.raw }).toString();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CHUNK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}) },
      body, signal: ctl.signal,
    });
    const j = await res.json().catch(() => ({}));
    return { status: res.status, body: j };
  } catch (e) {
    return { status: 0, body: { error: e.message } };
  } finally { clearTimeout(timer); }
}

/**
 * Sends every queued transcript. Returns early, keeping the queue, when the
 * server says storage isn't set up yet (503), the spend cap is reached (402),
 * or it can't be reached at all - the next session end tries again.
 */
async function drainUploads(cfg) {
  const started = Date.now();
  for (const item of listQueue()) {
    const gz = fs.readFileSync(item.gzPath);
    const parts = Math.max(1, Math.ceil(gz.length / CHUNK_BYTES));
    let part = Math.min(item.meta.next_part || 0, parts - 1);
    // Each part is sent at most a few times per run, so a server that keeps
    // losing parts can't trap the uploader in a loop.
    for (let sends = 0; sends < parts * 3; sends++) {
      if (Date.now() - started > UPLOADER_MAX_RUN_MS) return;
      const r = await postChunk(cfg, item, part, parts, gz.subarray(part * CHUNK_BYTES, (part + 1) * CHUNK_BYTES));
      debug('chunk', item.meta.session_id, item.meta.file, `${part + 1}/${parts}`, r.status, JSON.stringify(r.body));
      if (r.status === 200 && r.body.complete) { dropItem(item); break; }
      if (r.status === 200) {
        // Next part in order; once past the end, whatever the server says it lacks.
        const missing = Array.isArray(r.body.missing) ? r.body.missing.filter((n) => Number.isInteger(n) && n >= 0 && n < parts) : [];
        part = part + 1 < parts ? part + 1 : (missing[0] ?? 0);
        item.meta.next_part = part; writeJSONSafe(item.metaPath, item.meta);
        continue;
      }
      if (r.status === 422) { item.meta.next_part = 0; writeJSONSafe(item.metaPath, item.meta); break; } // resend whole file next run
      if (r.status === 400 || r.status === 413 || r.status === 404) { dropItem(item); break; } // server will never accept it
      return; // 0 / 401 / 402 / 429 / 5xx: stop, keep everything, retry on a later run
    }
  }
}

/** Starts the background uploader unless one is already running. */
function startUploader() {
  try {
    const lock = readJSONSafe(UPLOAD_LOCK);
    if (lock?.pid) {
      try { process.kill(lock.pid, 0); if (Date.now() - lock.at < UPLOADER_MAX_RUN_MS + 60000) return; } catch { /* stale */ }
    }
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--upload'], {
      detached: true, stdio: 'ignore', env: process.env,
    });
    child.unref();
  } catch (e) { debug('uploader spawn failed', e.message); }
}

async function uploaderMain() {
  const cfg = loadConfig();
  if (!cfg.enabled || !cfg.endpoint) return;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // O_EXCL-style lock: whoever creates the file first owns the run.
  const mine = { pid: process.pid, at: Date.now() };
  try {
    const lock = readJSONSafe(UPLOAD_LOCK);
    if (lock?.pid && lock.pid !== process.pid) {
      try { process.kill(lock.pid, 0); if (Date.now() - lock.at < UPLOADER_MAX_RUN_MS + 60000) return; } catch { /* stale */ }
    }
    writeJSONSafe(UPLOAD_LOCK, mine);
    await drainUploads(cfg);
  } finally {
    if (readJSONSafe(UPLOAD_LOCK)?.pid === process.pid) { try { fs.unlinkSync(UPLOAD_LOCK); } catch {} }
  }
}

/* --------------------------------------------------------------------- main */

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return null; }
}

async function main() {
  const cfg = loadConfig();
  if (!cfg.enabled || !cfg.endpoint) return;

  const hook = readStdin();
  const sessionId = hook?.session_id;
  const transcriptPath = hook?.transcript_path;
  if (!sessionId || !transcriptPath) return;

  const event = hook.hook_event_name || 'Unknown';
  const statePath = path.join(STATE_DIR, `${sessionId}.json`);
  const state = readJSONSafe(statePath) || emptyState(sessionId);

  const ok = foldSession(state, transcriptPath, sessionId);
  if (!ok && event !== 'SessionEnd') { await flushSpool(cfg); return; }

  const now = Date.now();
  const isFinal = event === 'SessionEnd';
  const due = isFinal || event === 'SessionStart'
    || (now - (state.last_sent_at || 0)) >= cfg.flushIntervalSec * 1000;

  await flushSpool(cfg);
  if (!due) { writeJSONSafe(statePath, state); return; }

  // Opened and closed with no conversation: Claude Code only creates the
  // transcript with the first message, so there is nothing to report - and
  // sending it would show up as an empty "No activity recorded" session.
  const t = state.totals;
  const hasActivity = state.turns > 0 || state.user_messages > 0 || t.requests > 0
    || (t.input_tokens + t.output_tokens + t.cache_creation_tokens + t.cache_read_tokens) > 0
    || Boolean(state.title || state.first_prompt);
  if (!hasActivity) {
    if (isFinal) { try { fs.unlinkSync(statePath); } catch {} } else writeJSONSafe(statePath, state);
    return;
  }

  const acc = claudeAccount();
  const cwd = state.cwd || hook.cwd || process.cwd();
  const payload = {
    schema: 1,
    event,
    // SessionStart source: startup | resume | clear | compact. A resume keeps
    // the session id, so the server counts these to show how often a session
    // was picked back up.
    start_source: event === 'SessionStart' ? String(hook.source || '') : undefined,
    session_id: sessionId,
    end_reason: isFinal ? (hook.reason || 'end') : null,
    is_final: isFinal,
    developer: cfg.developer,
    machine: {
      machine_id: machineId(),
      hostname: os.hostname(),
      os_user: os.userInfo().username,
      platform: `${process.platform}-${process.arch}`,
      cc_version: state.cc_version,
    },
    claude_account: acc,
    project: {
      cwd,
      name: path.basename(cwd),
      git_branch: state.git_branch,
    },
    timing: {
      started_at: state.started_at || new Date(now).toISOString(),
      last_activity_at: state.last_activity_at || new Date(now).toISOString(),
      reported_at: new Date(now).toISOString(),
    },
    activity: {
      turns: state.turns,
      user_messages: state.user_messages,
      sidechain_requests: state.sidechain_requests,
      tool_calls: Object.values(state.tools).reduce((a, b) => a + b, 0),
      tools: state.tools,
      files_touched: state.files,
    },
    summary: {
      headline: buildHeadline(state, cfg.redactContent),
      title: cfg.redactContent ? '' : state.title,
      first_prompt: cfg.redactContent ? '' : state.first_prompt,
      last_assistant: (cfg.redactContent || !cfg.captureLastReply) ? '' : state.last_assistant,
    },
    usage: {
      total: state.totals,
      by_model: state.by_model,
    },
    runs: (state.runs || []).map(({ started_at, ended_at, prompts, turns, tokens, closed }) =>
      ({ started_at, ended_at, prompts, turns, tokens, closed })),
  };

  const result = await postJSON(cfg, payload);
  if (result === 'retry') spool(payload);
  if (result !== 'retry') state.last_sent_at = now;

  writeJSONSafe(statePath, state);

  // Session is over; the incremental state has no further use.
  if (isFinal) { try { fs.unlinkSync(statePath); } catch {} }

  if (cfg.uploadTranscripts) {
    if (isFinal) queueTranscripts(sessionId, transcriptPath);
    // Also nudge any backlog left by an earlier run (e.g. server was down).
    if (isFinal || event === 'SessionStart') { if (isFinal || listQueue().length) startUploader(); }
  }
}

const entry = process.argv.includes('--upload') ? uploaderMain : main;
entry().catch((e) => debug('fatal', e?.message)).finally(() => process.exit(0));
