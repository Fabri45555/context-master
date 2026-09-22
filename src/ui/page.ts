/**
 * The dashboard page (PRD 41).
 *
 * One string, no build step, no CDN. The page is served from loopback by the same process
 * that owns the store, so a dependency on an external asset host would be the only way for
 * this to leak anything.
 */
export function renderPage(version = ''): string {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>contextd</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  :root {
    color-scheme: dark;
    --bg: #0f1115; --panel: #161a21; --line: #242a34; --ink: #e6e9ef;
    --muted: #8b95a5; --accent: #6ea8fe; --warn: #e0a33e; --bad: #e06c75; --good: #7cc379;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.5 system-ui, -apple-system, Segoe UI, sans-serif;
  }
  header {
    position: sticky; top: 0; z-index: 5; background: var(--bg);
    border-bottom: 1px solid var(--line); padding: 14px 20px;
    display: flex; gap: 16px; align-items: baseline; flex-wrap: wrap;
  }
  header h1 { margin: 0; font-size: 16px; letter-spacing: .02em; }
  header .path { color: var(--muted); font-family: var(--mono); font-size: 12px; }
  nav { display: flex; gap: 4px; padding: 10px 20px 0; flex-wrap: wrap; }
  nav button {
    background: transparent; color: var(--muted); border: 1px solid transparent;
    border-radius: 6px 6px 0 0; padding: 7px 13px; cursor: pointer; font-size: 13px;
  }
  nav button[aria-selected="true"] {
    color: var(--ink); background: var(--panel); border-color: var(--line); border-bottom-color: var(--panel);
  }
  main { padding: 0 20px 40px; }
  .panel {
    background: var(--panel); border: 1px solid var(--line); border-radius: 0 8px 8px 8px;
    padding: 18px; min-height: 260px;
  }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; }
  .tile { background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 13px 15px; }
  .tile .k { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  .tile .v { font-size: 22px; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .tile .s { color: var(--muted); font-size: 12px; margin-top: 2px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted);
       margin: 26px 0 10px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--muted); font-weight: 600; font-size: 11px;
       text-transform: uppercase; letter-spacing: .05em; padding: 7px 10px;
       border-bottom: 1px solid var(--line); }
  td { padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  code, .mono { font-family: var(--mono); font-size: 12px; }
  .tag { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px;
         border: 1px solid var(--line); color: var(--muted); white-space: nowrap; }
  .tag.critical { color: var(--bad); border-color: var(--bad); }
  .tag.high { color: var(--warn); border-color: var(--warn); }
  .tag.user { color: var(--accent); border-color: var(--accent); }
  .muted { color: var(--muted); }
  .bar { height: 5px; border-radius: 3px; background: var(--line); overflow: hidden; margin-top: 7px; }
  .bar > i { display: block; height: 100%; background: var(--accent); }
  pre { background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
        padding: 14px; overflow-x: auto; font-family: var(--mono); font-size: 12px;
        white-space: pre-wrap; word-break: break-word; }
  input[type=search] {
    background: var(--bg); border: 1px solid var(--line); color: var(--ink);
    border-radius: 6px; padding: 8px 11px; width: 100%; max-width: 420px; font-size: 13px;
  }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 14px; }
  .scroll { overflow-x: auto; }
  .empty { color: var(--muted); padding: 30px 0; text-align: center; }
  .pair { border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin-bottom: 10px; }
  .pair .side { padding: 7px 0; }
  svg { max-width: 100%; }
  .hero { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 14px; }
  .claim { background: var(--bg); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; }
  .claim .big { font-size: 30px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.15; }
  .claim .big.good { color: var(--good); }
  .claim .what { margin-top: 6px; }
  .claim .how { color: var(--muted); font-size: 12px; margin-top: 8px; }
  .compare { margin: 6px 0 4px; }
  .compare .lbl { display: flex; justify-content: space-between; gap: 10px; font-size: 12px;
                  color: var(--muted); margin-top: 10px; }
  .compare .track { height: 18px; background: var(--bg); border: 1px solid var(--line); border-radius: 5px; overflow: hidden; }
  .compare .fill { height: 100%; background: var(--muted); min-width: 3px; }
  .compare .fill.good { background: var(--good); }
  .funnel .step { display: grid; grid-template-columns: minmax(120px, 190px) 1fr minmax(70px, auto);
                  gap: 10px; align-items: center; margin: 7px 0; font-size: 13px; }
  .funnel .track { height: 12px; background: var(--bg); border-radius: 4px; overflow: hidden; }
  .funnel .fill { height: 100%; background: var(--accent); min-width: 2px; }
  .funnel .n { text-align: right; font-variant-numeric: tabular-nums; }
  .checks { list-style: none; padding: 0; margin: 0; }
  .checks li { padding: 8px 0; border-bottom: 1px solid var(--line); display: flex; gap: 10px; }
  .checks li:last-child { border-bottom: 0; }
  .checks .mark { color: var(--good); font-weight: 700; }
  .checks .mark.warn { color: var(--warn); }
  .caveats { border: 1px solid var(--warn); border-radius: 8px; padding: 12px 16px; }
  .caveats li { margin: 5px 0; }
  .chart { position: relative; }
  .chart svg { display: block; width: 100%; height: auto; touch-action: pan-y; }
  .chart .tip { position: absolute; display: none; pointer-events: none; transform: translate(-50%, -100%);
                background: var(--bg); border: 1px solid var(--line); border-radius: 6px;
                padding: 6px 9px; font-size: 12px; white-space: nowrap; }
  .chart .tip b { font-variant-numeric: tabular-nums; }
  details summary { cursor: pointer; color: var(--muted); font-size: 12px; margin: 8px 0; }
  @media (max-width: 560px) { main, header, nav { padding-left: 14px; padding-right: 14px; } }
</style>
</head>
<body>
<header>
  <h1>contextd</h1>
  <span class="path" id="project"></span>
  <span class="muted" id="freshness" style="margin-left:auto"></span>
</header>
<nav id="tabs"></nav>
<main><div class="panel" id="panel"><div class="empty">loading…</div></div></main>
<script>
const TABS = [
  ['benefits', 'Benefits'], ['overview', 'Overview'], ['memory', 'Memory'], ['conflicts', 'Conflicts'],
  ['graph', 'Graph'], ['context', 'Context'], ['events', 'Events'], ['patches', 'Patches'],
];
let current = location.hash.slice(1) || 'benefits';
/*
 * The page is one long-lived script that only ever refetches data, so after a rebuild an open
 * tab keeps running the old code against the new server: the fix that stopped refreshes from
 * rebuilding the panel shipped, and a tab opened earlier kept rebuilding it. The server stamps every response
 * with the version of the page it would serve now; on a mismatch, reload once for that version.
 */
const PAGE_VERSION = ${JSON.stringify(version)};
const panel = document.getElementById('panel');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '–');
const pct = (x) => (typeof x === 'number' ? (x * 100).toFixed(1) + '%' : '–');

async function get(path) {
  const res = await fetch(path);
  const served = res.headers.get('x-page-version');
  if (PAGE_VERSION && served && served !== PAGE_VERSION) {
    let seen = null;
    try { seen = sessionStorage.getItem('reloaded-for'); } catch {}
    // Once per version: a mismatch that survives a reload must not become a reload loop.
    if (seen !== served) {
      try { sessionStorage.setItem('reloaded-for', served); } catch {}
      location.reload();
    }
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

function renderTabs() {
  document.getElementById('tabs').innerHTML = TABS.map(([id, label]) =>
    '<button role="tab" aria-selected="' + (id === current) + '" data-tab="' + id + '">' + label + '</button>'
  ).join('');
  document.querySelectorAll('[data-tab]').forEach((b) =>
    b.addEventListener('click', () => { current = b.dataset.tab; location.hash = current; renderTabs(); draw(); }));
}

function tile(k, v, s, barPct) {
  return '<div class="tile"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div>' +
    (s ? '<div class="s">' + esc(s) + '</div>' : '') +
    (barPct != null ? '<div class="bar"><i style="width:' + Math.min(100, barPct * 100) + '%"></i></div>' : '') +
    '</div>';
}

function table(headers, rows) {
  if (!rows.length) return '<div class="empty">nothing here yet</div>';
  return '<div class="scroll"><table><thead><tr>' +
    headers.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></div>';
}

const impTag = (i) => '<span class="tag ' + esc(i) + '">' + esc(i) + '</span>';

function claim(big, what, how, good) {
  return '<div class="claim"><div class="big' + (good ? ' good' : '') + '">' + big + '</div>' +
    '<div class="what">' + what + '</div><div class="how">' + how + '</div></div>';
}

function times(x) {
  if (x == null) return '–';
  return (x >= 100 ? Math.round(x).toLocaleString('en-US') : x.toFixed(1)) + '&times;';
}

function compact(n) {
  if (typeof n !== 'number') return '–';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e4) return Math.round(n / 1e3) + 'k';
  return num(n);
}

async function drawBenefits() {
  const d = await get('/api/benefits');
  const b = d.benefits;
  const r = b.resume, dl = b.delivery, t = b.triage, pr = b.protection, c = b.continuity, q = b.quality;

  let html = '<div class="hero">';
  html += r.smaller_by != null
    ? claim(times(r.smaller_by) + ' smaller',
        'The project state fits in <b>' + num(r.bootstrap_tokens) + '</b> tokens; the conversation it was distilled from reached <b>' +
        num(r.agent_peak_tokens) + '</b>.',
        'a size comparison, not a saving: nobody would re-read the whole conversation', true)
    : claim(num(r.bootstrap_tokens), 'tokens to resume the project in a fresh session.',
        'no agent turn observed yet, so there is nothing measured to compare against', false);
  html += claim(dl.usd_avoided != null ? '$' + dl.usd_avoided.toFixed(2) : compact(dl.tokens_avoided),
      (dl.usd_avoided != null ? '(' + compact(dl.tokens_avoided) + ' tokens) ' : 'tokens ') +
      'not spent re-reading the documentation, over <b>' + num(dl.resumes) + '</b> resume' + (dl.resumes === 1 ? '' : 's') +
      ' from memory' + (dl.worker_usd > 0 ? '; workers cost <b>$' + dl.worker_usd.toFixed(2) + '</b>' : '') + '.',
      'per resume: ' + num(dl.rebuild_tokens) + ' tokens of project .md files minus the bootstrap', dl.tokens_avoided > 0);
  html += claim(pct(t.share_by_code),
      'of <b>' + num(t.events) + '</b> events were settled by code, never reaching a model.',
      'discarded at ingest or closed by the deterministic fold', t.share_by_code > 0.5);
  html += claim(num(pr.user_critical_items),
      'user instructions held as protected memory: no worker, prompt or patch can weaken them.',
      'enforced by isProtected in code, not by a prompt', pr.user_critical_items > 0);
  html += '</div>';

  if (r.agent_peak_tokens > 0) {
    const w = (x) => Math.max(0.25, (x / r.agent_peak_tokens) * 100);
    html += '<h2>What it takes to pick the work back up</h2><div class="compare">' +
      '<div class="lbl"><span>agent context at its peak</span><span>' + num(r.agent_peak_tokens) + ' tokens</span></div>' +
      '<div class="track"><div class="fill" style="width:100%"></div></div>' +
      (r.history_tokens > 0 ? '<div class="lbl"><span>history the memory was derived from</span><span>' + num(r.history_tokens) + ' tokens</span></div>' +
        '<div class="track"><div class="fill" style="width:' + w(r.history_tokens) + '%"></div></div>' : '') +
      '<div class="lbl"><span>contextd bootstrap</span><span>' + num(r.bootstrap_tokens) + ' tokens</span></div>' +
      '<div class="track"><div class="fill good" style="width:' + w(r.bootstrap_tokens) + '%"></div></div>' +
      '</div>';
  }

  const top = Math.max(1, t.events);
  const step = (label, n, note) => '<div class="step"><span>' + label + '</span>' +
    '<div class="track"><div class="fill" style="width:' + Math.max(0.3, (n / top) * 100) + '%"></div></div>' +
    '<span class="n">' + num(n) + (note ? ' <span class="muted">' + note + '</span>' : '') + '</span></div>';
  html += '<h2>From events to memory</h2><div class="funnel">' +
    step('events observed', t.events) +
    step('settled by code', t.handled_by_code, 'free') +
    step('read by a worker', t.derived_by_model) +
    step('still waiting', t.pending) +
    step('memory items', q.active_items) +
    '</div>' +
    '<p class="muted">' + num(t.worker_runs) + ' worker call(s), ' + num(t.worker_tokens) + ' tokens' +
    (t.worker_priced ? ', $' + t.worker_cost_usd.toFixed(4) : ' (unpriced model)') + ' to turn that history into state.</p>';

  const check = (ok, text) => '<li><span class="mark' + (ok ? '' : ' warn') + '">' + (ok ? '&check;' : '!') + '</span><span>' + text + '</span></li>';
  html += '<h2>Continuity</h2><ul class="checks">' +
    check(c.recovery_ready, c.recovery_ready
      ? 'If the agent compacted right now, there is enough derived state to continue from.'
      : 'Not ready to recover: ' + esc(c.recovery_blockers.join('; '))) +
    check(c.hard_compactions === 0, c.hard_compactions === 0
      ? 'The agent has never had to compact on its own.'
      : 'The agent compacted ' + num(c.hard_compactions) + ' time(s) anyway' +
        (dl.bootstrap > 0 ? '; memory was there to resume from.' : ', and no session start has been served from memory yet.')) +
    check(c.hook_p95_ms == null || c.hook_p95_ms <= c.hook_budget_ms, c.hook_p95_ms == null
      ? 'No hook latency measured yet.'
      : 'Invisible to the agent: hooks answer in ' + Math.round(c.hook_p95_ms) + 'ms at p95, budget ' + c.hook_budget_ms + 'ms.') +
    check(dl.total > 0, num(dl.resumes) + ' resume(s) from memory and ' + num(dl.query) + ' targeted quer' + (dl.query === 1 ? 'y' : 'ies') +
      ' served from memory across ' + num(c.sessions) + ' session(s).') +
    '</ul>';

  html += '<h2>Guarantees enforced in code</h2><ul class="checks">' +
    check(true, num(pr.attributions_refused) + ' patch(es) where a worker claimed the user said something it could not cite &mdash; downgraded to agent.') +
    check(true, num(pr.invented_operations_dropped) + ' patch(es) that referenced invented ids &mdash; the invented part dropped, the rest kept.') +
    check(true, num(pr.rejected_patches) + ' worker output(s) rejected outright; their events stayed pending instead of being lost.') +
    check(q.used_share >= 0.5, pct(q.used_share) + ' of active memory has been served to an agent at least once; ' +
      num(q.retired_items) + ' item(s) retired as wrong or superseded, kept in the patch log.') +
    '</ul>';

  if (b.caveats.length) {
    html += '<h2>Read these numbers with</h2><div class="caveats"><ul>' +
      b.caveats.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul></div>';
  }
  return html;
}

async function drawOverview() {
  const d = await get('/api/overview');
  const m = d.metrics;
  const p = m.lifecycle.pressure;
  let html = '<div class="tiles">' +
    tile('Active context', num(m.context.active_tokens) + '<span class="muted" style="font-size:13px"> / ' + num(m.context.budget) + '</span>', 'tokens in the bootstrap', m.context.active_tokens / m.context.budget) +
    tile('Effective reduction', pct(m.context.effective_reduction), 'token ratio x coverage', m.context.effective_reduction) +
    tile('Coverage', pct(m.context.coverage), num(m.events.pending) + ' events pending', m.context.coverage) +
    tile('Memory', num(m.memory.active), num(m.memory.items) + ' total, v' + m.memory.state_version) +
    tile('Relations', num(d.edges), d.embeddings.enabled ? num(d.embeddings.count) + ' vectors' : 'embeddings off') +
    tile('Worker cost', '$' + (m.workers.cost_usd || 0).toFixed(4), num(m.workers.runs) + ' runs, ' + num(m.workers.invalid) + ' invalid') +
    tile('Contradictions', num(d.conflicts), d.conflicts ? 'run contextd reconcile' : 'none detected') +
    tile('Agent peak context', num(m.agent.peak_input_tokens), num(m.agent.turns) + ' turns observed') +
    tile('Context pressure', p.ratio == null ? '--' : pct(p.ratio),
         p.ratio == null ? 'no agent turn observed' : 'stage ' + esc(p.stage) + ', window ' + esc(p.window_source),
         p.ratio == null ? 0 : p.ratio) +
    '</div>';

  html += '<h2>Compaction ladder</h2>' + table(['signal', 'value'], [
    ['stage', esc(p.stage) + ' <span class="muted">(' + esc(p.reasons.join(', ')) + ')</span>'],
    ['authorised now', p.actions.length ? esc(p.actions.join(', ')) : '<span class="muted">nothing</span>'],
    ['occupancy', p.ratio == null ? '<span class="muted">unobserved</span>'
      : num(p.occupied_tokens) + ' / ' + num(p.window_tokens) + ' tokens'],
    ['recovery (K5)', p.recovery_ready ? 'ready'
      : '<span class="tag critical">not ready</span> ' + esc(p.recovery_blockers.join('; '))],
    ['hard compactions', num(m.lifecycle.hard_compactions) +
      '<span class="muted"> times the agent compacted anyway</span>'],
  ]);

  if (m.latency.hook || m.latency.ingest) {
    const rows = [['hook', m.latency.hook], ['ingest', m.latency.ingest]]
      .filter(([, s]) => s)
      .map(([label, s]) => [esc(label), num(Math.round(s.p50)) + 'ms', num(Math.round(s.p95)) + 'ms',
        num(Math.round(s.max)) + 'ms', num(s.count)]);
    html += '<h2>Latency vs ' + m.latency.budget_ms + 'ms budget' +
      (m.latency.within_budget === false ? ' <span class="tag critical">over</span>' : '') + '</h2>' +
      table(['op', 'p50', 'p95', 'max', 'samples'], rows);
  }

  html += '<h2>Memory precision</h2>' + table(['signal', 'share'], [
    ['never retrieved', pct(m.precision.never_retrieved_ratio)],
    ['short lived', pct(m.precision.short_lived_ratio)],
    ['low confidence', pct(m.precision.low_confidence_ratio)],
    ['unverified', pct(m.precision.unverified_ratio)],
  ]);

  const trend = neverRetrievedChart(d.never_retrieved_history || []);
  html += '<h2>Never retrieved over time</h2>' +
    '<p class="muted" style="margin:-4px 0 10px">Share of memory items never served to an agent &mdash; lower is better. ' +
    'Rebuilt from the retrieval log, so history starts with the first item.</p>' + trend.html;

  html += '<h2>Sessions</h2>' + table(['started', 'source', 'events', 'id'],
    d.sessions.map((s) => [esc(s.started_at), esc(s.source), num(s.events),
      '<code>' + esc(s.id) + '</code>']));
  return { html, after: trend.wire };
}

/**
 * A step line, not a sloped one: the ratio only moves when an item is created or first served,
 * and holds exactly between those instants. Interpolating would invent values that never existed.
 */
let chartPointer = null;

function neverRetrievedChart(points) {
  if (points.length < 2) {
    return { html: '<div class="empty">not enough history yet</div>', wire() {} };
  }
  // Draw at the panel's real width so text stays 11px instead of scaling with the viewBox;
  // the overview redraws on a timer, which also picks up a resize.
  const W = Math.max(300, Math.min(960, panel.clientWidth - 38)), H = 200, L = 40, R = 60, T = 12, B = 26;
  const ratio = (p) => (p.total ? p.never / p.total : 0);
  const t0 = Date.parse(points[0].at);
  // Run to now: the last value still holds, and ending at the last change hides how long it has.
  // Rounded to the minute, or the markup would differ on every refresh and always repaint.
  const t1 = Math.max(Date.parse(points[points.length - 1].at), Math.ceil(Date.now() / 60e3) * 60e3);
  const span = Math.max(1, t1 - t0);
  const x = (t) => L + ((t - t0) / span) * (W - L - R);
  const y = (r) => T + (1 - r) * (H - T - B);
  const xs = points.map((p) => x(Date.parse(p.at)));
  const ys = points.map((p) => y(ratio(p)));

  let path = 'M' + xs[0].toFixed(1) + ' ' + ys[0].toFixed(1);
  for (let i = 1; i < points.length; i += 1) path += 'H' + xs[i].toFixed(1) + 'V' + ys[i].toFixed(1);
  path += 'H' + x(t1).toFixed(1);

  const when = (t) => {
    const dt = new Date(t);
    return span < 36 * 3600e3
      ? dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };
  let grid = '';
  for (const r of [0, 0.25, 0.5, 0.75, 1]) {
    grid += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + y(r) + '" y2="' + y(r) +
      '" stroke="var(--line)" stroke-width="1"/>' +
      '<text x="' + (L - 8) + '" y="' + (y(r) + 4) + '" text-anchor="end" fill="var(--muted)" font-size="11">' +
      r * 100 + '%</text>';
  }
  for (const [t, anchor] of [[t0, 'start'], [t0 + span / 2, 'middle'], [t1, 'end']]) {
    grid += '<text x="' + x(t) + '" y="' + (H - 6) + '" text-anchor="' + anchor +
      '" fill="var(--muted)" font-size="11">' + esc(when(t)) + '</text>';
  }

  const last = points[points.length - 1];
  const lx = x(t1), ly = ys[ys.length - 1];
  const svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="never retrieved share over time, now ' +
    pct(ratio(last)) + '">' + grid +
    '<path d="' + path + '" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>' +
    '<circle cx="' + lx + '" cy="' + ly + '" r="4" fill="var(--accent)" stroke="var(--panel)" stroke-width="2"/>' +
    '<text x="' + (lx + 8) + '" y="' + (ly + 4) + '" fill="var(--ink)" font-size="12">' + pct(ratio(last)) + '</text>' +
    '<line class="xh" y1="' + T + '" y2="' + (H - B) + '" stroke="var(--muted)" stroke-width="1" visibility="hidden"/>' +
    '<circle class="xd" r="4" fill="var(--accent)" stroke="var(--panel)" stroke-width="2" visibility="hidden"/>' +
    '<rect class="hit" x="' + L + '" y="0" width="' + (W - L - R) + '" height="' + H + '" fill="transparent"/>' +
    '</svg>';

  const rows = points.slice(-30).reverse().map((p) => [
    '<span class="mono">' + esc(new Date(p.at).toLocaleString()) + '</span>',
    pct(ratio(p)), num(p.never) + ' / ' + num(p.total),
  ]);
  const html = '<div class="chart" id="nr-chart">' + svg + '<div class="tip"></div></div>' +
    '<details><summary>data (last ' + rows.length + ' changes)</summary>' +
    table(['changed at', 'never retrieved', 'items'], rows) + '</details>';

  function wire() {
    const box = document.getElementById('nr-chart');
    if (!box) return;
    const el = box.querySelector('svg'), tip = box.querySelector('.tip');
    const xh = el.querySelector('.xh'), xd = el.querySelector('.xd');
    const hide = () => { tip.style.display = 'none'; xh.setAttribute('visibility', 'hidden'); xd.setAttribute('visibility', 'hidden'); };
    el.addEventListener('pointerleave', () => { chartPointer = null; hide(); });
    el.addEventListener('pointermove', (ev) => {
      chartPointer = { clientX: ev.clientX, clientY: ev.clientY };
      const rect = el.getBoundingClientRect();
      const vx = ((ev.clientX - rect.left) / rect.width) * W;
      if (vx < L || vx > W - R) { hide(); return; }
      // The value under the pointer is the step that began at or before it.
      let i = 0;
      while (i + 1 < xs.length && xs[i + 1] <= vx) i += 1;
      const p = points[i];
      xh.setAttribute('x1', xs[i]); xh.setAttribute('x2', xs[i]); xh.setAttribute('visibility', 'visible');
      xd.setAttribute('cx', xs[i]); xd.setAttribute('cy', ys[i]); xd.setAttribute('visibility', 'visible');
      const sx = rect.width / W;
      tip.innerHTML = '<b>' + pct(ratio(p)) + '</b> never retrieved<br><span class="muted">' +
        num(p.never) + ' of ' + num(p.total) + ' items &middot; ' + esc(new Date(p.at).toLocaleString()) + '</span>';
      tip.style.display = 'block';
      const half = tip.offsetWidth / 2;
      tip.style.left = Math.min(rect.width - half, Math.max(half, xs[i] * sx)) + 'px';
      tip.style.top = (ys[i] * sx - 10) + 'px';
    });
    // The x axis runs to now, so the chart repaints on every refresh; put the tooltip back.
    if (chartPointer) el.dispatchEvent(new PointerEvent('pointermove', chartPointer));
  }
  return { html, wire };
}

async function drawMemory() {
  const d = await get('/api/memory');
  const groups = {};
  for (const i of d.items) (groups[i.category] ??= []).push(i);
  let html = '<h2>Working memory</h2><pre>' + esc(JSON.stringify(d.working, null, 2)) + '</pre>';
  for (const [cat, items] of Object.entries(groups)) {
    html += '<h2>' + esc(cat) + ' (' + items.length + ')</h2>' +
      table(['statement', 'importance', 'source', 'conf', 'used', 'id'], items.map((i) => [
        esc(i.text) + (i.reason ? '<div class="muted">why: ' + esc(i.reason) + '</div>' : ''),
        impTag(i.importance),
        '<span class="tag ' + (i.source === 'user' ? 'user' : '') + '">' + esc(i.source) + '</span>',
        i.confidence.toFixed(2),
        num(i.retrieved_count),
        '<code>' + esc(i.id) + '</code>',
      ]));
  }
  if (!d.items.length) html += '<div class="empty">no memory recorded yet</div>';
  return html;
}

async function drawConflicts() {
  const list = await get('/api/conflicts');
  if (!list.length) return '<div class="empty">no contradictions detected</div>';
  return '<h2>' + list.length + ' contradiction(s)</h2>' + list.map((c, n) =>
    '<div class="pair"><div class="muted">' + (n + 1) + '. ' + esc(c.reason) +
    ' · similarity ' + c.similarity.toFixed(2) + ' · ' +
    esc(c.a.category === c.b.category ? c.a.category : c.a.category + ' vs ' + c.b.category) + '</div>' +
    [c.a, c.b].map((s) => '<div class="side">' + impTag(s.importance) + ' ' +
      '<span class="tag ' + (s.source === 'user' ? 'user' : '') + '">' + esc(s.source) + '</span> ' +
      (s.id === c.newer ? '<span class="tag">newer</span> ' : '') +
      esc(s.text) + ' <code>' + esc(s.id) + '</code></div>').join('') +
    '</div>').join('');
}

async function drawGraph() {
  const d = await get('/api/graph');
  if (!d.edges.length) {
    return '<div class="empty">no relations recorded yet<br>' +
      '<span class="mono">workers add these as they extract memory</span></div>';
  }
  // Circular layout: no layout library, and the graph is small enough to read this way.
  const R = 150, cx = 200, cy = 190;
  const pos = {};
  d.nodes.forEach((nd, i) => {
    const a = (i / d.nodes.length) * Math.PI * 2 - Math.PI / 2;
    pos[nd.id] = { x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) };
  });
  const lines = d.edges.map((e) => {
    const p = pos[e.from], q = pos[e.to];
    if (!p || !q) return '';
    return '<line x1="' + p.x + '" y1="' + p.y + '" x2="' + q.x + '" y2="' + q.y +
      '" stroke="#3a4452" stroke-width="1"><title>' + esc(e.kind) + '</title></line>';
  }).join('');
  const dots = d.nodes.map((nd) => {
    const p = pos[nd.id];
    const fill = nd.importance === 'critical' ? '#e06c75' : nd.importance === 'high' ? '#e0a33e' : '#6ea8fe';
    return '<circle cx="' + p.x + '" cy="' + p.y + '" r="5" fill="' + fill + '"><title>' +
      esc(nd.category + ': ' + nd.text) + '</title></circle>';
  }).join('');
  return '<h2>' + d.nodes.length + ' linked items, ' + d.edges.length + ' relations</h2>' +
    '<svg viewBox="0 0 400 380" width="400" height="380" role="img" aria-label="memory relation graph">' +
    lines + dots + '</svg>' +
    '<h2>Relations</h2>' + table(['from', 'kind', 'to', 'why'], d.edges.map((e) => [
      '<code>' + esc(e.from) + '</code>', '<span class="tag">' + esc(e.kind) + '</span>',
      '<code>' + esc(e.to) + '</code>', esc(e.reason || ''),
    ]));
}

async function drawContext() {
  const q = sessionStorage.getItem('ctxq') || '';
  panel.innerHTML = '<div class="row"><input type="search" id="q" placeholder="what are you about to work on?" value="' +
    esc(q) + '"></div><div id="ctxout"><div class="empty">loading…</div></div>';
  const input = document.getElementById('q');
  const run = async () => {
    sessionStorage.setItem('ctxq', input.value);
    const d = await get('/api/context' + (input.value ? '?q=' + encodeURIComponent(input.value) : ''));
    document.getElementById('ctxout').innerHTML =
      '<div class="row"><span class="tag">' + d.tokens + ' / ' + d.budget + ' tokens</span>' +
      '<span class="tag">' + d.itemIds.length + ' items</span></div>' +
      '<pre>' + esc(d.text || '(nothing recorded yet)') + '</pre>';
  };
  let t; input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(run, 250); });
  await run();
}

async function drawEvents() {
  const list = await get('/api/events?limit=200');
  return '<h2>' + list.length + ' most recent events</h2>' +
    table(['time', 'type', 'importance', 'action', 'preview'], list.map((e) => [
      '<span class="mono">' + esc(e.timestamp.slice(11, 19)) + '</span>',
      esc(e.type), impTag(e.importance),
      esc(e.action) + (e.processed ? '' : ' <span class="tag warn">pending</span>'),
      '<span class="mono">' + esc(e.preview) + '</span>',
    ]));
}

async function drawPatches() {
  const list = await get('/api/patches');
  return '<h2>Patch log</h2>' +
    table(['version', 'origin', 'operations', 'note'], list.map((p) => [
      'v' + p.base_version + ' &rarr; v' + p.new_version,
      esc(p.origin),
      esc([
        p.patch.add ? '+' + p.patch.add.length : null,
        p.patch.update ? '~' + p.patch.update.length : null,
        p.patch.remove ? '-' + p.patch.remove.length : null,
        p.patch.supersede ? '>' + p.patch.supersede.length : null,
        p.patch.link ? 'link ' + p.patch.link.length : null,
        p.patch.working ? 'working' : null,
      ].filter(Boolean).join(' ') || 'no-op'),
      esc(p.note || ''),
    ]));
}

const DRAW = {
  benefits: drawBenefits, overview: drawOverview, memory: drawMemory, conflicts: drawConflicts,
  graph: drawGraph, context: drawContext, events: drawEvents, patches: drawPatches,
};

/*
 * Tabs return their markup rather than writing it, so a refresh can compare before touching the
 * DOM. Rewriting the panel every few seconds collapsed it to "loading…" and back: the page jumped
 * to the top, open <details> shut, and a tooltip vanished under the pointer. The Context tab is
 * the exception - it owns an input and paints itself, and the timer leaves it alone.
 */
let painted = null;
let drawSeq = 0;
let inFlight = false;

function paint(out) {
  const view = typeof out === 'string' ? { html: out } : out;
  if (view.html === painted) return;
  const open = [...panel.querySelectorAll('details')].map((d) => d.open);
  panel.innerHTML = view.html;
  painted = view.html;
  panel.querySelectorAll('details').forEach((d, i) => { if (open[i]) d.open = true; });
  if (view.after) view.after();
}

async function draw(refresh = false) {
  const seq = ++drawSeq;
  const tab = current;
  if (!refresh) {
    panel.innerHTML = '<div class="empty">loading…</div>';
    painted = null;
  }
  inFlight = true;
  try {
    const out = await (DRAW[tab] || drawBenefits)();
    // A tab switch started a newer draw while this one was fetching; the panel is its now.
    if (seq !== drawSeq) return;
    if (out != null) paint(out);
    document.getElementById('freshness').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch (err) {
    if (seq !== drawSeq) return;
    // A failed background refresh keeps what is on screen; only say so in the header.
    if (refresh) {
      document.getElementById('freshness').textContent = 'refresh failed: ' + err.message;
    } else {
      panel.innerHTML = '<div class="empty">' + esc(err.message) + '</div>';
      painted = null;
    }
  } finally {
    if (seq === drawSeq) inFlight = false;
  }
}

// The header identifies which project this is, so it must be filled whatever tab opens.
get('/api/overview').then((d) => {
  document.getElementById('project').textContent = d.root;
}).catch(() => {});

// The back button and a pasted #tab link must both work, not just clicking a tab.
window.addEventListener('hashchange', () => {
  const next = location.hash.slice(1) || 'benefits';
  if (next === current || !DRAW[next]) return;
  current = next;
  renderTabs();
  draw();
});

renderTabs();
draw();
// The store changes underneath us as the agent works, so refresh on a slow timer.
// Skipped while a draw is still out, so a slow server cannot stack requests up.
setInterval(() => { if (current !== 'context' && !inFlight) draw(true); }, 5000);
</script>
</body>
</html>`;
}
