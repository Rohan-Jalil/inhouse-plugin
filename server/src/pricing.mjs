/**
 * Converts token counts to an equivalent list-price API cost.
 *
 * Nobody is actually billed this: developers run on Claude Max/Pro seats. It is
 * a single comparable number for "how much work did this session do", which
 * tokens alone don't give you when sessions mix models.
 */

import fs from 'node:fs';

const PER_MILLION = 1_000_000;

export function loadPricing(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const models = raw.models || {};
  // Longest prefix wins, so `claude-opus-5` matches `claude-opus-5[1m]` but
  // `claude-opus-4-8` never swallows `claude-opus-4-8-something-else` first.
  const keys = Object.keys(models).sort((a, b) => b.length - a.length);

  function rateFor(model) {
    const id = String(model || '').toLowerCase()
      .replace(/\[[^\]]*\]$/, '')   // context-window suffix, e.g. [1m]
      .replace(/-\d{8}$/, '');      // dated snapshot, e.g. -20251001
    const key = keys.find((k) => id.startsWith(k));
    const m = key ? models[key] : raw.default;
    return {
      matched: key || null,
      input: m.input,
      output: m.output,
      cache_write: m.cache_write ?? m.input * 1.25,
      cache_read: m.cache_read ?? m.input * 0.10,
    };
  }

  function costOf(model, u) {
    const r = rateFor(model);
    return (
      (u.input_tokens || 0) * r.input +
      (u.output_tokens || 0) * r.output +
      (u.cache_creation_tokens || 0) * r.cache_write +
      (u.cache_read_tokens || 0) * r.cache_read
    ) / PER_MILLION;
  }

  return { costOf, rateFor, updated: raw.updated };
}
