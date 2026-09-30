/**
 * Renders a Claude Code transcript (.jsonl) as a readable HTML page.
 *
 * Everything from the transcript is escaped; the route serving this sets a CSP
 * with no script-src, and the page itself uses no JavaScript - tool calls and
 * results fold with <details>. Long sessions are paged so a 30 MB transcript
 * doesn't become one enormous page.
 */

const PER_PAGE = 400;
const MAX_BLOCK_CHARS = 20_000;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function clip(text, max = MAX_BLOCK_CHARS) {
  const t = String(text ?? '');
  return t.length > max ? `${t.slice(0, max)}\n\n… ${(t.length - max).toLocaleString('en-US')} more characters not shown` : t;
}

const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
};

/** Text of a tool_result's content, which may be a string or a block list. */
function resultText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : '')).join('\n');
  return '';
}

/** One transcript line -> zero or more display items. */
function itemsOf(e) {
  const out = [];
  const role = e?.message?.role || e?.type;
  const content = e?.message?.content;
  const side = e?.isSidechain === true;
  const ts = e?.timestamp;

  if (e?.type === 'summary' && e.summary) return [{ kind: 'note', label: 'Summary', text: e.summary, ts }];
  if (!e?.message) return out;

  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : (Array.isArray(content) ? content : []);
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && b.text?.trim()) {
      // Harness-injected context (<system-reminder>, <command-name>, ...) is
      // part of the record but not what the person typed: show it folded.
      const injected = role === 'user' && b.text.trimStart().startsWith('<');
      out.push({ kind: injected ? 'injected' : role === 'user' ? 'user' : role === 'system' ? 'system' : 'assistant', text: b.text, ts, side });
    } else if (b.type === 'thinking' && b.thinking?.trim()) {
      out.push({ kind: 'thinking', text: b.thinking, ts, side });
    } else if (b.type === 'tool_use') {
      const inp = b.input ?? {};
      // One-line hint so a long run of tool calls can be scanned without opening each.
      const hint = [inp.command, inp.file_path, inp.path, inp.pattern, inp.url, inp.query, inp.description, inp.prompt]
        .find((v) => typeof v === 'string' && v.trim()) || '';
      out.push({ kind: 'tool', name: b.name, hint: hint.replace(/\s+/g, ' ').slice(0, 140), text: JSON.stringify(inp, null, 2), ts, side });
    } else if (b.type === 'tool_result') {
      out.push({ kind: 'result', error: b.is_error === true, text: resultText(b.content), ts, side });
    } else if (b.type === 'image') {
      out.push({ kind: role === 'user' ? 'user' : 'assistant', text: '[image]', ts, side });
    }
  }
  return out;
}

function renderItem(it) {
  const side = it.side ? ' <span class="tag">subagent</span>' : '';
  const t = it.ts ? `<time>${esc(when(it.ts))}</time>` : '';
  switch (it.kind) {
    case 'user':
      return `<div class="msg user"><div class="who">Developer${side}${t}</div><pre>${esc(clip(it.text))}</pre></div>`;
    case 'assistant':
      return `<div class="msg asst"><div class="who">Claude${side}${t}</div><pre>${esc(clip(it.text))}</pre></div>`;
    case 'system':
      return `<details class="fold"><summary>System message${side} ${t}</summary><pre>${esc(clip(it.text))}</pre></details>`;
    case 'injected':
      return `<details class="fold"><summary>Injected context${side} ${t}</summary><pre>${esc(clip(it.text))}</pre></details>`;
    case 'thinking':
      return `<details class="fold"><summary>Thinking${side} ${t}</summary><pre>${esc(clip(it.text))}</pre></details>`;
    case 'tool':
      return `<details class="fold tool"><summary><b>${esc(it.name)}</b>${it.hint ? ` <code class="hint">${esc(it.hint)}</code>` : ' tool call'}${side} ${t}</summary><pre>${esc(clip(it.text))}</pre></details>`;
    case 'result':
      return `<details class="fold result${it.error ? ' err' : ''}"><summary>${it.error ? 'Tool error' : 'Tool result'}${side} · ${esc(String(it.text.length).replace(/\B(?=(\d{3})+(?!\d))/g, ','))} chars ${t}</summary><pre>${esc(clip(it.text))}</pre></details>`;
    case 'note':
      return `<div class="note"><b>${esc(it.label)}:</b> ${esc(it.text)}</div>`;
    default:
      return '';
  }
}

export function renderTranscript(raw, { sessionId, file, session = {}, uploadedAt, page = 1, basePath = '' }) {
  const items = [];
  let bad = 0; let title = '';
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { bad++; continue; }
    if (e?.type === 'ai-title' && e.aiTitle) title = e.aiTitle;
    items.push(...itemsOf(e));
  }

  const pages = Math.max(1, Math.ceil(items.length / PER_PAGE));
  const p = Math.min(Math.max(1, page), pages);
  const slice = items.slice((p - 1) * PER_PAGE, p * PER_PAGE);
  const self = `${basePath}/transcripts/${encodeURIComponent(sessionId)}/${encodeURIComponent(file)}`;
  const download = `${basePath}/api/transcripts/${encodeURIComponent(sessionId)}/${encodeURIComponent(file)}`;
  const nav = pages > 1 ? `<nav>${p > 1 ? `<a href="${self}?page=${p - 1}">← Previous</a>` : '<span></span>'}
    <span>Page ${p} of ${pages} · ${items.length.toLocaleString('en-US')} entries</span>
    ${p < pages ? `<a href="${self}?page=${p + 1}">Next →</a>` : '<span></span>'}</nav>` : '';
  const heading = title || session.title || session.headline || sessionId;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(heading)} · transcript</title>
<style>
:root { color-scheme: light; --bg:#f4f4f1; --card:#fcfcfb; --soft:#efeeea; --border:#e3e2dd; --text:#0b0b0b; --muted:#7c7b73; --sub:#52514e; --accent:#2a78d6; --user:#eef4fc; --err:#d03b3b; }
@media (prefers-color-scheme: dark) { :root { color-scheme: dark; --bg:#101010; --card:#1a1a19; --soft:#232322; --border:#302f2c; --text:#fff; --muted:#8f8e85; --sub:#c3c2b7; --accent:#3987e5; --user:#16202c; --err:#e66767; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:14px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
.wrap { max-width: 980px; margin: 0 auto; padding: 22px 16px 60px; }
header h1 { font-size: 18px; margin: 0 0 4px; font-weight: 650; letter-spacing: -.01em; }
header .meta { color: var(--muted); font-size: 12.5px; }
header .meta a { color: var(--accent); }
nav { display:flex; justify-content:space-between; align-items:center; gap:12px; margin: 16px 0; font-size: 13px; color: var(--sub); }
nav a { color: var(--accent); text-decoration: none; }
.msg { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; margin: 10px 0; }
.msg.user { background: var(--user); }
.who { font-size: 11.5px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); font-weight: 600; display:flex; gap:8px; align-items:center; }
time { margin-left: auto; font-weight: 400; text-transform: none; letter-spacing: 0; }
pre { white-space: pre-wrap; word-break: break-word; margin: 6px 0 0; font: 13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; }
.msg pre { font-family: inherit; font-size: 14px; }
.fold { border: 1px solid var(--border); border-radius: 8px; margin: 6px 0 6px 18px; background: var(--soft); }
.fold > summary { cursor: pointer; padding: 6px 10px; font-size: 12.5px; color: var(--sub); display:flex; gap:6px; align-items:center; }
.fold > pre { padding: 0 12px 10px; max-height: 520px; overflow: auto; }
.fold.err > summary { color: var(--err); }
.hint { font: 12px ui-monospace,SFMono-Regular,Menlo,monospace; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
.tag { border: 1px solid var(--border); border-radius: 999px; padding: 0 6px; font-size: 10.5px; text-transform: none; letter-spacing: 0; }
.note { color: var(--sub); font-size: 13px; margin: 10px 0; }
.empty { color: var(--muted); padding: 24px 0; }
</style></head><body><div class="wrap">
<header>
  <h1>${esc(heading)}</h1>
  <div class="meta">${esc(session.developer_name || session.developer_email || 'Unknown developer')}${session.project_name ? ` · ${esc(session.project_name)}` : ''}
    · ${esc(file)} · session <code>${esc(sessionId)}</code>${uploadedAt ? ` · uploaded ${esc(when(uploadedAt))}` : ''}
    · <a href="${download}" download>Download .gz</a> · <a href="${basePath}/">Dashboard</a>${bad ? ` · ${bad} unreadable line${bad === 1 ? '' : 's'} skipped` : ''}</div>
</header>
${nav}
${slice.length ? slice.map(renderItem).join('\n') : '<div class="empty">No conversation entries in this file.</div>'}
${nav}
</div></body></html>`;
}
