#!/usr/bin/env node
/**
 * Local model-routing proxy for Claude Code.
 *
 * Claude Code is pointed at this process with ANTHROPIC_BASE_URL (installer
 * `--jev`). Every request is forwarded to the real API unchanged, except that
 * on a session's first message request the proxy asks the usage server which
 * model Jev recommends for that session, and from then on sends that session's
 * main-conversation requests to it.
 *
 * Hooks can't do this: Claude Code only changes models through /model, the
 * model picker, or the SDK - a hook can allow or deny a switch but never make
 * one. Rewriting the request's `model` field is the one place it can be done.
 *
 * Rules that keep this safe:
 *  - Any failure (server down, timeout, bad JSON) forwards the request exactly
 *    as Claude Code sent it. The proxy never blocks a developer.
 *  - One decision per session, made before there is any history, so switching
 *    never throws away a warm prompt cache.
 *  - Only requests for the model the decision was made from are rewritten;
 *    Haiku background calls and subagents pinned to another model pass through.
 *  - Credentials pass straight through and are never logged or stored.
 *
 *   proxy.mjs            run the proxy (foreground)
 *   proxy.mjs --ensure   start it in the background if it isn't answering
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'claude-usage-tracker');
const STATE_DIR = path.join(process.env.XDG_CACHE_HOME || path.join(HOME, '.cache'), 'claude-usage-tracker');
const LOG = path.join(STATE_DIR, 'proxy.log');
const VERSION = '1.2.0';
const HEALTH_PATH = '/__inhouse/health';

const ROUTE_TIMEOUT_MS = 2000;
const MAX_ROUTE_ATTEMPTS = 3;       // per session, when the server gives no stored answer
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_SESSIONS = 2000;

function loadConfig() {
  let f = {};
  try { f = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8')); } catch {}
  const jev = f.jev || {};
  return {
    endpoint: process.env.CLAUDE_USAGE_ENDPOINT || f.endpoint || '',
    token: process.env.CLAUDE_USAGE_TOKEN || f.token || '',
    // Routing can be off while the proxy keeps running as a pass-through, so
    // a stale ANTHROPIC_BASE_URL never leaves Claude Code with nothing to talk to.
    routing: f.enabled !== false && jev.enabled === true,
    port: Number(process.env.INHOUSE_PROXY_PORT || jev.port || 47821),
    upstream: String(jev.upstream || 'https://api.anthropic.com').replace(/\/+$/, ''),
  };
}

function log(...a) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // Rotate at 1 MB; the log only ever holds routing decisions, never content.
    try { if (fs.statSync(LOG).size > 1024 * 1024) fs.renameSync(LOG, `${LOG}.1`); } catch {}
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${a.join(' ')}\n`);
  } catch {}
}

/* ------------------------------------------------------------------ decide */

/** The developer's latest real prompt: user text, minus injected <tags> and tool results. */
function promptOf(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role !== 'user') continue;
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : (Array.isArray(m.content) ? m.content : []);
    const text = blocks
      .filter((b) => b?.type === 'text' && typeof b.text === 'string' && !b.text.trimStart().startsWith('<'))
      .map((b) => b.text).join('\n').trim();
    if (text) return text;
  }
  return '';
}

function sessionOf(req, body) {
  const h = req.headers['x-claude-code-session-id'];
  if (typeof h === 'string' && h) return h;
  try { return JSON.parse(body?.metadata?.user_id || '{}').session_id || ''; } catch { return ''; }
}

const decisions = new Map(); // session -> { requested, model, reason } | Promise
const attempts = new Map();
// Models the server routes, learned from its answers. Until the first answer
// arrives every model is tried once; after that anything else (Haiku
// background calls, pinned subagents) skips the round-trip entirely.
let routable = null;

async function askServer(cfg, sessionId, requestedModel, prompt) {
  const url = `${cfg.endpoint.replace(/\/api\/ingest\/?$/, '')}/api/route`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ROUTE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}) },
      body: JSON.stringify({ session_id: sessionId, requested_model: requestedModel, prompt }),
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

/** The model to send for this request, or null to leave it untouched. */
async function modelFor(cfg, sessionId, body) {
  if (!cfg.routing || !cfg.endpoint || !sessionId || typeof body?.model !== 'string') return null;

  if (routable && !routable.includes(body.model)) return null;

  let d = decisions.get(sessionId);
  if (!d) {
    const prompt = promptOf(body);
    if (!prompt) return null;
    const n = (attempts.get(sessionId) || 0) + 1;
    if (n > MAX_ROUTE_ATTEMPTS) return null;
    attempts.set(sessionId, n);

    const requested = body.model;
    d = askServer(cfg, sessionId, requested, prompt).then((r) => {
      if (Array.isArray(r?.routable)) routable = r.routable;
      // A model the server doesn't route says nothing about this session:
      // don't cache it and don't count it as an attempt.
      if (r?.reason === 'model not routed') { attempts.set(sessionId, n - 1); decisions.delete(sessionId); return { requested, model: null, reason: r.reason }; }
      // Keep the answer only if the server made (and stored) a real decision;
      // otherwise let a later request in this session try again.
      const final = r?.final === true;
      const v = { requested, model: r?.apply ? r.model : null, reason: r?.reason || 'no answer' };
      if (final) {
        decisions.set(sessionId, v);
        log(`session=${sessionId} requested=${requested} -> ${v.model || 'unchanged'} (${v.reason}${r?.confidence ? `, confidence ${r.confidence}` : ''})`);
      } else {
        decisions.delete(sessionId);
        log(`session=${sessionId} no decision yet (${v.reason}), attempt ${n}/${MAX_ROUTE_ATTEMPTS}`);
      }
      return v;
    });
    decisions.set(sessionId, d); // concurrent requests wait on the same answer
    if (decisions.size > MAX_SESSIONS) decisions.delete(decisions.keys().next().value);
  }
  const v = await d;
  // Only the conversation's own model is rerouted.
  return v.model && body.model === v.requested ? v.model : null;
}

/* ---------------------------------------------------------------- forward */

function forward(cfg, req, res, bodyBuf) {
  const target = new URL(cfg.upstream + req.url);
  const headers = { ...req.headers, host: target.host };
  delete headers.connection;
  if (bodyBuf) headers['content-length'] = String(bodyBuf.length);
  const mod = target.protocol === 'http:' ? http : https;
  const up = mod.request(target, { method: req.method, headers }, (ur) => {
    res.writeHead(ur.statusCode || 502, ur.headers);
    ur.pipe(res);
  });
  up.on('error', (e) => {
    log(`upstream error ${e.code || e.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `inhouse proxy could not reach ${cfg.upstream}: ${e.code || e.message}` } }));
    } else res.destroy();
  });
  if (bodyBuf) up.end(bodyBuf); else req.pipe(up);
}

function serve() {
  const cfg = loadConfig();
  const server = http.createServer((req, res) => {
    if (req.url === HEALTH_PATH) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: VERSION, routing: loadConfig().routing, pid: process.pid }));
      return;
    }
    const isMessages = req.method === 'POST' && /^\/v1\/messages(\?|$)/.test(req.url);
    if (!isMessages) return forward(cfg, req, res, null);

    const chunks = []; let size = 0; let tooBig = false;
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY_BYTES) tooBig = true; else chunks.push(c); });
    req.on('end', async () => {
      const raw = Buffer.concat(chunks);
      if (tooBig) return forward(cfg, req, res, raw); // can't rewrite what we didn't keep; send as-is
      let out = raw;
      try {
        const body = JSON.parse(raw.toString('utf8'));
        // Re-read config per request so enabling/disabling routing or changing
        // the server takes effect without a restart. Port and upstream are
        // fixed for the life of the process.
        const live = { ...loadConfig(), port: cfg.port, upstream: cfg.upstream };
        const m = await modelFor(live, sessionOf(req, body), body);
        if (m && m !== body.model) { body.model = m; out = Buffer.from(JSON.stringify(body)); }
      } catch (e) { log(`pass-through (${e.message})`); }
      forward(cfg, req, res, out);
    });
  });
  server.on('error', (e) => { log(`listen failed: ${e.code || e.message}`); process.exit(0); });
  server.listen(cfg.port, '127.0.0.1', () => log(`proxy ${VERSION} listening on 127.0.0.1:${cfg.port} -> ${cfg.upstream} (routing ${cfg.routing ? 'on' : 'off'})`));
}

/* ----------------------------------------------------------------- ensure */

async function healthy(port) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 300);
  try { const r = await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`, { signal: ctl.signal }); return r.ok; }
  catch { return false; } finally { clearTimeout(t); }
}

/** Start the proxy if nothing answers on its port, and wait for it. Never prints. */
async function ensure() {
  const { port } = loadConfig();
  // Only machines that routed Claude Code through us need a proxy: jev turned
  // on, or ANTHROPIC_BASE_URL (from settings.json env, which hooks inherit)
  // pointing at our port - in which case it must run even with routing off,
  // or Claude Code would have nothing to talk to.
  let jevOn = false;
  try { jevOn = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'config.json'), 'utf8')).jev?.enabled === true; } catch {}
  const pointsHere = new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${port}(/|$)`).test(process.env.ANTHROPIC_BASE_URL || '');
  if (!jevOn && !pointsHere) return;
  if (await healthy(port)) return;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await healthy(port)) return;
  }
  log('ensure: proxy did not come up within 3s');
}

if (process.argv.includes('--ensure')) ensure().finally(() => process.exit(0));
else serve();
