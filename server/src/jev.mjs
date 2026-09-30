/**
 * Model routing with Jev (TypeSafe's decision model, run on Cloudflare
 * Workers AI).
 *
 * Jev is a third-party model: Cloudflare runs it through the account's AI
 * Gateway and bills it via Unified Billing, so the account needs prepaid AI
 * Gateway credits. The call is Cloudflare's model-agnostic REST endpoint,
 *   POST /accounts/{id}/ai/run   { "model": "typesafe/jev", "input": {...} }
 * authenticated with an API token that has Account > Workers AI > Read.
 * CF_AIG_GATEWAY_ID picks a gateway other than the default; CF_AIG_TOKEN is
 * sent as cf-aig-authorization for a gateway with authentication turned on.
 *
 * The plugin's local proxy asks this server once per Claude Code session,
 * with the session's first prompt, which model should handle it. Jev answers
 * one Choice question; policy here decides whether that answer is applied:
 *
 *  - only between the models in JEV_MODELS (Opus and Sonnet of the same
 *    generation - an older model rejects the request format Claude Code sends)
 *  - only when Jev's confidence is at least JEV_MIN_CONFIDENCE
 *  - moving to the more expensive model only when JEV_ALLOW_UPGRADE=1
 *
 * Once per session, not per prompt: switching models mid-conversation throws
 * away the prompt cache, and re-reading the whole history at full price can
 * cost more than the switch saves.
 *
 * Every failure is "no decision": the proxy then forwards the request exactly
 * as Claude Code sent it.
 */

const DEFAULT_MODELS = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
};

// Most expensive first; used to tell an upgrade from a downgrade.
const RANK = ['opus', 'sonnet'];

const CRITERIA = {
  opus: 'Hard or open-ended engineering: designing architecture, planning a feature, '
    + 'multi-file refactors, debugging a failure whose cause is unknown, security or '
    + 'performance investigation, migrating infrastructure, or anything ambiguous '
    + 'where reasoning quality matters more than speed.',
  sonnet: 'Well-defined, routine work: a small or single-file edit, explaining code, '
    + 'answering a question, running or checking commands, writing a simple test, '
    + 'formatting, renaming, fixing an obvious bug, or following a clear instruction.',
};

const INSTRUCTIONS = 'This is the opening request a developer gave a coding assistant. '
  + 'Which model tier does the work it asks for need?';

// Jev on Cloudflare accepts 32k tokens in total. Keep the prompt well under it.
const MAX_PROMPT_CHARS = 24_000;

export function makeJev(db, budget, env = process.env) {
  const accountId = env.CF_ACCOUNT_ID || '';
  const token = env.CF_AI_TOKEN || '';
  const gatewayId = env.CF_AIG_GATEWAY_ID || '';
  const gatewayToken = env.CF_AIG_TOKEN || '';
  const enabled = Boolean(accountId && token);
  const base = (env.CF_AI_BASE_URL || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');
  const model = env.JEV_MODEL || 'typesafe/jev';
  const timeoutMs = Number(env.JEV_TIMEOUT_MS || 1500);
  const minConfidence = Number(env.JEV_MIN_CONFIDENCE ?? 0.7);
  const allowUpgrade = env.JEV_ALLOW_UPGRADE === '1';
  const models = { ...DEFAULT_MODELS };
  for (const tier of Object.keys(models)) {
    const v = env[`JEV_MODEL_${tier.toUpperCase()}`];
    if (v) models[tier] = v;
  }
  const tierOf = (m) => Object.keys(models).find((t) => models[t] === m) || null;

  db.exec(`
    CREATE TABLE IF NOT EXISTS jev_decisions (
      session_id        TEXT PRIMARY KEY,
      requested_model   TEXT NOT NULL DEFAULT '',
      recommended_tier  TEXT NOT NULL DEFAULT '',   -- '' when Jev gave no answer
      chosen_model      TEXT NOT NULL DEFAULT '',   -- what the proxy should send; '' = unchanged
      applied           INTEGER NOT NULL DEFAULT 0,
      confidence        REAL NOT NULL DEFAULT 0,
      reason            TEXT NOT NULL DEFAULT '',
      prompt_chars      INTEGER NOT NULL DEFAULT 0,
      input_tokens      INTEGER NOT NULL DEFAULT 0,
      cost_usd          REAL NOT NULL DEFAULT 0,
      latency_ms        INTEGER NOT NULL DEFAULT 0,
      jev_version       TEXT NOT NULL DEFAULT '',
      decided_at        TEXT NOT NULL DEFAULT ''
    );
  `);

  const save = db.prepare(`
    INSERT OR IGNORE INTO jev_decisions
      (session_id, requested_model, recommended_tier, chosen_model, applied, confidence, reason,
       prompt_chars, input_tokens, cost_usd, latency_ms, jev_version, decided_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const routable = () => Object.values(models);
  // final: the session is decided and the answer won't change - the proxy can
  // cache it. Transient answers (timeouts, not configured, ...) are final: false.
  const view = (d) => ({
    final: true,
    routable: routable(),
    session_id: d.session_id,
    model: d.chosen_model || null,
    apply: Boolean(d.applied),
    recommended: d.recommended_tier ? models[d.recommended_tier] : null,
    confidence: d.confidence,
    reason: d.reason,
  });

  function record(sessionId, requested, fields) {
    const d = {
      session_id: sessionId, requested_model: requested, recommended_tier: '', chosen_model: '',
      applied: 0, confidence: 0, reason: '', prompt_chars: 0, input_tokens: 0, cost_usd: 0,
      latency_ms: 0, jev_version: '', decided_at: new Date().toISOString(), ...fields,
    };
    save.run(d.session_id, d.requested_model, d.recommended_tier, d.chosen_model, d.applied,
      d.confidence, d.reason, d.prompt_chars, d.input_tokens, d.cost_usd, d.latency_ms,
      d.jev_version, d.decided_at);
    // INSERT OR IGNORE: if two requests raced, the first decision wins.
    return view(db.prepare('SELECT * FROM jev_decisions WHERE session_id = ?').get(sessionId));
  }

  async function callJev(prompt) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(`${base}/accounts/${encodeURIComponent(accountId)}/ai/run`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          ...(gatewayId ? { 'cf-aig-gateway-id': gatewayId } : {}),
          ...(gatewayToken ? { 'cf-aig-authorization': `Bearer ${gatewayToken}` } : {}),
        },
        body: JSON.stringify({
          model,
          input: {
            state: prompt,
            questions: {
              tier: {
                type: 'choice',
                instructions: INSTRUCTIONS,
                criteria: Object.fromEntries(Object.keys(models).map((t) => [t, CRITERIA[t]])),
              },
            },
          },
        }),
        signal: ctl.signal,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.success === false) {
        const msg = body.errors?.[0]?.message || `HTTP ${res.status}`;
        throw new Error(`Jev call failed: ${msg}`);
      }
      // Cloudflare's envelope has varied ({result: {...}} for Workers AI,
      // {result: {...}, usage, model} on the gateway REST API); take the
      // innermost object that carries the answers.
      const layers = [body.result?.result, body.result, body].filter(Boolean);
      const r = layers.find((x) => x.answers) || {};
      const usage = r.usage || body.result?.usage || body.usage || {};
      return { answer: r.answers?.tier, usage, version: r.model || body.result?.model || '', latency: Date.now() - started };
    } finally { clearTimeout(timer); }
  }

  return {
    enabled,
    models,
    policy: { minConfidence, allowUpgrade },

    /**
     * Decide the model for a session. Idempotent: a session is decided once
     * and every later call returns the same answer without calling Jev.
     */
    async decide({ sessionId, requestedModel, prompt }) {
      const prior = db.prepare('SELECT * FROM jev_decisions WHERE session_id = ?').get(sessionId);
      if (prior) return view(prior);

      const requestedTier = tierOf(requestedModel);
      const text = String(prompt || '').slice(0, MAX_PROMPT_CHARS);
      const promptChars = text.length;

      // Not ours to change: an explicit model outside the routed pair (Haiku
      // for background tasks, a pinned older model, ...). Not stored, so a
      // later request in the same session that *is* routable still decides.
      const transient = (reason) => ({ final: false, routable: routable(), session_id: sessionId, model: null, apply: false, reason });
      if (!requestedTier) return transient('model not routed');
      if (!enabled) return transient('jev not configured');
      if (!text.trim()) return transient('no prompt text');

      // ~4 chars per token for English and code, plus the question itself.
      const estTokens = Math.ceil(promptChars / 4) + 250;
      if (!budget.allow(budget.est.jev(estTokens))) {
        return record(sessionId, requestedModel, { reason: 'spend cap reached', prompt_chars: promptChars });
      }

      let r;
      try {
        r = await callJev(text);
      } catch (e) {
        // A call we gave up on may still be billed; book the estimate so the
        // cap stays an upper bound.
        if (e.name === 'AbortError') budget.record('jev', estTokens, budget.est.jev(estTokens));
        // Not stored: a timeout or outage shouldn't lock the session to "no decision".
        return transient(e.name === 'AbortError' ? 'jev timed out' : e.message);
      }
      const inputTokens = Number(r.usage.input_tokens) || estTokens;
      const cost = budget.est.jev(inputTokens);
      budget.record('jev', inputTokens, cost);

      const tier = r.answer?.choice;
      const confidence = Number(r.answer?.confidence) || 0;
      const common = { prompt_chars: promptChars, input_tokens: inputTokens, cost_usd: cost, latency_ms: r.latency, jev_version: r.version, confidence };
      if (!models[tier]) return record(sessionId, requestedModel, { ...common, reason: 'jev gave no usable answer' });

      const out = { ...common, recommended_tier: tier };
      if (tier === requestedTier) return record(sessionId, requestedModel, { ...out, reason: 'already on the recommended model' });
      if (confidence < minConfidence) return record(sessionId, requestedModel, { ...out, reason: `confidence ${confidence.toFixed(2)} below ${minConfidence}` });
      const isUpgrade = RANK.indexOf(tier) < RANK.indexOf(requestedTier);
      if (isUpgrade && !allowUpgrade) return record(sessionId, requestedModel, { ...out, reason: 'upgrades disabled' });

      return record(sessionId, requestedModel, { ...out, chosen_model: models[tier], applied: 1, reason: isUpgrade ? 'upgraded' : 'downgraded' });
    },
  };
}
