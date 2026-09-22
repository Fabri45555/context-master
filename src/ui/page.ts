/**
 * The dashboard page (PRD 41).
 *
 * One string, no build step, no CDN. The page is served from loopback by the same process
 * that owns the store, so a dependency on an external asset host would be the only way for
 * this to leak anything.
 *
 * The client script lives inside a template literal: it must contain no backtick and no
 * dollar-brace, and every backslash would need doubling, so it is written without any.
 */
export function renderPage(version = '', appVersion = ''): string {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>contextd</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<script>
  // Before first paint, or a light-theme user sees a dark flash on every load.
  (function () {
    let t = null;
    try { t = localStorage.getItem('contextd-theme'); } catch {}
    if (t !== 'light' && t !== 'dark') {
      t = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    document.documentElement.setAttribute('data-theme', t);
  })();
</script>
<style>
  :root {
    color-scheme: dark;
    --bg: #0c0e11; --surface: #14171c; --surface-2: #1a1e24; --line: #232830; --line-2: #2e343d;
    --ink: #e7e9ec; --ink-2: #bcc2ca; --muted: #858d98; --faint: #5b626c;
    --accent: #4cc2d4; --accent-soft: rgba(76, 194, 212, .13);
    --good: #3fb97a; --warn: #d9a441; --bad: #ef6461;
    --track: #232830;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --r: 10px;
  }
  [data-theme="light"] {
    color-scheme: light;
    --bg: #f5f6f8; --surface: #ffffff; --surface-2: #f1f3f5; --line: #e3e6ea; --line-2: #d2d7dd;
    --ink: #15181c; --ink-2: #3b424b; --muted: #636c78; --faint: #9aa1ab;
    --accent: #087f90; --accent-soft: rgba(8, 127, 144, .09);
    --good: #1a8a4f; --warn: #a66b00; --bad: #c83a37;
    --track: #e8ebee;
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.5 var(--sans); min-height: 100vh; display: flex; flex-direction: column;
  }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  button { font: inherit; color: inherit; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 4px; }
  code, .mono { font-family: var(--mono); font-size: 12px; }
  .num { font-variant-numeric: tabular-nums; }
  .muted { color: var(--muted); }

  /* ---------------------------------------------------------------- header */
  .top {
    position: sticky; top: 0; z-index: 10; background: var(--bg);
    border-bottom: 1px solid var(--line);
  }
  .top-in {
    max-width: 1240px; margin: 0 auto; padding: 12px 24px;
    display: flex; align-items: center; gap: 14px 20px; flex-wrap: wrap;
  }
  .brand { display: flex; align-items: baseline; gap: 10px; min-width: 0; flex: 1 1 0; }
  .brand b { font-size: 16px; letter-spacing: .01em; }
  .brand .ver { font-family: var(--mono); font-size: 11px; color: var(--muted); }
  .brand .path { font-family: var(--mono); font-size: 12px; color: var(--muted);
                 overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .status { display: flex; align-items: center; gap: 10px; position: relative; }
  .fresh { color: var(--muted); font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .fresh.bad { color: var(--warn); }
  .pill {
    display: inline-flex; align-items: center; gap: 7px; background: var(--surface);
    border: 1px solid var(--line); border-radius: 999px; padding: 4px 11px 4px 9px;
    font-size: 12px; cursor: pointer; white-space: nowrap;
  }
  .pill:hover { border-color: var(--line-2); }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--faint); flex: none; display: inline-block; }
  .dot.good { background: var(--good); } .dot.warn { background: var(--warn); } .dot.bad { background: var(--bad); }
  .dot.accent { background: var(--accent); }
  .iconbtn {
    width: 30px; height: 30px; display: inline-grid; place-items: center; cursor: pointer;
    background: var(--surface); border: 1px solid var(--line); border-radius: 8px; color: var(--ink-2);
  }
  .iconbtn:hover { border-color: var(--line-2); color: var(--ink); }
  .iconbtn svg { width: 15px; height: 15px; }
  .iconbtn.spin svg { animation: spin .7s linear; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .pop {
    position: absolute; top: calc(100% + 8px); right: 0; width: min(420px, calc(100vw - 32px));
    background: var(--surface); border: 1px solid var(--line-2); border-radius: var(--r);
    box-shadow: 0 12px 32px rgba(0, 0, 0, .28); padding: 14px 16px; z-index: 20;
    max-height: 70vh; overflow: auto;
  }
  .pop h4 { margin: 0 0 8px; font-size: 13px; }
  .pop ul { list-style: none; margin: 0; padding: 0; }
  .pop li { padding: 9px 0; border-top: 1px solid var(--line); display: grid; grid-template-columns: 12px 1fr; gap: 4px 10px; }
  .pop li .dot { margin-top: 6px; }
  .pop .nm { font-weight: 600; font-size: 13px; }
  .pop .dt { grid-column: 2; color: var(--ink-2); font-size: 12px; overflow-wrap: anywhere; }
  .pop .fx { grid-column: 2; font-size: 12px; color: var(--muted); }
  .pop .fx code { color: var(--ink); }
  .pop .foot { margin-top: 10px; color: var(--muted); font-size: 12px; }

  .seg {
    display: inline-flex; gap: 2px; padding: 3px; background: var(--surface);
    border: 1px solid var(--line); border-radius: 9px; max-width: 100%; overflow-x: auto;
    scrollbar-width: none;
  }
  .seg button {
    border: 0; background: transparent; color: var(--muted); padding: 5px 13px; border-radius: 6px;
    cursor: pointer; font-size: 13px; white-space: nowrap;
  }
  .seg button:hover { color: var(--ink); }
  .seg button[aria-selected="true"] { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
  .seg button kbd { font-family: var(--mono); font-size: 10px; color: var(--faint); margin-left: 6px; }
  .seg button[aria-selected="true"] kbd { color: var(--accent); opacity: .7; }

  /* ------------------------------------------------------------------ main */
  main { flex: 1; width: 100%; max-width: 1240px; margin: 0 auto; padding: 20px 24px 40px; }
  .bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .bar:empty { display: none; }
  .bar .seg.sub { font-size: 12px; }
  #tools { flex: 1 1 260px; display: flex; justify-content: flex-end; }
  #tools:empty { display: none; }
  .search {
    width: 100%; max-width: 380px; background: var(--surface); border: 1px solid var(--line);
    color: var(--ink); border-radius: 8px; padding: 7px 11px; font: inherit; font-size: 13px;
  }
  .search::placeholder { color: var(--faint); }
  .search:focus { border-color: var(--accent); outline: none; }
  .caption { color: var(--muted); font-size: 12px; margin: 10px 0 16px; }

  .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); align-items: stretch; }
  .grid > *, .relgrid > * { margin: 0 !important; }
  .grid + .grid, .grid + .card, .card + .card, .card + .grid, .kpis + .grid, .card + details, .grid + details { margin-top: 14px; }
  .span-2 { grid-column: span 2; }
  .card {
    background: var(--surface); border: 1px solid var(--line); border-radius: var(--r);
    padding: 16px 18px; min-width: 0;
  }
  .card-h { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
  .card-h h3 { margin: 0; font-size: 13px; font-weight: 600; }
  .card-h .meta { color: var(--muted); font-size: 12px; text-align: right; }
  .note { color: var(--muted); font-size: 12px; margin: 12px 0 0; }

  .kpis { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); }
  .kpi { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); padding: 15px 18px; }
  .kpi .l { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .07em; }
  .kpi .v { font-size: 28px; font-weight: 600; line-height: 1.2; margin-top: 6px; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
  .kpi .v small { font-size: 14px; font-weight: 500; color: var(--muted); margin-left: 4px; }
  .kpi .v.good { color: var(--good); }
  .kpi .s { color: var(--muted); font-size: 12px; margin-top: 4px; }

  .kv { margin: 0; }
  .kv > div { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; padding: 5px 0; }
  .kv > div + div { border-top: 1px solid var(--line); }
  .kv dt { color: var(--ink-2); font-size: 13px; }
  .kv dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; font-size: 13px; min-width: 0; overflow-wrap: anywhere; }
  .kv dd small { color: var(--muted); font-size: 12px; }
  .good-t { color: var(--good); } .warn-t { color: var(--warn); } .bad-t { color: var(--bad); }

  .hb + .hb { margin-top: 10px; }
  .hb .row { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; }
  .hb .row span:first-child { color: var(--ink-2); }
  .hb .row b { font-weight: 500; font-variant-numeric: tabular-nums; }
  .hb .row b small { color: var(--muted); font-weight: 400; }
  .track { height: 6px; background: var(--track); border-radius: 3px; overflow: hidden; margin-top: 5px; }
  .track.tall { height: 10px; border-radius: 4px; }
  .fill { height: 100%; background: var(--accent); min-width: 2px; border-radius: inherit; }
  .fill.good { background: var(--good); } .fill.warn { background: var(--warn); } .fill.bad { background: var(--bad); }
  .fill.dim { background: var(--faint); }

  .checks { list-style: none; margin: 0; padding: 0; }
  .checks > li + li { border-top: 1px solid var(--line); }
  .checks details > summary, .checks .plain {
    display: flex; align-items: center; gap: 10px; padding: 7px 0; font-size: 13px; list-style: none; cursor: pointer;
  }
  .checks .plain { cursor: default; }
  .checks summary::-webkit-details-marker { display: none; }
  .checks .lbl { flex: 1; color: var(--ink-2); min-width: 0; }
  .checks .val { font-variant-numeric: tabular-nums; text-align: right; }
  .checks .why { color: var(--muted); font-size: 12px; padding: 0 0 9px 18px; }
  .chev { color: var(--faint); font-size: 11px; transition: transform .15s; }
  details[open] > summary .chev { transform: rotate(90deg); }

  .chip {
    display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border-radius: 999px;
    font-size: 11px; border: 1px solid var(--line-2); color: var(--muted); white-space: nowrap; line-height: 17px;
  }
  .chip.bad { color: var(--bad); border-color: color-mix(in srgb, var(--bad) 45%, transparent); }
  .chip.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); }
  .chip.good { color: var(--good); border-color: color-mix(in srgb, var(--good) 45%, transparent); }
  .chip.accent { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
  .chip.solid { background: var(--accent-soft); }
  .chip.mono { font-family: var(--mono); font-size: 10.5px; }

  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 14px; }
  .chips button {
    border: 1px solid var(--line); background: var(--surface); color: var(--ink-2); border-radius: 999px;
    padding: 3px 11px; font-size: 12px; cursor: pointer;
  }
  .chips button span { color: var(--muted); margin-left: 5px; font-variant-numeric: tabular-nums; }
  .chips button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
  .chips button[aria-pressed="true"] span { color: var(--accent); }

  .group { font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--muted);
           font-weight: 600; margin: 18px 0 6px; }
  .group:first-child { margin-top: 0; }
  .rows { border: 1px solid var(--line); border-radius: var(--r); background: var(--surface); overflow: hidden; }
  .rows > details + details { border-top: 1px solid var(--line); }
  .rows summary {
    display: flex; align-items: center; gap: 10px; padding: 9px 14px; cursor: pointer; list-style: none; min-width: 0;
  }
  .rows summary::-webkit-details-marker { display: none; }
  .rows summary:hover { background: var(--surface-2); }
  .rows .main { flex: 1; min-width: 0; }
  .rows .clip { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .rows .one { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rows .side { display: flex; align-items: center; gap: 6px; flex: none; }
  .rows .t { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; flex: none; min-width: 58px; }
  .rows .used { color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; min-width: 34px; text-align: right; }
  .rows.fixed .side { width: 220px; }
  .rows.patches .side { width: 250px; }
  .rows .more { padding: 4px 14px 14px 14px; border-top: 1px dashed var(--line); background: var(--surface-2); }
  .kv.wm > div { justify-content: flex-start; }
  .kv.wm dt { width: 110px; flex: none; color: var(--muted); }
  .kv.wm dd { text-align: left; }
  .rows .more .kv { max-width: 640px; }
  .rows .more .kv dd { text-align: left; }
  .rows .more .kv > div { justify-content: flex-start; }
  .rows .more .kv dt { width: 110px; flex: none; color: var(--muted); }
  .pre {
    font-family: var(--mono); font-size: 12px; white-space: pre-wrap; word-break: break-word;
    background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; margin: 10px 0 4px;
  }
  .ops { list-style: none; margin: 8px 0 0; padding: 0; font-size: 12.5px; }
  .ops li { padding: 3px 0; display: flex; gap: 8px; }
  .ops li b { font-family: var(--mono); font-weight: 600; flex: none; width: 58px; color: var(--muted); }
  .ops li span { min-width: 0; overflow-wrap: anywhere; }

  .scroll { overflow-x: auto; margin: 0 -18px; padding: 0 18px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: var(--muted); font-weight: 500; font-size: 11px; text-transform: uppercase;
       letter-spacing: .06em; padding: 0 10px 8px 0; border-bottom: 1px solid var(--line); white-space: nowrap; }
  td { padding: 8px 10px 8px 0; border-bottom: 1px solid var(--line); vertical-align: middle; white-space: nowrap; }
  tr:last-child td { border-bottom: 0; }
  th:last-child, td:last-child { padding-right: 0; }
  th.r, td.r { text-align: right; font-variant-numeric: tabular-nums; }
  td .track { width: 80px; margin: 0; display: inline-block; vertical-align: middle; }

  .now { display: grid; grid-template-columns: 1fr auto; gap: 6px 16px; align-items: start; }
  .now .task { font-size: 14px; font-weight: 500; line-height: 1.45; }
  .now .sub { grid-column: 1 / -1; color: var(--ink-2); font-size: 13px; }
  .now .sub b { color: var(--muted); font-weight: 500; margin-right: 6px; }
  .now .plan { grid-column: 1 / -1; margin: 4px 0 0; padding-left: 20px; color: var(--ink-2); font-size: 13px; }

  .empty { text-align: center; padding: 30px 16px; color: var(--muted); }
  .empty p { margin: 0 0 8px; }
  .empty code { display: inline-block; background: var(--surface-2); border: 1px solid var(--line); color: var(--ink);
                border-radius: 6px; padding: 4px 9px; max-width: 100%; overflow-wrap: anywhere; white-space: normal; }
  .card .empty { padding: 18px 8px; }
  .rows .empty, .rows > .empty { padding: 26px 16px; }

  .pair + .pair { margin-top: 12px; }
  .pair .side { display: flex; gap: 10px; padding: 9px 0; align-items: flex-start; }
  .pair .side + .side { border-top: 1px solid var(--line); }
  .pair .side .tx { flex: 1; min-width: 0; }
  .pair .side .chips-in { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 5px; }

  .graph svg { display: block; width: 100%; max-width: 440px; height: auto; margin: 0 auto; }
  .relgrid { display: grid; gap: 14px; grid-template-columns: minmax(0, 400px) minmax(0, 1fr); align-items: start; }
  .rel { padding: 10px 0; font-size: 13px; }
  .rel + .rel { border-top: 1px solid var(--line); }
  .rel .to { display: flex; gap: 8px; align-items: baseline; margin-top: 4px; color: var(--ink-2); }
  .rel .to .chip { flex: none; }
  .rel .why { color: var(--muted); font-size: 12px; margin-top: 4px; }

  .chart { position: relative; }
  .chart svg { display: block; width: 100%; height: auto; touch-action: pan-y; }
  .chart .tip { position: absolute; display: none; pointer-events: none; transform: translate(-50%, -100%);
                background: var(--surface); border: 1px solid var(--line-2); border-radius: 6px;
                padding: 6px 9px; font-size: 12px; white-space: nowrap; box-shadow: 0 6px 18px rgba(0,0,0,.2); }
  .chart .tip b { font-variant-numeric: tabular-nums; }
  details.more-data > summary, details.howto > summary {
    cursor: pointer; color: var(--muted); font-size: 12px; margin: 12px 0 4px; list-style: none;
  }
  details.more-data > summary::-webkit-details-marker, details.howto > summary::-webkit-details-marker { display: none; }
  details.howto { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); padding: 4px 18px; }
  details.howto > summary { margin: 8px 0; font-size: 13px; color: var(--ink-2); }
  details.howto ul { margin: 4px 0 14px; padding-left: 18px; color: var(--ink-2); font-size: 13px; }
  details.howto li { margin: 5px 0; }

  footer { border-top: 1px solid var(--line); }
  .foot-in { max-width: 1240px; margin: 0 auto; padding: 14px 24px; display: flex; justify-content: space-between;
             gap: 12px; flex-wrap: wrap; color: var(--muted); font-size: 12px; }
  kbd { font-family: var(--mono); font-size: 11px; background: var(--surface); border: 1px solid var(--line-2);
        border-bottom-width: 2px; border-radius: 4px; padding: 0 5px; color: var(--ink-2); }

  @media (max-width: 760px) {
    .span-2 { grid-column: auto; }
    .grid, .relgrid { grid-template-columns: 1fr; }
  }
  @media (max-width: 640px) {
    .top-in { padding: 10px 16px; gap: 10px; }
    main { padding: 14px 16px 32px; }
    .foot-in { padding: 12px 16px; }
    .brand { flex-basis: 100%; }
    .status { flex: 1; justify-content: flex-end; }
    #views { order: 3; width: 100%; }
    #views button { flex: 1; padding: 6px 8px; }
    #views button kbd { display: none; }
    .kpis { grid-template-columns: 1fr 1fr; gap: 10px; }
    .kpi { padding: 12px 14px; }
    .kpi .v { font-size: 22px; }
    .card { padding: 14px; }
    .scroll { margin: 0 -14px; padding: 0 14px; }
    .rows summary { flex-wrap: wrap; padding: 9px 12px; }
    .rows .main { flex-basis: 100%; order: -1; }
    .rows.fixed .side, .rows.patches .side { width: auto; }
    .rows .more .kv dt, .kv.wm dt { width: 90px; }
    #tools { flex-basis: 100%; }
    .search { max-width: none; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
  }
</style>
</head>
<body>
<header class="top">
  <div class="top-in">
    <div class="brand">
      <b>contextd</b><span class="ver" id="ver"></span>
      <span class="path" id="project"></span>
    </div>
    <nav class="seg" id="views" role="tablist" aria-label="Views"></nav>
    <div class="status">
      <button class="pill" id="health" aria-haspopup="true" aria-expanded="false" title="Health checks, as in contextd doctor">
        <i class="dot"></i><span>Checking</span>
      </button>
      <div class="pop" id="health-pop" hidden></div>
      <span class="fresh" id="freshness" aria-live="polite"></span>
      <button class="iconbtn" id="refresh" title="Refresh (R)" aria-label="Refresh">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 8a5.5 5.5 0 1 1-1.7-4"/><path d="M13.5 2.5v3h-3"/></svg>
      </button>
      <button class="iconbtn" id="theme" title="Switch theme" aria-label="Switch theme">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="8" cy="8" r="3.2"/><path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M3.2 12.8l1.1-1.1M11.7 4.3l1.1-1.1"/></svg>
      </button>
    </div>
  </div>
</header>
<main>
  <div class="bar" id="bar"><nav class="seg sub" id="subnav" role="tablist" aria-label="Sections"></nav><div id="tools"></div></div>
  <p class="caption" id="caption"></p>
  <div id="panel"><div class="empty">loading…</div></div>
</main>
<footer>
  <div class="foot-in">
    <span>Press <kbd>R</kbd> to refresh · <kbd>1</kbd>–<kbd>4</kbd> switch views · <kbd>/</kbd> search memory</span>
    <a href="https://github.com/Fabri45555/context-master#readme" target="_blank" rel="noopener noreferrer">Documentation</a>
  </div>
</footer>
<script>
/*
 * The page is one long-lived script that only ever refetches data, so after a rebuild an open
 * tab keeps running the old code against the new server: the fix that stopped refreshes from
 * rebuilding the panel shipped, and a tab opened earlier kept rebuilding it. The server stamps every response
 * with the version of the page it would serve now; on a mismatch, reload once for that version.
 */
const PAGE_VERSION = ${JSON.stringify(version)};
const APP_VERSION = ${JSON.stringify(appVersion)};
const panel = document.getElementById('panel');
const $ = (id) => document.getElementById(id);
if (APP_VERSION) $('ver').textContent = 'v' + APP_VERSION;

const VIEWS = [
  { id: 'overview', label: 'Overview',
    caption: 'What memory is worth to this project, and whether it is holding up. Every figure covers all sessions.' },
  { id: 'memory', label: 'Memory', subs: [
    ['items', 'Items', 'The project state an agent is served: working memory, then every active item. Click a row for its reason and provenance.'],
    ['conflicts', 'Conflicts', 'Pairs of active items that may say incompatible things.'],
    ['relations', 'Relations', 'Typed links between items: what motivates, depends on or refines what.'],
    ['context', 'Context preview', 'What an agent would be served for a query. A preview is not a retrieval: it records nothing.'],
  ] },
  { id: 'history', label: 'History',
    caption: 'How memory use has developed, and the agent sessions it was built from.' },
  { id: 'activity', label: 'Activity', subs: [
    ['events', 'Events', 'The most recent events observed from the agent, newest first. Click a row for the full preview.'],
    ['patches', 'Patch log', 'Every change to memory, newest first. The patch log is the source of truth; memory is its replay.'],
  ] },
];
// Links and bookmarks from the eight-tab dashboard must still land somewhere sensible.
const LEGACY = {
  benefits: 'overview', conflicts: 'memory/conflicts', graph: 'memory/relations', context: 'memory/context',
  events: 'activity/events', patches: 'activity/patches', sessions: 'history', items: 'memory/items',
};

function parseHash(h) {
  let key = String(h || '').replace(/^#/, '');
  key = LEGACY[key] || key;
  const parts = key.split('/');
  const view = VIEWS.find((x) => x.id === parts[0]) || VIEWS[0];
  const sub = view.subs ? (view.subs.find((x) => x[0] === parts[1]) || view.subs[0])[0] : null;
  return { view: view.id, sub };
}
const keyOf = (r) => (r.sub ? r.view + '/' + r.sub : r.view);
let route = parseHash(location.hash);
if (location.hash && location.hash.slice(1) !== keyOf(route)) history.replaceState(null, '', '#' + keyOf(route));

// ------------------------------------------------------------------ helpers
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '–');
const pct = (x) => (typeof x === 'number' ? (x * 100).toFixed(1) + '%' : '–');
const ms = (x) => (typeof x === 'number' ? Math.round(x).toLocaleString('en-US') + 'ms' : '–');
const plural = (n, one, many) => num(n) + ' ' + (n === 1 ? one : (many || one + 's'));

function times(x) {
  if (x == null) return '–';
  return (x >= 100 ? Math.round(x).toLocaleString('en-US') : x.toFixed(1)) + '×';
}
function compact(n) {
  if (typeof n !== 'number') return '–';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
  if (n >= 1e4) return Math.round(n / 1e3) + 'k';
  return num(n);
}
/*
 * Coarse on purpose: the panel is only repainted when its markup changes, so a clock that ticks
 * every second would repaint every refresh. Minutes are as fine as anyone reads a log anyway.
 */
function rel(iso) {
  if (!iso) return '–';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return esc(iso);
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  if (s < 7 * 86400) return Math.floor(s / 86400) + 'd ago';
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
const full = (iso) => (iso ? new Date(iso).toLocaleString() : '');
const when = (iso) => '<time datetime="' + esc(iso) + '" title="' + esc(full(iso)) + '">' + rel(iso) + '</time>';
function shortId(id) {
  const s = String(id ?? '');
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s)) return s.slice(0, 8);
  return s.length > 14 ? s.slice(0, 12) + '…' : s;
}
const idTag = (id) => '<code title="' + esc(id) + '">' + esc(shortId(id)) + '</code>';

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

// --------------------------------------------------------------- components
function card(title, body, meta, cls) {
  return '<section class="card' + (cls ? ' ' + cls : '') + '"><div class="card-h"><h3>' + title + '</h3>' +
    (meta ? '<span class="meta">' + meta + '</span>' : '') + '</div>' + body + '</section>';
}
function kv(rows) {
  return '<dl class="kv">' + rows.filter(Boolean).map((r) =>
    '<div' + (r[3] ? ' title="' + esc(r[3]) + '"' : '') + '><dt>' + r[0] + '</dt><dd' +
    (r[2] ? ' class="' + r[2] + '"' : '') + '>' + r[1] + '</dd></div>').join('') + '</dl>';
}
function kpi(label, value, sub, tone, title) {
  return '<div class="kpi"' + (title ? ' title="' + esc(title) + '"' : '') + '><div class="l">' + label +
    '</div><div class="v' + (tone ? ' ' + tone : '') + '">' + value + '</div><div class="s">' + sub + '</div></div>';
}
function hbar(label, value, frac, tone, tall) {
  const w = Math.max(0.4, Math.min(1, frac || 0) * 100);
  return '<div class="hb"><div class="row"><span>' + label + '</span><b>' + value + '</b></div>' +
    '<div class="track' + (tall ? ' tall' : '') + '"><div class="fill' + (tone ? ' ' + tone : '') +
    '" style="width:' + w.toFixed(2) + '%"></div></div></div>';
}
/* A status row: the terse label always, the long explanation one click away (a tooltip is invisible on touch). */
function check(key, tone, label, value, why) {
  const head = '<i class="dot ' + tone + '"></i><span class="lbl">' + label + '</span><span class="val">' + value + '</span>';
  if (!why) return '<li><div class="plain">' + head + '<span class="chev" style="visibility:hidden">›</span></div></li>';
  return '<li><details data-k="' + esc(key) + '"><summary>' + head + '<span class="chev">›</span></summary>' +
    '<div class="why">' + why + '</div></details></li>';
}
function empty(msg, cmd) {
  return '<div class="empty"><p>' + msg + '</p>' + (cmd ? '<code>' + esc(cmd) + '</code>' : '') + '</div>';
}
function chip(text, tone, title) {
  return '<span class="chip' + (tone ? ' ' + tone : '') + '"' + (title ? ' title="' + esc(title) + '"' : '') + '>' + esc(text) + '</span>';
}
const IMP_TONE = { critical: 'bad', high: 'warn' };
const impChip = (i) => chip(i, IMP_TONE[i] || '', 'importance');
const srcChip = (s) => chip(s, s === 'user' ? 'accent' : '', 'source');
const STATUS_TONE = { in_progress: 'accent', blocked: 'bad', review: 'warn', done: 'good', planning: '' };
const ATTACH = 'contextd attach --adapter claude --transcript <file>';

// ---------------------------------------------------------------- overview
function nowCard(w) {
  if (!w || !w.current_task) {
    return card('Current task', empty('No task recorded. Set one so the next session starts from it:',
      'contextd task "<what you are doing>" --status in_progress'));
  }
  const status = w.task_status || 'unknown';
  return card('Current task',
    '<div class="now"><div class="task">' + esc(w.current_task) + '</div>' +
    '<div>' + chip(status.replace('_', ' '), STATUS_TONE[status] || '') + '</div>' +
    (w.next_action ? '<div class="sub"><b>Next</b>' + esc(w.next_action) + '</div>' : '') + '</div>',
    'updated ' + when(w.updated_at) + ' · <a href="#memory/items">working memory</a>');
}

async function drawOverview() {
  const [bd, d] = await Promise.all([get('/api/benefits'), get('/api/overview')]);
  const b = bd.benefits, m = d.metrics;
  const r = b.resume, dl = b.delivery, t = b.triage, pr = b.protection, c = b.continuity, q = b.quality;
  const p = m.lifecycle.pressure;

  let html = '<div class="kpis">';
  html += r.smaller_by != null
    ? kpi('Resume size', times(r.smaller_by) + '<small>smaller</small>',
        num(r.bootstrap_tokens) + ' tokens vs a ' + compact(r.agent_peak_tokens) + ' peak', 'good',
        'A size comparison, not a saving: nobody would re-read the whole conversation.')
    : kpi('Resume size', num(r.bootstrap_tokens) + '<small>tokens</small>',
        'no agent turn observed yet to compare with');
  html += kpi(dl.usd_avoided != null ? 'Cost avoided' : 'Tokens avoided',
    dl.usd_avoided != null ? '$' + dl.usd_avoided.toFixed(2) : compact(dl.tokens_avoided),
    (dl.usd_avoided != null ? compact(dl.tokens_avoided) + ' tokens · ' : '') + plural(dl.resumes, 'resume') +
      (dl.worker_usd > 0 ? ' · workers $' + dl.worker_usd.toFixed(2) : ''),
    dl.tokens_avoided > 0 ? 'good' : '',
    'Per resume: ' + num(dl.rebuild_tokens) + ' tokens of project .md files, minus the bootstrap.');
  html += kpi('Settled by code', pct(t.share_by_code), 'of ' + num(t.events) + ' events never reached a model',
    t.share_by_code > 0.5 ? 'good' : '', 'Discarded at ingest or closed by the deterministic fold.');
  html += kpi('Protected', num(pr.user_critical_items), 'user instructions no worker can weaken', '',
    'Enforced by isProtected in code, not by a prompt.');
  html += '</div>';

  html += '<div class="grid" style="margin-top:14px">' + nowCard(d.working);

  // Resume
  let resume = kv([
    ['Bootstrap', num(m.context.active_tokens) + ' <small>/ ' + num(m.context.budget) + ' tokens</small>', '', 'the always-on slice, against its budget'],
    ['Effective reduction', pct(m.context.effective_reduction), '', 'token ratio × coverage'],
    ['Coverage', pct(m.context.coverage) + (m.events.pending ? ' <small>· ' + num(m.events.pending) + ' pending</small>' : ''),
      m.context.coverage < 0.7 ? 'warn-t' : ''],
    ['Served from memory', plural(dl.resumes, 'resume') + ' · ' + plural(dl.query, 'query', 'queries'), '',
      num(dl.total) + ' deliveries, ' + num(dl.empty) + ' empty, ' + num(dl.tokens_served) + ' tokens served'],
    ['Docs re-read per resume', num(dl.rebuild_tokens) + ' <small>tokens · ' + esc(dl.rebuild_source) + '</small>'],
  ]);
  if (r.agent_peak_tokens > 0) {
    const f = (x) => Math.max(0.0025, x / r.agent_peak_tokens);
    resume += '<div style="margin-top:14px">' +
      hbar('Agent context at its peak', num(r.agent_peak_tokens), 1, 'dim', true) +
      (r.history_tokens > 0 ? hbar('History memory was derived from', num(r.history_tokens), f(r.history_tokens), 'dim', true) : '') +
      hbar('contextd bootstrap', num(r.bootstrap_tokens), f(r.bootstrap_tokens), 'good', true) + '</div>';
  }
  html += card('Resume', resume, 'what it takes to pick the work back up');

  // Funnel
  const top = Math.max(1, t.events);
  html += card('Events → memory',
    hbar('Events observed', num(t.events), 1) +
    hbar('Settled by code <small class="muted">free</small>', num(t.handled_by_code), t.handled_by_code / top, 'good') +
    hbar('Read by a worker', num(t.derived_by_model), t.derived_by_model / top) +
    hbar('Still waiting', num(t.pending), t.pending / top, t.pending > 0 ? 'warn' : '') +
    hbar('Memory items', num(q.active_items), q.active_items / top) +
    '<p class="note">' + plural(t.worker_runs, 'worker call') + ' · ' + num(t.worker_tokens) + ' tokens · ' +
    (t.worker_priced ? '$' + t.worker_cost_usd.toFixed(4) : 'unpriced model') + '</p>');

  // Continuity
  const hookOk = c.hook_p95_ms == null || c.hook_p95_ms <= c.hook_budget_ms;
  html += card('Continuity', '<ul class="checks">' +
    check('c-rec', c.recovery_ready ? 'good' : 'bad', 'Recovery', c.recovery_ready ? 'ready' : 'not ready',
      c.recovery_ready ? 'If the agent compacted right now, there is enough derived state to continue from.'
        : 'Not ready to recover: ' + esc(c.recovery_blockers.join('; '))) +
    check('c-hard', c.hard_compactions === 0 ? 'good' : 'warn', 'Hard compactions', num(c.hard_compactions),
      c.hard_compactions === 0 ? 'The agent has never had to compact on its own.'
        : 'The agent compacted ' + plural(c.hard_compactions, 'time') + ' anyway' +
          (dl.bootstrap > 0 ? '; memory was there to resume from.' : ', and no session start has been served from memory yet.')) +
    check('c-hook', c.hook_p95_ms == null ? '' : hookOk ? 'good' : 'warn', 'Hook p95',
      c.hook_p95_ms == null ? '–' : ms(c.hook_p95_ms) + ' <small class="muted">/ ' + c.hook_budget_ms + 'ms</small>',
      c.hook_p95_ms == null ? 'No hook latency measured yet.'
        : 'Invisible to the agent while hooks answer within ' + c.hook_budget_ms + 'ms at p95.') +
    check('c-served', dl.total > 0 ? 'good' : 'warn', 'Served from memory', num(dl.total),
      plural(dl.resumes, 'resume') + ' and ' + plural(dl.query, 'targeted query', 'targeted queries') +
      ' served from memory across ' + plural(c.sessions, 'session') + '.') +
    '</ul>');

  // Guarantees
  html += card('Guarantees', '<ul class="checks">' +
    check('g-attr', 'good', 'Unproven user attributions', num(pr.attributions_refused),
      'Patches where a worker claimed the user said something it could not cite. Each was downgraded to agent.') +
    check('g-inv', 'good', 'Invented ids dropped', num(pr.invented_operations_dropped),
      'Patches that referenced ids that do not exist. The invented part was dropped, the rest kept.') +
    check('g-rej', 'good', 'Worker outputs rejected', num(pr.rejected_patches),
      'Rejected outright; their events stayed pending instead of being lost.') +
    check('g-used', q.used_share >= 0.5 ? 'good' : 'warn', 'Memory served at least once', pct(q.used_share),
      num(q.used_items) + ' of ' + num(q.active_items) + ' active items have reached an agent; ' +
      plural(q.retired_items, 'item') + ' retired as wrong or superseded, kept in the patch log.') +
    '</ul>', 'enforced in code, not by prompt');

  // Pressure
  const STAGE_TONE = { steady: 'good', maintain: 'accent', consolidate: 'warn', reduce: 'bad' };
  html += card('Context pressure',
    (p.ratio == null
      ? '<p class="muted" style="margin:0 0 8px">Occupancy unobserved: no agent turn yet.</p>'
      : hbar('Agent occupancy', pct(p.ratio) + ' <small>of ' + compact(p.window_tokens) + '</small>', p.ratio,
          p.ratio > 0.85 ? 'bad' : p.ratio > 0.65 ? 'warn' : '', true) + '<div style="height:10px"></div>') +
    kv([
      ['Stage', chip(p.stage, STAGE_TONE[p.stage] || ''), '', 'reasons: ' + p.reasons.join(', ')],
      p.ratio == null ? null : ['Occupied', num(p.occupied_tokens) + ' <small>/ ' + num(p.window_tokens) + '</small>', '', 'window ' + p.window_source],
      ['Window', esc(p.window_source)],
      ['Authorised now', p.actions.length ? esc(p.actions.join(', ')) : '<small>nothing</small>'],
      ['Recovery (K5)', p.recovery_ready ? 'ready' : 'not ready', p.recovery_ready ? 'good-t' : 'bad-t', p.recovery_blockers.join('; ')],
      ['Hard compactions', num(m.lifecycle.hard_compactions), m.lifecycle.hard_compactions ? 'warn-t' : ''],
    ]), '<span title="' + esc(p.reasons.join(', ')) + '">' + esc(p.reasons.join(', ').replace(/_/g, ' ')) + '</span>');

  // Latency
  const lat = [['hook', m.latency.hook], ['ingest', m.latency.ingest]].filter((x) => x[1]);
  const budget = m.latency.budget_ms;
  html += card('Latency', lat.length
    ? '<div class="scroll"><table><thead><tr><th>op</th><th class="r">p50</th><th class="r">p95</th><th class="r">max</th><th class="r">samples</th></tr></thead><tbody>' +
      lat.map((x) => '<tr><td>' + x[0] + '</td><td class="r">' + ms(x[1].p50) + '</td><td class="r' +
        (x[1].p95 > budget ? ' bad-t' : '') + '">' + ms(x[1].p95) + '</td><td class="r muted">' + ms(x[1].max) +
        '</td><td class="r muted">' + num(x[1].count) + '</td></tr>').join('') + '</tbody></table></div>'
    : empty('No latency measured yet. Hooks record it once installed:', 'contextd init'),
    (m.latency.within_budget === false ? '<span class="bad-t">over</span> ' : '') + 'budget ' + budget + 'ms');

  // Precision
  const pr2 = m.precision;
  html += card('Memory precision',
    hbar('Never retrieved', pct(pr2.never_retrieved_ratio), pr2.never_retrieved_ratio, pr2.never_retrieved_ratio > 0.5 ? 'warn' : '') +
    hbar('Short lived', pct(pr2.short_lived_ratio), pr2.short_lived_ratio) +
    hbar('Low confidence', pct(pr2.low_confidence_ratio), pr2.low_confidence_ratio) +
    hbar('Unverified', pct(pr2.unverified_ratio), pr2.unverified_ratio) +
    '<p class="note">Shares of ' + plural(pr2.items, 'item') + '. Trend in <a href="#history">History</a>.</p>',
    'lower is better');

  // Store
  html += card('Store', kv([
    ['Memory items', num(m.memory.active) + ' <small>active of ' + num(m.memory.items) + '</small>'],
    ['State version', 'v' + num(m.memory.state_version) + ' <small>· ' + plural(m.memory.patches, 'patch', 'patches') + '</small>'],
    ['Relations', num(d.edges) + ' <small>· ' + (d.embeddings.enabled ? num(d.embeddings.count) + ' vectors' : 'embeddings off') + '</small>'],
    ['Contradictions', d.conflicts ? '<a href="#memory/conflicts">' + num(d.conflicts) + '</a>' : '0', d.conflicts ? 'warn-t' : ''],
    ['Worker runs', num(m.workers.runs) + ' <small>· ' + num(m.workers.invalid) + ' invalid · $' + (m.workers.cost_usd || 0).toFixed(4) + '</small>',
      m.workers.invalid ? 'warn-t' : ''],
    ['Agent turns', num(m.agent.turns) + ' <small>· peak ' + num(m.agent.peak_input_tokens) + '</small>'],
    ['Events stored', num(m.events.stored) + ' <small>· ' + num(m.events.discarded) + ' discarded</small>'],
  ]));
  html += '</div>';

  if (b.caveats.length) {
    html += '<details class="howto" data-k="caveats" style="margin-top:14px"><summary><span class="chev">›</span> How to read these numbers</summary><ul>' +
      b.caveats.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul></details>';
  }
  return html;
}

// ------------------------------------------------------------------ memory
let memCache = null;
let memCat = '';
let memQuery = '';

function workingCard(w) {
  if (!w || (!w.current_task && !w.current_state && !w.next_action)) {
    return card('Working memory', empty('Working memory is empty. Set the current task so every session starts from it:',
      'contextd task "<what you are doing>" --status in_progress'));
  }
  const status = w.task_status || 'unknown';
  return card('Working memory',
    '<div class="now"><div class="task">' + esc(w.current_task || 'no task set') + '</div>' +
    '<div>' + chip(status.replace('_', ' '), STATUS_TONE[status] || '') + '</div></div>' +
    '<div style="margin-top:10px">' + kv([
      w.current_state ? ['State', esc(w.current_state)] : null,
      w.next_action ? ['Next action', esc(w.next_action)] : null,
      w.last_important_event ? ['Last event', esc(w.last_important_event)] : null,
      w.current_plan && w.current_plan.length ? ['Plan', '<ol style="margin:0;padding-left:18px;text-align:left">' +
        w.current_plan.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol>'] : null,
      w.scratch && w.scratch.length ? ['Notes', w.scratch.map(esc).join('<br>')] : null,
    ]).replace('<dl class="kv">', '<dl class="kv wm">') + '</div>',
    'L0 · updated ' + when(w.updated_at));
}

function itemRow(i) {
  const closed = i.fields && typeof i.fields.closed_at === 'string';
  const f = i.fields || {};
  return '<details data-k="i:' + esc(i.id) + '"><summary>' +
    '<span class="main clip">' + esc(i.text) + '</span>' +
    '<span class="side">' + (closed ? chip('closed', 'good', f.closed_reason || '') : '') +
    impChip(i.importance) + srcChip(i.source) +
    '<span class="used" title="served to an agent ' + plural(i.retrieved_count, 'time') + '">' + num(i.retrieved_count) + '×</span></span>' +
    '</summary><div class="more">' + kv([
      i.reason ? ['Why', esc(i.reason)] : null,
      closed ? ['Closed', esc(f.closed_reason || '') + ' <small>' + when(f.closed_at) + '</small>'] : null,
      ['Category', esc(i.category)],
      ['Confidence', i.confidence.toFixed(2)],
      ['Id', '<code>' + esc(i.id) + '</code>'],
      ['Created', when(i.created_at)],
      ['Updated', when(i.updated_at)],
      ['Last served', i.last_used_at ? when(i.last_used_at) : '<small>never</small>'],
      i.evidence && i.evidence.length ? ['Evidence', plural(i.evidence.length, 'event')] : null,
      i.supersedes && i.supersedes.length ? ['Supersedes', i.supersedes.map(idTag).join(' ')] : null,
      i.tags && i.tags.length ? ['Tags', i.tags.map((x) => chip(x)).join(' ')] : null,
    ]) + '</div></details>';
}

function renderItems() {
  const d = memCache;
  if (!d) return '<div class="empty">loading…</div>';
  let html = workingCard(d.working) + '<div style="height:18px"></div>';
  if (!d.items.length) {
    return html + '<div class="rows">' + empty('No memory yet. Run <b>contextd attach</b> on a transcript, or start an agent session with hooks installed (<b>contextd init</b>):', ATTACH) + '</div>';
  }
  const counts = {};
  for (const i of d.items) counts[i.category] = (counts[i.category] || 0) + 1;
  const cats = d.categories.filter((c) => counts[c]);
  if (memCat && !counts[memCat]) memCat = '';
  html += '<div class="chips" role="group" aria-label="Filter by category">' +
    '<button data-cat="" aria-pressed="' + (memCat === '') + '">All<span>' + d.items.length + '</span></button>' +
    cats.map((c) => '<button data-cat="' + esc(c) + '" aria-pressed="' + (memCat === c) + '">' + esc(c.replace(/_/g, ' ')) +
      '<span>' + counts[c] + '</span></button>').join('') + '</div>';
  const needle = memQuery.trim().toLowerCase();
  const hit = (i) => !needle || [i.text, i.reason, i.id, i.category, i.fields && i.fields.closed_reason]
    .some((s) => typeof s === 'string' && s.toLowerCase().includes(needle));
  const shown = d.items.filter((i) => (!memCat || i.category === memCat) && hit(i));
  if (!shown.length) {
    return html + '<div class="rows">' + empty('No item matches “' + esc(memQuery) + '”' + (memCat ? ' in ' + esc(memCat) : '') + '.') + '</div>';
  }
  for (const c of d.categories) {
    const items = shown.filter((i) => i.category === c);
    if (!items.length) continue;
    html += '<h4 class="group">' + esc(c.replace(/_/g, ' ')) + ' <span class="num">' + items.length + '</span></h4>' +
      '<div class="rows">' + items.map(itemRow).join('') + '</div>';
  }
  return html;
}

async function drawItems() {
  memCache = await get('/api/memory');
  return renderItems();
}

async function drawConflicts() {
  const list = await get('/api/conflicts');
  if (!list.length) {
    return card('Contradictions', '<ul class="checks">' + check('', 'good', 'No contradictions between active items', '') + '</ul>' +
      '<p class="note">Checked on every load. When one appears, resolve it with <code>contextd reconcile</code> or retire the wrong item with <code>contextd forget &lt;id&gt;</code>.</p>');
  }
  return list.map((c, n) => card(
    (n + 1) + '. ' + esc(c.reason.replace(/_/g, ' ')),
    [c.a, c.b].map((s) => '<div class="side"><div class="tx">' + esc(s.text) +
      '<div class="chips-in">' + impChip(s.importance) + srcChip(s.source) + chip(s.category) +
      (s.id === c.newer ? chip('newer', 'accent') : '') + ' ' + idTag(s.id) + '</div></div></div>').join(''),
    'similarity ' + c.similarity.toFixed(2), 'pair')).join('') +
    '<p class="note">Resolve with <code>contextd reconcile</code>, or retire the wrong side with <code>contextd forget &lt;id&gt;</code>.</p>';
}

async function drawRelations() {
  const d = await get('/api/graph');
  if (!d.edges.length) {
    return card('Relations', empty('No relations yet. Workers add them as they extract memory; list them with:', 'contextd graph'));
  }
  const byId = {};
  d.nodes.forEach((nd) => { byId[nd.id] = nd; });
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
      '" stroke="var(--line-2)" stroke-width="1.2"><title>' + esc(e.kind) + '</title></line>';
  }).join('');
  const dots = d.nodes.map((nd) => {
    const p = pos[nd.id];
    const fill = nd.importance === 'critical' ? 'var(--bad)' : nd.importance === 'high' ? 'var(--warn)' : 'var(--accent)';
    return '<circle cx="' + p.x + '" cy="' + p.y + '" r="6" fill="' + fill + '" stroke="var(--surface)" stroke-width="2"><title>' +
      esc(nd.category + ': ' + nd.text) + '</title></circle>';
  }).join('');
  const label = (id) => {
    const nd = byId[id];
    return '<span title="' + esc(id) + '">' + esc(nd ? nd.text : id) + '</span>';
  };
  return '<div class="relgrid">' +
    card('Graph', '<div class="graph"><svg viewBox="0 0 400 380" role="img" aria-label="memory relation graph">' + lines + dots + '</svg></div>' +
      '<p class="note"><i class="dot bad"></i> critical &nbsp; <i class="dot warn"></i> high &nbsp; <i class="dot accent"></i> other · hover a node for its text</p>',
      plural(d.nodes.length, 'item') + ' · ' + plural(d.edges.length, 'relation')) +
    card('Relation list', d.edges.map((e) =>
      '<div class="rel"><div>' + label(e.from) + '</div><div class="to">' + chip(e.kind.replace(/_/g, ' '), 'accent') +
      label(e.to) + '</div>' + (e.reason ? '<div class="why">' + esc(e.reason) + '</div>' : '') + '</div>').join(''),
      'from → to') +
    '</div>';
}

let ctxQuery = '';
try { ctxQuery = sessionStorage.getItem('ctxq') || ''; } catch {}

async function drawContext() {
  const d = await get('/api/context' + (ctxQuery ? '?q=' + encodeURIComponent(ctxQuery) : ''));
  return card(ctxQuery ? 'Query result' : 'Bootstrap', d.text
      ? '<div class="pre" style="margin-top:0">' + esc(d.text) + '</div>'
      : empty('Nothing to serve yet. Memory fills as sessions are observed:', ATTACH),
    '<span class="num">' + num(d.tokens) + ' / ' + num(d.budget) + ' tokens</span> · ' + plural(d.itemIds.length, 'item'));
}

// ----------------------------------------------------------------- history
/**
 * A step line, not a sloped one: the ratio only moves when an item is created or first served,
 * and holds exactly between those instants. Interpolating would invent values that never existed.
 */
let chartPointer = null;

function neverRetrievedChart(points) {
  if (points.length < 2) {
    return { html: empty('Not enough history yet. The trend starts once memory has items and an agent has been served some:', ATTACH), wire() {} };
  }
  // Draw at the card's real width so text stays 11px instead of scaling with the viewBox;
  // the view redraws on a timer, which also picks up a resize.
  const W = Math.max(300, Math.min(1180, panel.clientWidth - 38)), H = 220, L = 40, R = 60, T = 12, B = 26;
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
  const area = path + 'V' + y(0).toFixed(1) + 'H' + xs[0].toFixed(1) + 'Z';

  const whenAxis = (t) => {
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
      '" fill="var(--muted)" font-size="11">' + esc(whenAxis(t)) + '</text>';
  }

  const last = points[points.length - 1];
  const lx = x(t1), ly = ys[ys.length - 1];
  const svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="never retrieved share over time, now ' +
    pct(ratio(last)) + '">' + grid +
    '<path d="' + area + '" fill="var(--accent-soft)" stroke="none"/>' +
    '<path d="' + path + '" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>' +
    '<circle cx="' + lx + '" cy="' + ly + '" r="4" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>' +
    '<text x="' + (lx + 8) + '" y="' + (ly + 4) + '" fill="var(--ink)" font-size="12">' + pct(ratio(last)) + '</text>' +
    '<line class="xh" y1="' + T + '" y2="' + (H - B) + '" stroke="var(--muted)" stroke-width="1" visibility="hidden"/>' +
    '<circle class="xd" r="4" fill="var(--accent)" stroke="var(--surface)" stroke-width="2" visibility="hidden"/>' +
    '<rect class="hit" x="' + L + '" y="0" width="' + (W - L - R) + '" height="' + H + '" fill="transparent"/>' +
    '</svg>';

  const rows = points.slice(-30).reverse().map((p) =>
    '<tr><td title="' + esc(full(p.at)) + '">' + esc(new Date(p.at).toLocaleString()) + '</td><td class="r">' +
    pct(ratio(p)) + '</td><td class="r muted">' + num(p.never) + ' / ' + num(p.total) + '</td></tr>').join('');
  const html = '<div class="chart" id="nr-chart">' + svg + '<div class="tip"></div></div>' +
    '<details class="more-data" data-k="nr-data"><summary><span class="chev">›</span> Data (last ' + Math.min(30, points.length) + ' changes)</summary>' +
    '<div class="scroll"><table><thead><tr><th>changed at</th><th class="r">never retrieved</th><th class="r">items</th></tr></thead><tbody>' +
    rows + '</tbody></table></div></details>';

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
        num(p.never) + ' of ' + num(p.total) + ' items · ' + esc(new Date(p.at).toLocaleString()) + '</span>';
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

function sessionsTable(sessions) {
  if (!sessions.length) {
    return empty('No sessions yet. Install hooks so every agent session is observed, or attach a transcript:', 'contextd init');
  }
  const top = Math.max(1, ...sessions.map((s) => s.events));
  return '<div class="scroll"><table><thead><tr><th>started</th><th>agent</th><th class="r">events</th><th></th><th>ended</th><th>id</th></tr></thead><tbody>' +
    sessions.map((s) => '<tr><td>' + when(s.started_at) + '</td><td>' + esc(s.agent || s.source) +
      (s.agent && s.source !== s.agent ? ' <small class="muted">' + esc(s.source) + '</small>' : '') + '</td>' +
      '<td class="r">' + num(s.events) + '</td><td><div class="track"><div class="fill" style="width:' +
      Math.max(1, (s.events / top) * 100).toFixed(1) + '%"></div></div></td>' +
      '<td class="muted">' + (s.ended_at ? when(s.ended_at) : 'open') + '</td><td>' + idTag(s.id) + '</td></tr>').join('') +
    '</tbody></table></div>';
}

async function drawHistory() {
  const d = await get('/api/overview');
  const pts = d.never_retrieved_history || [];
  const trend = neverRetrievedChart(pts);
  const last = pts[pts.length - 1];
  const html = card('Never retrieved over time',
      '<p class="note" style="margin:0 0 10px">Share of memory items never served to an agent; lower is better. Rebuilt from the retrieval log, so history starts with the first item.</p>' + trend.html,
      last ? '<span class="num">now ' + pct(last.total ? last.never / last.total : 0) + ' · ' + num(last.never) + ' of ' + num(last.total) + '</span>' : '') +
    card('Sessions', sessionsTable(d.sessions), 'latest ' + d.sessions.length);
  return { html, after: trend.wire };
}

// ---------------------------------------------------------------- activity
async function drawEvents() {
  const list = await get('/api/events?limit=200');
  if (!list.length) {
    return '<div class="rows">' + empty('No events yet. Start an agent session with hooks installed (<b>contextd init</b>), or replay a transcript:', ATTACH) + '</div>';
  }
  const pending = list.filter((e) => !e.processed).length;
  return '<p class="caption" style="margin-top:0">' + plural(list.length, 'event') + ' shown · ' +
    (pending ? '<span class="warn-t">' + num(pending) + ' pending</span> a worker' : 'none pending') + '</p>' +
    '<div class="rows fixed">' + list.map((e) =>
      '<details data-k="e:' + esc(e.id) + '"><summary><span class="t">' + when(e.timestamp) + '</span>' +
      '<span class="side">' + chip(e.type.toLowerCase().replace(/_/g, ' '), 'mono') + impChip(e.importance) +
      (e.processed ? '' : chip('pending', 'warn')) + '</span>' +
      '<span class="main one mono muted">' + esc(e.preview) + '</span></summary>' +
      '<div class="more">' + (e.preview ? '<div class="pre">' + esc(e.preview) + '</div>' : '') + kv([
        ['Action', esc(e.action)],
        ['Reasons', e.reasons && e.reasons.length ? e.reasons.map((x) => chip(x, 'mono')).join(' ') : '–'],
        ['Tokens', num(e.tokens)],
        ['Time', esc(full(e.timestamp))],
        ['Session', idTag(e.session_id)],
        ['Id', '<code>' + esc(e.id) + '</code>'],
      ]) + '</div></details>').join('') + '</div>';
}

const OPS = [['add', '+'], ['update', '~'], ['remove', '−'], ['supersede', '>'], ['close', 'close'],
  ['reopen', 'reopen'], ['touch', 'touch'], ['link', 'link'], ['unlink', 'unlink']];

function opSummary(patch) {
  const parts = OPS.filter(([k]) => Array.isArray(patch[k]) && patch[k].length)
    .map(([k, sym]) => (sym.length === 1 ? sym + patch[k].length : sym + ' ' + patch[k].length));
  if (patch.working) parts.push('working');
  return parts.join(' ') || 'no-op';
}

function opLines(patch) {
  const out = [];
  for (const [k] of OPS) {
    for (const op of patch[k] || []) {
      let text;
      if (typeof op === 'string') text = idTag(op);
      else if (k === 'add') text = chip(op.category || '') + ' ' + esc(op.text || '');
      else if (k === 'supersede') text = idTag(op.id) + ' → ' + idTag(op.by) + (op.reason ? ' <span class="muted">' + esc(op.reason) + '</span>' : '');
      else if (k === 'link' || k === 'unlink') text = idTag(op.from) + ' ' + chip(op.kind || 'any', 'accent') + ' ' + idTag(op.to);
      else if (k === 'close') text = idTag(op.id) + ' <span class="muted">' + esc(op.reason || '') + '</span>';
      else text = idTag(op.id) + ' ' + esc(op.text || Object.keys(op).filter((x) => x !== 'id').join(', '));
      out.push('<li><b>' + k + '</b><span>' + text + '</span></li>');
    }
  }
  if (patch.working) {
    out.push('<li><b>working</b><span>' + Object.keys(patch.working).map((x) => '<code>' + esc(x) + '</code>').join(' ') + '</span></li>');
  }
  return out.length ? '<ul class="ops">' + out.join('') + '</ul>' : '<p class="muted">no operations</p>';
}

async function drawPatches() {
  const list = await get('/api/patches');
  if (!list.length) {
    return '<div class="rows">' + empty('No patches yet. Memory changes arrive as patches once events are observed:', ATTACH) + '</div>';
  }
  return '<div class="rows patches">' + list.map((p) =>
    '<details data-k="p:' + esc(p.id) + '"><summary><span class="t">' + when(p.created_at) + '</span>' +
    '<span class="side"><span class="num mono">v' + p.base_version + '→v' + p.new_version + '</span>' +
    chip(p.origin, p.origin === 'user' ? 'accent' : '') + chip(opSummary(p.patch), 'mono') + '</span>' +
    '<span class="main one muted">' + esc(p.note || '') + '</span></summary>' +
    '<div class="more">' + (p.note ? '<p style="margin:10px 0 0">' + esc(p.note) + '</p>' : '') + opLines(p.patch) +
    '<p class="note">' + idTag(p.id) + ' · seq ' + num(p.seq) + ' · ' + esc(full(p.created_at)) + '</p></div></details>').join('') + '</div>';
}

const DRAW = {
  overview: drawOverview,
  'memory/items': drawItems, 'memory/conflicts': drawConflicts, 'memory/relations': drawRelations,
  'memory/context': drawContext,
  history: drawHistory,
  'activity/events': drawEvents, 'activity/patches': drawPatches,
};

// ------------------------------------------------------------------ chrome
function viewOf(id) { return VIEWS.find((v) => v.id === id); }

function renderChrome() {
  $('views').innerHTML = VIEWS.map((v, i) =>
    '<button role="tab" aria-selected="' + (v.id === route.view) + '" data-view="' + v.id + '">' + v.label +
    '<kbd>' + (i + 1) + '</kbd></button>').join('');
  const v = viewOf(route.view);
  $('subnav').innerHTML = v.subs ? v.subs.map(([id, label]) =>
    '<button role="tab" aria-selected="' + (id === route.sub) + '" data-sub="' + id + '">' + label + '</button>').join('') : '';
  $('subnav').hidden = !v.subs;
  // Tools only exist on views with sections, so a view without sections has no bar at all.
  $('bar').hidden = !v.subs;
  const sub = v.subs ? v.subs.find((s) => s[0] === route.sub) : null;
  $('caption').textContent = sub ? sub[2] : v.caption;
  renderTools();
}

/*
 * Inputs live outside the painted panel: the panel is rewritten whenever its markup changes, and
 * an input inside it would lose focus and caret mid-word. The Context box also owns its fetch and
 * the timer leaves that view alone, so a query result never shifts under someone reading it.
 */
let ctxTimer;
function renderTools() {
  const tools = $('tools');
  const key = keyOf(route);
  if (key === 'memory/items') {
    tools.innerHTML = '<input type="search" class="search" id="mem-q" placeholder="Search memory  ( / )" aria-label="Search memory">';
    const input = $('mem-q');
    input.value = memQuery;
    input.addEventListener('input', () => { memQuery = input.value; if (memCache) paint(renderItems()); });
  } else if (key === 'memory/context') {
    tools.innerHTML = '<input type="search" class="search" id="ctx-q" placeholder="What are you about to work on?" aria-label="Context query">';
    const input = $('ctx-q');
    input.value = ctxQuery;
    input.addEventListener('input', () => {
      ctxQuery = input.value;
      try { sessionStorage.setItem('ctxq', ctxQuery); } catch {}
      clearTimeout(ctxTimer);
      ctxTimer = setTimeout(() => draw(true), 250);
    });
  } else {
    tools.innerHTML = '';
  }
}

function go(view, sub) {
  const v = viewOf(view) || VIEWS[0];
  const next = { view: v.id, sub: v.subs ? (sub && v.subs.some((s) => s[0] === sub) ? sub : v.subs[0][0]) : null };
  if (keyOf(next) === keyOf(route)) return;
  // Applied now rather than on hashchange, so a shortcut can focus the new view's input at once.
  route = next;
  if (location.hash.slice(1) !== keyOf(route)) location.hash = keyOf(route);
  renderChrome();
  draw();
  window.scrollTo(0, 0);
}

$('views').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b) go(b.dataset.view);
});
$('subnav').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sub]');
  if (b) go(route.view, b.dataset.sub);
});
panel.addEventListener('click', (e) => {
  const c = e.target.closest('[data-cat]');
  if (c) { memCat = c.dataset.cat; paint(renderItems()); }
});

// ------------------------------------------------------------------- paint
/*
 * Views return their markup rather than writing it, so a refresh can compare before touching the
 * DOM. Rewriting the panel every few seconds collapsed it to "loading…" and back: the page jumped
 * to the top, open <details> shut, and a tooltip vanished under the pointer. Open rows are matched
 * by their data-k key, so filtering the list cannot reopen the wrong one.
 */
let painted = null;
let drawSeq = 0;
let inFlight = false;
let lastOk = null;
let lastError = null;

function paint(out) {
  const view = typeof out === 'string' ? { html: out } : out;
  if (view.html === painted) return;
  const all = [...panel.querySelectorAll('details')];
  const openKeys = new Set(all.filter((d) => d.open && d.dataset.k).map((d) => d.dataset.k));
  const openIdx = all.map((d) => d.open);
  panel.innerHTML = view.html;
  painted = view.html;
  panel.querySelectorAll('details').forEach((d, i) => {
    if (d.dataset.k ? openKeys.has(d.dataset.k) : openIdx[i]) d.open = true;
  });
  if (view.after) view.after();
}

async function draw(refresh = false) {
  const seq = ++drawSeq;
  const key = keyOf(route);
  if (!refresh) {
    panel.innerHTML = '<div class="empty">loading…</div>';
    painted = null;
  }
  inFlight = true;
  try {
    const out = await (DRAW[key] || drawOverview)();
    // A view switch started a newer draw while this one was fetching; the panel is its now.
    if (seq !== drawSeq) return;
    if (out != null) paint(out);
    lastOk = Date.now();
    lastError = null;
  } catch (err) {
    if (seq !== drawSeq) return;
    // A failed background refresh keeps what is on screen; only say so in the header.
    lastError = err.message;
    if (!refresh) {
      panel.innerHTML = '<div class="empty">' + esc(err.message) + '</div>';
      painted = null;
    }
  } finally {
    if (seq === drawSeq) inFlight = false;
    tick();
  }
}

function tick() {
  const el = $('freshness');
  if (lastError) {
    el.className = 'fresh bad';
    el.textContent = 'refresh failed';
    el.title = lastError;
    return;
  }
  el.className = 'fresh';
  el.title = lastOk ? new Date(lastOk).toLocaleTimeString() : '';
  if (!lastOk) { el.textContent = ''; return; }
  const s = Math.floor((Date.now() - lastOk) / 1000);
  el.textContent = 'updated ' + (s < 60 ? s + 's' : Math.floor(s / 60) + 'm') + ' ago';
}

// ------------------------------------------------------------------ health
let healthHtml = null;
// Doctor's fix hints quote commands in backticks; this script cannot contain one literally.
const BT = String.fromCharCode(96);
const TICKS = new RegExp(BT + '([^' + BT + ']+)' + BT, 'g');
async function loadHealth() {
  let h;
  try { h = await get('/api/health'); } catch (err) { h = { status: 'error', error: err.message, checks: [] }; }
  const bad = h.checks.filter((c) => c.status === 'fail');
  const warn = h.checks.filter((c) => c.status === 'warn');
  const pill = $('health');
  const tone = h.status === 'ok' ? 'good' : h.status === 'warn' ? 'warn' : 'bad';
  const label = h.status === 'error' ? 'Unreachable'
    : bad.length ? bad.length + ' failing'
    : warn.length ? plural(warn.length, 'warning') : 'Healthy';
  pill.innerHTML = '<i class="dot ' + tone + '"></i><span>' + label + '</span>';
  const issues = bad.concat(warn);
  const passing = h.checks.filter((c) => c.status === 'ok').length;
  const html = h.status === 'error'
    ? '<h4>Health unavailable</h4><p class="muted" style="margin:0">' + esc(h.error) + '</p>'
    : '<h4>' + (issues.length ? 'Needs attention' : 'All checks pass') + '</h4>' +
      (issues.length ? '<ul>' + issues.map((c) => '<li><i class="dot ' + (c.status === 'fail' ? 'bad' : 'warn') + '"></i>' +
        '<span class="nm">' + esc(c.name) + '</span><span class="dt">' + esc(c.detail).replace(TICKS, '<code>$1</code>') + '</span>' +
        (c.fix ? '<span class="fx">fix: ' + esc(c.fix).replace(TICKS, '<code>$1</code>') + '</span>' : '') +
        '</li>').join('') + '</ul>' : '') +
      '<div class="foot">' + num(passing) + ' of ' + num(h.checks.length) + ' checks pass · same checks as <code>contextd doctor</code></div>';
  if (html !== healthHtml) { $('health-pop').innerHTML = html; healthHtml = html; }
}
function setPop(open) {
  $('health-pop').hidden = !open;
  $('health').setAttribute('aria-expanded', String(open));
}
$('health').addEventListener('click', (e) => { e.stopPropagation(); setPop($('health-pop').hidden); });
document.addEventListener('click', (e) => {
  if (!$('health-pop').hidden && !e.target.closest('#health-pop')) setPop(false);
});

// ------------------------------------------------------------------- theme
$('theme').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('contextd-theme', next); } catch {}
});

function refreshAll() {
  const b = $('refresh');
  b.classList.remove('spin'); void b.offsetWidth; b.classList.add('spin');
  if (!inFlight) draw(true);
  loadHealth();
}
$('refresh').addEventListener('click', refreshAll);

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  if (e.key === 'Escape') {
    setPop(false);
    if (typing) t.blur();
    return;
  }
  if (typing) return;
  if (e.key >= '1' && e.key <= String(VIEWS.length)) {
    e.preventDefault();
    go(VIEWS[Number(e.key) - 1].id);
  } else if (e.key === 'r' || e.key === 'R') {
    e.preventDefault();
    refreshAll();
  } else if (e.key === '/') {
    e.preventDefault();
    go('memory', 'items');
    const input = $('mem-q');
    if (input) input.focus();
  }
});

// The header identifies which project this is, so it must be filled whatever view opens.
get('/api/overview').then((d) => {
  const el = $('project');
  el.textContent = d.root_display || d.root;
  el.title = d.root;
  document.title = 'contextd · ' + (d.project || d.root.split('/').pop());
}).catch(() => {});

// The back button and a pasted #view link must both work, not just clicking a view.
window.addEventListener('hashchange', () => {
  const next = parseHash(location.hash);
  if (location.hash.slice(1) !== keyOf(next)) history.replaceState(null, '', '#' + keyOf(next));
  if (keyOf(next) === keyOf(route)) return;
  route = next;
  renderChrome();
  draw();
});

renderChrome();
draw();
loadHealth();
// The store changes underneath us as the agent works, so refresh on a slow timer.
// Skipped while a draw is still out, so a slow server cannot stack requests up.
setInterval(() => { if (keyOf(route) !== 'memory/context' && !inFlight) draw(true); }, 5000);
// Doctor replays the patch log and scans for transcripts: worth a slower cadence.
setInterval(loadHealth, 30000);
setInterval(tick, 1000);
</script>
</body>
</html>`;
}
