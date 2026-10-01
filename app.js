/* =============================================================
   MERIDIAN — Protocol Treasury & TVL Intelligence
   Static demo. No build step. All figures fetched live from
   DefiLlama public APIs at view time. No seeded or estimated data.
   ============================================================= */
'use strict';

/* ---------------------------------------------------------------- config */
const API    = 'https://api.llama.fi';
const YIELDS = 'https://yields.llama.fi';
const DAY    = 864e5;
const POOL_LIMIT = 14;
const AUTOREFRESH_MS = 5 * 60 * 1000;

/* Slug → label. Every slug below returned HTTP 200 from /protocol/{slug}. */
const CURATED = [
  ['ember-protocol',    'Ember Protocol'],
  ['renzo',             'Renzo'],
  ['sushiswap',         'SushiSwap'],
  ['lagoon',            'Lagoon'],
  ['gmx-v2-perps',      'GMX V2 Perps'],
  ['curve-llamalend',   'Curve LlamaLend'],
  ['ekubo',             'Ekubo'],
  ['fusion-by-ipor',    'Fusion by IPOR'],
  ['project-0',         'Project 0'],
  ['vesu',              'Vesu'],
  ['navi-lending',      'NAVI Lending'],
  ['moonwell-lending',  'Moonwell Lending'],
];

/* Series palette — mirrors the --d1…--d8 custom properties in styles.css.
   Hard-coded here so charts are correct even if the stylesheet is still loading. */
const PALETTE = ['#5C9FCB','#3AA981','#D3A24C','#B3697F','#6FA9A2','#8892B4','#C0855A','#69737F'];
const OTHER_COLOR = '#69737F';

const RANGES = { '30d':30*DAY, '90d':90*DAY, '1y':365*DAY, 'all':null };

/* ---------------------------------------------------------------- state */
const S = {
  slug: 'ember-protocol',
  name: '…',
  range: '1y',
  compare: '',
  proto: null,          // /protocol/{slug} payload
  fees: null,           // /summary/fees/{slug} payload (or {unavailable:true})
  pools: [],            // yields rows for this protocol
  poolProject: null,
  cmp: null,            // compare protocol payload
  index: null,          // /protocols directory (lazy, for rank + search)
  _sorted: null,        // cached search candidates derived from index
  rank: null,
  charts: {},
  sort: { key:'tvlUsd', dir:-1 },
  faults: [],
  loadedAt: null,
  poolsCache: null,
};

const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => Array.from(r.querySelectorAll(s));
const el = (tag, cls, html) => { const n=document.createElement(tag); if(cls) n.className=cls; if(html!=null) n.innerHTML=html; return n; };
const esc = s => String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

/* ---------------------------------------------------------------- format */
const NA = '<span class="na">—</span>';

function usd(v, dp){
  if (!Number.isFinite(v)) return NA;
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1e9) return `${sign}$${(a/1e9).toFixed(dp ?? 2)}B`;
  if (a >= 1e6) return `${sign}$${(a/1e6).toFixed(dp ?? 1)}M`;
  if (a >= 1e3) return `${sign}$${(a/1e3).toFixed(dp ?? 1)}K`;
  return `${sign}$${a.toFixed(a < 100 ? 2 : 0)}`;
}
function usdFull(v){
  if (!Number.isFinite(v)) return NA;
  return '$' + v.toLocaleString('en-US', { maximumFractionDigits: Math.abs(v) < 1000 ? 2 : 0 });
}
function pct(v, dp=2, signed=true){
  if (!Number.isFinite(v)) return NA;
  const s = signed && v > 0 ? '+' : '';
  return `${s}${v.toFixed(dp)}%`;
}
function int(n){ return Number.isFinite(n) ? n.toLocaleString('en-US') : NA; }
const plural = (n, word, suffix) => `${int(n)} ${word}${n===1?'':(suffix||'s')}`;
const dtf = new Intl.DateTimeFormat('en-GB', { day:'2-digit', month:'short', year:'numeric', timeZone:'UTC' });
const ymf = new Intl.DateTimeFormat('en-GB', { month:'short', year:'numeric', timeZone:'UTC' });
const ttf = new Intl.DateTimeFormat('en-GB', { hour:'2-digit', minute:'2-digit', hour12:false, timeZone:'UTC' });
const fdate = ms => dtf.format(new Date(ms));
const fdatetime = ms => `${dtf.format(new Date(ms))} ${ttf.format(new Date(ms))} UTC`;
/* compact stamp for narrow metric notes — the full form goes in the title attr */
const fshort = ms => `${new Intl.DateTimeFormat('en-GB',{day:'2-digit',month:'short',timeZone:'UTC'}).format(new Date(ms))} ${ttf.format(new Date(ms))}`;
const fmonth = ms => ymf.format(new Date(ms));
const ftime = ms => `${ttf.format(new Date(ms))} UTC`;

function deltaHTML(v, dp=2, big){
  const size = big ? ' style="font-size:20px;padding:3px 7px"' : '';
  if (!Number.isFinite(v)) return `<span class="delta flat"${size}>—</span>`;
  const cls = v > 0.005 ? 'up' : v < -0.005 ? 'down' : 'flat';
  const arw = v > 0.005 ? '▲' : v < -0.005 ? '▼' : '=';
  return `<span class="delta ${cls}"${size} title="computed from the DefiLlama daily TVL series"><span class="arw">${arw}</span>${pct(v,dp)}</span>`;
}

/* ---------------------------------------------------------------- fetch */
class ApiError extends Error{
  constructor(msg, status, url){ super(msg); this.status=status; this.url=url; }
}
async function getJSON(url, timeout=40000){
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try{
    const res = await fetch(url, { signal: ctl.signal, headers:{ 'Accept':'application/json' } });
    if (!res.ok){
      const e = new ApiError(`HTTP ${res.status} ${res.statusText || ''}`.trim(), res.status, url);
      e.notFound = res.status === 400 || res.status === 404;
      throw e;
    }
    return await res.json();
  }catch(err){
    if (err.name === 'AbortError') throw new ApiError('request timed out', 0, url);
    throw err instanceof ApiError ? err : new ApiError(err.message || 'network error', 0, url);
  }finally{ clearTimeout(t); }
}
function logFault(where, err){
  S.faults.push({ where, msg: err.message || String(err), status: err.status || null });
  renderAlerts();
}

/* ---------------------------------------------------------------- series math */
/* Normalise [{date,totalLiquidityUSD}] → ascending [{t(ms),v}] of finite points. */
function normSeries(raw){
  if (!Array.isArray(raw)) return [];
  return raw.filter(p => p && Number.isFinite(p.date) && Number.isFinite(p.totalLiquidityUSD))
            .map(p => ({ t: p.date * 1000, v: p.totalLiquidityUSD }))
            .sort((a,b) => a.t - b.t);
}
function nearestAt(series, targetMs){
  if (!series.length) return null;
  let best = series[0], bd = Math.abs(series[0].t - targetMs);
  for (const p of series){ const d = Math.abs(p.t - targetMs); if (d < bd){ bd = d; best = p; } }
  return best;
}
/* % change between latest point and the daily point nearest to (latest - spanMs).
   Returns null when the series is too short — never a fake 0. */
function changeOver(series, spanMs){
  if (series.length < 2) return null;
  const last = series[series.length-1];
  const base = nearestAt(series, last.t - spanMs);
  if (!base || !Number.isFinite(base.v) || base.v === 0 || base.t === last.t) return null;
  return { pct: (last.v - base.v) / base.v * 100, baseT: base.t, span: Math.round((last.t-base.t)/DAY) };
}
function windowSlice(series, spanMs){
  if (!spanMs || series.length < 2) return series;
  const endT = series[series.length-1].t;
  return series.filter(p => p.t >= endT - spanMs);
}

/* ---------------------------------------------------------------- loaders */
async function loadPools(){
  if (S.poolsCache) return S.poolsCache;
  const j = await getJSON(`${YIELDS}/pools`, 60000);
  if (!j || !Array.isArray(j.data)) throw new ApiError('unexpected response shape (no data[])', 200, `${YIELDS}/pools`);
  S.poolsCache = j.data;
  return j.data;
}
function poolsFor(slug, name, all){
  const strict = all.filter(p => p.project === slug);
  if (strict.length) return { rows: strict, project: slug };
  /* DefiLlama Yields keys `project` off the protocol slug; fall back to a
     normalised name match, and report which key was actually used. */
  const nl = String(name||'').toLowerCase().replace(/[\s_]+/g,'-').replace(/[^a-z0-9\.\-]/g,'');
  const byName = nl ? all.filter(p => String(p.project||'').toLowerCase() === nl) : [];
  if (byName.length) return { rows: byName, project: byName[0].project };
  return { rows: [], project: null };
}
async function loadFees(slug){
  const url = `${API}/summary/fees/${encodeURIComponent(slug)}?dataType=dailyFees`;
  try{
    return await getJSON(url, 30000);
  }catch(err){
    if (err.notFound) return { unavailable: true, reason: 'no fee adapter published for this protocol' };
    logFault('Fees · /summary/fees', err);
    return { error: true, reason: err.message };
  }
}
async function loadIndex(){
  try{
    const list = await getJSON(`${API}/protocols`, 90000);
    if (!Array.isArray(list)) throw new ApiError('unexpected response shape', 200, `${API}/protocols`);
    S.index = list.filter(d => d && Number.isFinite(d.tvl));
    S._sorted = null;
    S.rank  = computeRank(S.slug);
    fillCompare();
    if (S.proto){ renderMetrics(); renderTvlFoot(); }   /* nothing to re-rank if the protocol fetch failed */
    updateStatus(S.faults.length ? 'partial' : 'live');
  }catch(err){ logFault('Directory · /protocols', err); }
}
function computeRank(slug){
  if (!S.index) return null;
  const cur = S.index.find(d => d.slug === slug);
  if (!cur) return null;
  const ordered = S.index.slice().sort((a,b) => b.tvl - a.tvl);
  const overall = ordered.findIndex(d => d.slug === slug) + 1;
  const peers = S.index.filter(d => d.category === cur.category).sort((a,b) => b.tvl - a.tvl);
  const inCat = peers.findIndex(d => d.slug === slug) + 1;
  return { overall, total: ordered.length, category: cur.category, inCat, catTotal: peers.length };
}

/* ---------------------------------------------------------------- orchestration */
async function setProtocol(slug, opts={}){
  S.slug = slug;
  S.name = slug;
  S.proto = null; S.fees = null; S.pools = []; S.poolProject = null;
  if (!opts.keepCompare) S.cmp = null;
  S.rank = S.index ? computeRank(slug) : null;
  syncURL();
  paintSkeletons();
  updateStatus('loading');
  const input = $('#proto-input'); if (input) input.value = '';

  /* Three independent live reads. Each records its own fault; none of them
     may silently degrade into a placeholder number. */
  const detailP = getJSON(`${API}/protocol/${encodeURIComponent(slug)}`, 60000)
    .then(p => {
      if (!p || !Array.isArray(p.tvl)) throw new ApiError('unexpected response shape (no tvl[])', 200, 'protocol');
      S.proto = p; S.name = p.name || slug;
    })
    .catch(err => logFault(`TVL · /protocol/${slug}`, err));

  const feesP = loadFees(slug).then(f => { S.fees = f; });

  /* Pool rows need the whole 11.6 MB yields table, so they must not gate first
     paint: the chart and metrics come up off /protocol (≈370 KB) and the pools
     panel fills in when that read lands. Awaiting it here meant a prospect
     staring at a blank screen for ten seconds. */
  let poolsSettled = false;
  const poolsP = detailP.then(() => loadPools().then(all => {
    const r = poolsFor(slug, S.name, all);
    S.pools = r.rows; S.poolProject = r.project;
  }).catch(err => logFault('Pools · yields.llama.fi', err)).finally(() => {
    poolsSettled = true;
    if (S.slug === slug && S.proto) render();   // repaint only if still on this protocol
  }));

  await Promise.all([detailP, feesP]);
  if (!S.proto) return finishFail(slug);

  S.name = S.proto.name || slug;
  if (S.compare === slug){ S.compare = ''; S.cmp = null; $('#compare-select').value = ''; }
  else if (S.compare) loadCompare(S.compare, true);
  fillCompare();
  render();
  if (!poolsSettled) {
    const pb = $('#pools-body');
    if (pb) pb.innerHTML = '<div class="m-note">loading pool rows — fetching the full yields table…</div>';
  }
  updateStatus(S.faults.length ? 'partial' : 'live');
  if (S.index && !S.rank) S.rank = computeRank(slug);
}

function finishFail(slug){
  destroyCharts();
  const errs = S.faults.map(f => `<li>${esc(f.where)} — ${esc(f.msg)}</li>`).join('');
  $('#p-identity').innerHTML =
    `<div class="state err" style="width:100%"><div class="st-t">No data returned for “${esc(slug)}”</div>
     <div class="st-d">Every request for this protocol failed, so nothing is rendered rather than a placeholder value.</div>
     <ul style="margin-top:8px;text-align:left;display:inline-block">${errs}</ul>
     <div><button class="retry" data-retry="1" type="button">Retry</button></div></div>`;
  $('#p-metrics').innerHTML = `<div class="metric" style="grid-column:1/-1">
    <div class="m-lbl">Headline metrics</div>
    <div class="m-val"><span class="na">unavailable</span></div>
    <div class="m-note">no live observation retrieved — a cached or placeholder figure would be shown here otherwise</div></div>`;
  $$('.chart-box').forEach(b => { clearSk(b); overlayFault(b, 'Series', null, true); });
  ['#pools-body','#comp-body','#foot-body','#risk-body','#fees-metrics'].forEach(s => $(s).innerHTML = '');
  updateStatus('error');
}

function render(){
  /* Each panel renders independently: a failure in one is reported in place
     and never blanks the rest of the dashboard. */
  const panels = [
    ['Identity',      '#p-identity',  renderIdentity],
    ['Metrics',       '#p-metrics',   renderMetrics],
    ['TVL series',    '.chart-tvl',   renderTvl],
    ['Allocation',    '.chart-donut', renderAlloc],
    ['Fees',          '#fees-metrics',renderFees],
    ['Pools',         '#pools-body',  renderPools],
    ['Composition',   '#comp-body',   renderComposition],
    ['Footprint',     '#foot-body',   renderFootprint],
    ['Record',        '#risk-body',   renderRecord],
  ];
  for (const [label, sel, fn] of panels){
    try { fn(); }
    catch(err){
      logFault(label, err);
      try{ const n = $(sel); clearSk(n); overlayFault(n, label, err, true); }catch(_){}
    }
  }
  S.loadedAt = Date.now();
}
function paintSkeletons(){
  destroyCharts();
  $('#p-identity').innerHTML = '<div class="skeleton sk-identity"></div>';
  $('#p-metrics').innerHTML = '<div class="metric skeleton sk-metric"></div>'.repeat(7);
  ['#pools-body','#comp-body','#foot-body','#risk-body','#fees-metrics'].forEach(s => {
    const n = $(s); if (n) n.innerHTML = '<div class="skeleton" style="height:118px"></div>';
  });
  $$('.chart-box').forEach(b => { if (!b.querySelector('.skeleton')) b.prepend(el('div','skeleton sk-fill')); });
}
function clearSk(root){ root && $$('.skeleton', root).forEach(n => n.remove()); }
function destroyCharts(){
  Object.values(S.charts).forEach(c => { try{ c.destroy(); }catch(_){} });
  S.charts = {};
}

/* ---------------------------------------------------------------- faults UI */
function overlayFault(box, what, err, replace){
  if (!box) return;
  $$('.state', box).forEach(n => n.remove());
  const d = el('div', 'state err');
  d.innerHTML = `<div class="st-t">${esc(what)} unavailable</div>
    <div class="st-d">${err ? esc(err.status ? `HTTP ${err.status}` : err.message) : 'request failed'} · not showing a substitute value</div>
    <div><button class="retry" data-retry="1" type="button">Retry</button></div>`;
  if (replace){ box.innerHTML=''; box.appendChild(d); }
  else { box.appendChild(d); if (box.querySelector('canvas')) box.querySelector('canvas').style.visibility='hidden'; }
}
function renderAlerts(){
  const bar = $('#alertbar');
  if (!bar) return;
  if (!S.faults.length){ bar.hidden = true; bar.innerHTML=''; return; }
  const uniq = {};
  S.faults.forEach(f => { uniq[f.where + ' ' + f.msg] = true; });
  bar.hidden = false;
  bar.innerHTML = `<span class="ab-t">DATA GAPS</span>
    <ul>${Object.keys(uniq).map(k => `<li>${esc(k)}</li>`).join('')}</ul>`;
}

/* ---------------------------------------------------------------- identity */
function renderIdentity(){
  const p = S.proto, box = $('#p-identity');
  clearSk(box);
  const cc = currentChainTvl(p);
  const allChains = chainList(p);
  const initials = String(p.name||'?').replace(/[^A-Za-z ]/g,'').split(/\s+/).map(w=>w[0]).join('').slice(0,2).toUpperCase() || '··';
  const logo = p.logo
    ? `<div class="id-logo"><img src="${esc(p.logo)}" alt="" onerror="this.parentNode.textContent='${initials}'"></div>`
    : `<div class="id-logo">${initials}</div>`;

  /* badges lead with chains that actually hold TVL */
  const badgeChains = cc.map(c => c.chain).concat(allChains.filter(c => !cc.some(x => x.chain === c)));
  const visible = badgeChains.slice(0, 9);
  const hidden  = badgeChains.length - visible.length;
  const badges = visible.length
    ? visible.map(c => {
        const row = cc.find(x => x.chain === c);
        return `<span class="chip" title="${esc(c)}${row?` · ${usd(row.tvl,1)} TVL`:' · no TVL attributed'}"><b>${esc(c)}</b></span>`;
      }).join('') + (hidden > 0 ? `<span class="chip" title="listed with no current TVL">+${hidden} idle</span>` : '')
    : `<span class="chip">${esc(p.chain||'—')}</span>`;

  const audits = Number(p.audits);
  const hacks  = Array.isArray(p.hacks) ? p.hacks.length : 0;
  const sym    = p.symbol && p.symbol !== '-' ? `<span class="id-sym">${esc(p.symbol)}</span>` : '';
  const mcap   = Number.isFinite(p.mcap) && p.mcap > 0
    ? `<span class="chip" title="market cap reported by DefiLlama">MCAP <b>${usd(p.mcap,2)}</b></span>` : '';
  const cat    = p.category ? `<span class="chip cat">${esc(p.category)}</span>` : '';
  const hackChip = hacks ? `<span class="chip warnish" title="incident records held by DefiLlama">AUDIT LOG ${hacks} HACK${hacks>1?'S':''}</span>` : '';
  const exts = [
    p.url      ? `<a class="chip ext" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(site(p.url))}</a>` : '',
    p.twitter  ? `<a class="chip ext" href="https://x.com/${esc(String(p.twitter).replace(/^@/,''))}" target="_blank" rel="noopener">X @${esc(String(p.twitter).replace(/^@/,''))}</a>` : '',
    p.gecko_id ? `<a class="chip ext" href="https://www.coingecko.com/en/coins/${esc(p.gecko_id)}" target="_blank" rel="noopener">gecko</a>` : '',
  ].join('');

  box.innerHTML = `${logo}
    <div class="id-main">
      <div class="id-name">${esc(p.name)}${sym}</div>
      <div class="id-desc">${esc(clean(p.description))}</div>
    </div>
    <div class="id-chips">${cat}${mcap}${badges}${hackChip}${exts}</div>`;

  $('#alloc-sub').textContent = `${cc.length} chain${cc.length===1?'':'s'} with non-zero TVL`;
}
const site = u => { try{ return new URL(u).hostname.replace(/^www\./,''); }catch(_){ return 'site'; } };
const clean = s => String(s||'').replace(/\s+/g,' ').trim();

/* chain → usd, restricted to real chain names (drops 'staking', 'Ethereum-staking', …) */
function chainList(p){
  if (Array.isArray(p.chains) && p.chains.length) return [...new Set(p.chains)];
  if (p.chain) return [p.chain];
  return Object.keys(p.chainTvls || {});
}
function currentChainTvl(p){
  const real = new Set(chainList(p));
  const src  = p.currentChainTvls || {};
  return Object.entries(src)
    .filter(([k,v]) => real.has(k) && Number.isFinite(v) && v > 0)
    .map(([k,v]) => ({ chain:k, tvl:v }))
    .sort((a,b) => b.tvl - a.tvl);
}

/* ---------------------------------------------------------------- metrics */
function metricCell(label, valueHTML, noteHTML, hero, title){
  return `<div class="metric${hero?' m-hero':''}">
    <div class="m-lbl">${label}</div><div class="m-val">${valueHTML}</div>
    <div class="m-note"${title?` title="${esc(title)}"`:''}>${noteHTML||'&nbsp;'}</div></div>`;
}
function renderMetrics(){
  const box = $('#p-metrics');
  clearSk(box);
  const p = S.proto;
  if (!p) return;
  const series = normSeries(p.tvl);
  if (!series.length){ box.innerHTML = `<div class="metric" style="grid-column:1/-1"><div class="m-lbl">TVL</div><div class="m-val">${NA}</div><div class="m-note">no observations returned</div></div>`; return; }
  const last = series[series.length-1];
  const all  = series.map(x=>x.v);
  const peak = Math.max(...all);
  const c1 = changeOver(series, DAY), c7 = changeOver(series, 7*DAY), c30 = changeOver(series, 30*DAY);

  /* TVL-weighted blended pool APY — arithmetic over DefiLlama Yields rows only */
  const wt = S.pools.reduce((a,x) => a + ((x.tvlUsd||0) * (x.apy==null?0:x.apy)), 0);
  const wtv = S.pools.reduce((a,x) => a + (x.tvlUsd||0) * (x.apy==null?0:1), 0);
  const blended = S.pools.length && wtv > 0 ? wt/wtv : null;
  const poolCov = S.pools.length ? wtv / last.v * 100 : null;

  /* fees ÷ tvl, both live */
  const f = S.fees || {};
  const annual = Number.isFinite(f.annualized1y) ? f.annualized1y : (Number.isFinite(f.total1y) ? f.total1y : null);
  const feeTvl = annual != null && last.v > 0 ? annual / last.v * 100 : null;

  box.innerHTML = [
    metricCell('Total Value Locked', `<span>${usd(last.v,1)}</span>`,
      `${fshort(last.t)} · ${deltaHTML(c30 && c30.pct, 1)} 30d`, true,
      `Latest DefiLlama observation: ${fdatetime(last.t)}. 30-day change from the same daily series.`),

    metricCell('24h Change', c1 ? deltaHTML(c1.pct, 2, true) : NA,
      c1 ? `vs ${fshort(c1.baseT)} · Δ${c1.span}d` : 'series too short',
      false, c1 ? `Baseline observation ${fdatetime(c1.baseT)}` : ''),

    metricCell('7d Change', c7 ? deltaHTML(c7.pct, 2, true) : NA,
      c7 ? `vs ${fshort(c7.baseT)} · Δ${c7.span}d` : 'series too short',
      false, c7 ? `Baseline observation ${fdatetime(c7.baseT)}` : ''),

    metricCell('Blended Pool APY', blended==null ? NA : `<span>${pct(blended,2,false)}</span>`,
      blended==null ? 'no pool rows returned' : `${plural(S.pools.length,'pool')} · ${poolCov.toFixed(0)}% of TVL`,
      false, 'TVL-weighted mean of the APY field across this protocol\'s DefiLlama Yields rows'),

    metricCell('Fees 24h', f.total24h != null ? usd(f.total24h,1) : (f.unavailable ? '<span class="na">not tracked</span>' : NA),
      f.total24h != null ? `${deltaHTML(f.change_1d)} d/d · 7d ${usd(f.total7d,1)}`
      : (f.error ? esc(f.reason) : (f.chains||[]).length ? `fee chains: ${(f.chains||[]).join(', ')}` : '—'),
      false, `Source: /summary/fees/${S.slug} · fee chains: ${(f.chains||[]).join(', ')||'n/a'}`),

    metricCell('Fee ÷ TVL', feeTvl==null ? NA : `<span>${pct(feeTvl,2,false)}</span>`,
      'annualised fees ÷ TVL', false,
      annual==null ? 'annualised fee figure unavailable' : `${usdFull(annual)} annualised fees over ${usdFull(last.v)} TVL`),

    metricCell('TVL Rank', S.rank ? `<span>#${S.rank.overall}</span>` : `<span class="na">indexing…</span>`,
      S.rank ? `of ${int(S.rank.total)} · #${S.rank.inCat} in category` : 'loading directory…',
      false, S.rank ? `#${S.rank.overall} of ${int(S.rank.total)} protocols by TVL · #${S.rank.inCat} of ${int(S.rank.catTotal)} in ${S.rank.category}` : 'Rank needs /protocols'),
  ].join('');
}

/* ---------------------------------------------------------------- TVL chart */
function renderTvl(){
  const p = S.proto, box = $('.chart-tvl');
  clearSk(box);
  $$('.state', box).forEach(n=>n.remove());
  const canvas = box.querySelector('canvas') || box.appendChild(el('canvas'));
  canvas.style.visibility = '';

  const full = normSeries(p.tvl);
  if (!full.length) throw new ApiError('TVL series contains no finite observations', 200, `${API}/protocol/${S.slug}`);
  const span = RANGES[S.range];
  const win  = windowSlice(full, span);
  const last = full[full.length-1];

  const datasets = [];
  const cmpActive = !!S.cmp;
  if (cmpActive){
    const a = normSeries(S.cmp.tvl);
    const aw = windowSlice(a, span);
    datasets.push(lineDS(S.name, win, PALETTE[0]));
    datasets.push(lineDS(S.cmp.name || S.compare, aw, PALETTE[2]));
  } else {
    datasets.push(areaDS(S.name, win, PALETTE[0]));
  }

  destroy('tvl');
  S.charts.tvl = new Chart(canvas, {
    type:'line',
    data:{ datasets },
    options:{
      responsive:true, maintainAspectRatio:false, animation:{ duration:420 },
      interaction:{ mode:'index', intersect:false, axis:'x' },
      layout:{ padding:{ top:6, right:6 } },
      scales:{
        x:{ type:'time',
            time:{ utc:true, tooltipFormat:'dd MMM yyyy',
                   displayFormats:{ day:'dd MMM', week:'dd MMM', month:'MMM yyyy', year:'yyyy' } },
            grid:{ color:'rgba(255,255,255,.035)', drawTicks:false },
            border:{ color:'#1B222C' },
            ticks:{ color:'#626D7C', font:{ family:'JetBrains Mono', size:10 }, maxRotation:0, autoSkipPadding:24, padding:6 } },
        y:{ type:'linear', beginAtZero:!cmpActive,
            grid:{ color:'rgba(255,255,255,.035)' }, border:{ display:false },
            ticks:{ color:'#626D7C', font:{ family:'JetBrains Mono', size:10 }, padding:8,
                    callback: v => cmpActive ? v.toFixed(0) : usd(v, v>=1e9?2:0) } }
      },
      plugins:{
        legend:{ display: cmpActive, labels:{ color:'#95A0B0', boxWidth:9, boxHeight:9, usePointStyle:true,
                 font:{ family:'Inter Tight', size:11 } } },
        tooltip:{
          backgroundColor:'#0B1017', borderColor:'#2E3946', borderWidth:1, padding:10,
          titleColor:'#E3E9F2', bodyColor:'#95A0B0', titleFont:{ family:'JetBrains Mono', size:11 },
          bodyFont:{ family:'JetBrains Mono', size:11.5 }, displayColors:true, boxWidth:8, boxHeight:8, boxPadding:4,
          callbacks:{ label: ctx => ` ${ctx.dataset.label}  ${cmpActive ? `index ${ctx.parsed.y.toFixed(1)}` : usdFull(ctx.parsed.y)}` }
        }
      }
    }
  });

  $('#tvl-sub').textContent = cmpActive
    ? `indexed to 100 at window start · ${win.length} daily points`
    : `${win.length} daily observations · ${fdate(win[0].t)} → ${fdate(last.t)}`;
  renderTvlFoot();
}
function areaDS(label, pts, color){
  return { label, data: pts.map(p=>({ x:p.t, y:p.v })), borderColor:color, borderWidth:1.6,
           fill:true, backgroundColor(ctx){
             const {chart} = ctx; const area = chart.chartArea; if(!area) return 'transparent';
             const g = chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
             g.addColorStop(0, hexA(color,.26)); g.addColorStop(1, hexA(color,.01)); return g;
           },
           pointRadius:0, pointHoverRadius:3.5, pointHoverBackgroundColor:color,
           pointHoverBorderColor:'#0B1017', tension:.22 };
}
function lineDS(label, pts, color){
  const first = pts.length ? pts[0].v : null;
  const data  = pts.map(p => ({ x:p.t, y: first ? p.v/first*100 : p.v }));
  return { label, data, borderColor:color, borderWidth:1.6, fill:false, pointRadius:0,
           pointHoverRadius:3.5, tension:.22 };
}
function hexA(hex, a){
  const h = hex.replace('#','');
  const n = h.length===3 ? h.split('').map(c=>c+c).join('') : h;
  const i = parseInt(n,16);
  return `rgba(${(i>>16)&255},${(i>>8)&255},${i&255},${a})`;
}
function renderTvlFoot(){
  const p = S.proto; if (!p) return;
  const full = normSeries(p.tvl);
  if (!full.length) return;
  const span = RANGES[S.range];
  const win  = windowSlice(full, span);
  const all  = full.map(x=>x.v);
  const peak = Math.max(...all), peakPt = full[all.indexOf(peak)];
  const last = full[full.length-1];
  const wc   = win.length>1 ? (win[win.length-1].v - win[0].v)/win[0].v*100 : null;
  const dd   = (last.v - peak)/peak*100;
  $('#tvl-foot').innerHTML = [
    `window <b>${deltaHTML(wc,1)}</b>`,
    `all-time peak <b>${usd(peak,1)}</b> ${fdate(peakPt.t)}`,
    `from peak <b>${deltaHTML(dd,1)}</b>`,
    `history since <b>${fdate(full[0].t)}</b> (${full.length} pts)`,
  ].map(s=>`<span>${s}</span>`).join('');
}
function destroy(k){ if (S.charts[k]){ try{S.charts[k].destroy();}catch(_){} delete S.charts[k]; } }

/* ---------------------------------------------------------------- allocation */
function renderAlloc(){
  const box = $('.chart-donut'); clearSk(box); $$('.state', box).forEach(n=>n.remove());
  const canvas = box.querySelector('canvas') || box.appendChild(el('canvas'));
  let center = $('#donut-center');
  if (!center){ center = el('div','donut-center'); center.id = 'donut-center'; box.appendChild(center); }
  const rows = currentChainTvl(S.proto);
  const total = rows.reduce((a,r)=>a+r.tvl,0);

  $('#alloc-legend').innerHTML = '';
  if (!rows.length || !(total>0)){
    box.querySelector('canvas').style.visibility='hidden';
    center.innerHTML = '';
    $('#alloc-legend').innerHTML = `<div class="state"><div class="st-t">No chain breakdown</div>
      <div class="st-d">currentChainTvls returned nothing attributable to a listed chain</div></div>`;
    destroy('alloc'); return;
  }
  canvas.style.visibility='';
  const shown = rows.slice(0,7);
  const rest  = rows.slice(7).reduce((a,r)=>a+r.tvl,0);
  const data  = rest > 0 ? [...shown, { chain:'Other', tvl:rest, other:true }] : shown;
  const colors= data.map((d,i) => d.other ? OTHER_COLOR : PALETTE[i % PALETTE.length]);

  destroy('alloc');
  S.charts.alloc = new Chart(canvas, {
    type:'doughnut',
    data:{ labels: data.map(d=>d.chain),
      datasets:[{ label:'Chain TVL', data: data.map(d=>d.tvl), backgroundColor: colors, borderColor:'#0E1218',
                  borderWidth:1.5, hoverOffset:5, hoverBorderColor:'#141B26' }] },
    options:{ responsive:true, maintainAspectRatio:false, cutout:'68%', animation:{ duration:420 },
      plugins:{ legend:{ display:false },
        tooltip:{ backgroundColor:'#0B1017', borderColor:'#2E3946', borderWidth:1, padding:9,
          titleColor:'#E3E9F2', bodyColor:'#95A0B0', bodyFont:{ family:'JetBrains Mono', size:11.5 },
          callbacks:{ label: ctx => ` ${usdFull(ctx.parsed)} · ${(ctx.parsed/total*100).toFixed(1)}%` } } } }
  });
  center.innerHTML = `<div class="dc-v num">${usd(total,1)}</div><div class="dc-l">chain TVL</div>`;

  $('#alloc-legend').innerHTML = data.slice(0,8).map((d,i) => {
    const share = d.tvl/total*100;
    const c = d.other ? OTHER_COLOR : PALETTE[i % PALETTE.length];
    return `<li class="lg-row">
      <span class="lg-sw" style="background:${c}"></span>
      <span class="lg-nm">${esc(d.chain)}</span>
      <span class="lg-v">${usd(d.tvl,1)}</span>
      <span class="lg-p">${share>=10 ? share.toFixed(0)+'%' : share.toFixed(1)+'%'}</span>
      <span class="lg-bar"><i style="width:${Math.max(share,.6)}%;background:${c}"></i></span>
    </li>`;
  }).join('');
}

/* ---------------------------------------------------------------- fees */
function renderFees(){
  const f = S.fees || {};
  const box = $('#fees-metrics'); clearSk(box);

  if (f.error || f.unavailable || (f.total24h == null && f.total7d == null && f.total30d == null)){
    box.innerHTML = `<div style="grid-column:1/-1"><div class="state">
      <div class="st-t">Fee data ${f.unavailable ? 'not published' : 'unavailable'}</div>
      <div class="st-d">${esc(f.reason || 'no /summary/fees response')}<br>— /summary/fees/${esc(S.slug)}</div>
      ${f.error ? '<div><button class="retry" data-retry="1" type="button">Retry</button></div>' : ''}</div></div>`;
    $('#fees-sub').textContent = '';
    $('#fees-method').textContent = '';
    const cb = $('.chart-fees'); clearSk(cb); $$('.state',cb).forEach(n=>n.remove());
    if (cb.querySelector('canvas')) cb.querySelector('canvas').style.visibility='hidden';
    overlayFault(cb, 'Fee history', f.error ? { message: f.reason } : null, false);
    destroy('fees');
    return;
  }
  const cb = Object.values(f.chainBreakdown || {});
  const sum = (k) => { const v = cb.map(x=>x[k]).filter(Number.isFinite); return v.length ? v.reduce((a,b)=>a+b,0) : null; };
  const t7 = sum('total7d'), t14 = sum('total14dto7d'), t30 = sum('total30d'), t60 = sum('total60dto30d');
  const wow = t7 && t14 ? (t7-t14)/t14*100 : null;
  const mom = t30 && t60 ? (t30-t60)/t60*100 : null;
  const ytd = Number.isFinite(f.totalAllTime) ? f.totalAllTime : null;

  $('#fees-sub').textContent = `fee chains: ${(f.chains||[]).join(', ') || '—'} · ${esc(f.category||'')}`;
  box.innerHTML = [
    ['24h', usd(f.total24h,1), `${deltaHTML(f.change_1d,1)} d/d`],
    ['7d',  usd(f.total7d,1),  wow==null?'w/w n/a':`${deltaHTML(wow,1)} w/w`],
    ['30d', usd(f.total30d,1), mom==null?'m/m n/a':`${deltaHTML(mom,1)} m/m`],
    ['All time', usd(ytd, ytd>=1e6?1:0), Number.isFinite(f.total1y)?`${usd(f.total1y,1)} last 12m`:''],
  ].map(([l,v,s]) => `<div class="mm"><div class="mm-l">${l}</div><div class="mm-v">${v}</div><div class="mm-s">${s||'&nbsp;'}</div></div>`).join('');

  const meth = f.methodology || {};
  const key = Object.keys(meth)[0];
  $('#fees-method').innerHTML = key
    ? `<b>DefiLlama methodology — ${esc(key)}:</b> ${esc(clean(meth[key]))}`
    : `<b>Methodology</b> not published in the API response.`;

  const series = (f.totalDataChart||[]).filter(x=>Array.isArray(x) && Number.isFinite(x[0]) && Number.isFinite(x[1]))
    .map(x => ({ t:x[0]*1000, v:x[1] })).sort((a,b)=>a.t-b.t);
  const span = RANGES[S.range] || 90*DAY;
  const endT = series.length ? series[series.length-1].t : Date.now();
  const win  = series.filter(x => x.t >= endT - span);
  const chartBox = $('.chart-fees'); clearSk(chartBox); $$('.state', chartBox).forEach(n=>n.remove());
  const canvas = chartBox.querySelector('canvas') || chartBox.appendChild(el('canvas'));
  canvas.style.visibility='';

  if (win.length < 2){
    overlayFault(chartBox, 'Fee history', { message:'fewer than 2 daily points' }, false);
    destroy('fees'); return;
  }
  destroy('fees');
  S.charts.fees = new Chart(canvas, {
    type:'bar',
    data:{ datasets:[
      { label:'daily', data: win.map(p=>({x:p.t,y:p.v})), backgroundColor: hexA(PALETTE[0],.42),
        borderColor: hexA(PALETTE[0],.85), borderWidth:.5, borderRadius:0, categoryPercentage:1, barPercentage:.96, order:2 },
      { label:'7d mean', type:'line', data: ma(win,7).map(p=>({x:p.t,y:p.v})), borderColor: PALETTE[2],
        borderWidth:1.4, pointRadius:0, tension:.3, order:1 }
    ]},
    options:{ responsive:true, maintainAspectRatio:false, animation:{ duration:320 },
      interaction:{ mode:'index', intersect:false, axis:'x' },
      scales:{
        x:{ type:'time', time:{ utc:true, tooltipFormat:'dd MMM yyyy' },
            grid:{ display:false }, border:{ color:'#1B222C' },
            ticks:{ color:'#414B58', font:{ family:'JetBrains Mono', size:9.5 }, maxRotation:0, autoSkipPadding:20 } },
        y:{ beginAtZero:true, grid:{ color:'rgba(255,255,255,.03)' }, border:{ display:false },
            ticks:{ color:'#414B58', font:{ family:'JetBrains Mono', size:9.5 }, maxTicksLimit:4, padding:6,
                    callback: v => usd(v,0) } } },
      plugins:{ legend:{ display:true, labels:{ color:'#95A0B0', boxWidth:8, boxHeight:8, usePointStyle:true, font:{ family:'Inter Tight', size:10.5 } } },
        tooltip:{ backgroundColor:'#0B1017', borderColor:'#2E3946', borderWidth:1, padding:9,
          titleColor:'#E3E9F2', bodyColor:'#95A0B0', bodyFont:{ family:'JetBrains Mono', size:11.5 }, boxWidth:8, boxHeight:8,
          callbacks:{ label: c => ` ${c.dataset.label}: ${usdFull(c.parsed.y)}` } } } }
  });
}
function ma(pts, w){
  const out = [];
  for (let i=0;i<pts.length;i++){
    const s = pts.slice(Math.max(0,i-w+1), i+1);
    out.push({ t:pts[i].t, v: s.reduce((a,b)=>a+b.v,0)/s.length });
  }
  return out;
}

/* ---------------------------------------------------------------- pools */
function renderPools(){
  const body = $('#pools-body'); clearSk(body);
  const rows = S.pools;
  const tvlNow = (normSeries(S.proto.tvl).at(-1)||{}).v;

  if (!rows.length){
    $('#pools-sub').textContent = '';
    body.innerHTML = `<div class="state" style="margin-top:4px">
      <div class="st-t">No pools tracked for this protocol</div>
      <div class="st-d">yields.llama.fi returns no row with <b>project = ${esc(S.slug)}</b>
        (searched ${int(S.poolsCache ? S.poolsCache.length : 0)} pools).<br>
        TVL, chain and fee panels above are unaffected — pool-level yield analytics simply
        aren't published for this protocol, so no substitute rows are invented.</div>
      <div><a class="retry" style="display:inline-flex;align-items:center;height:25px;padding:0 12px;text-decoration:none"
        href="https://defillama.com/yields?project=${esc(S.slug)}" target="_blank" rel="noopener">open on DefiLlama Yields</a></div></div>`;
    return;
  }
  const poolTvl = rows.reduce((a,r)=>a+(r.tvlUsd||0),0);
  const cov = tvlNow ? poolTvl/tvlNow*100 : null;
  $('#pools-sub').innerHTML = `${plural(rows.length,'pool')} · <b style="color:var(--txt-2)">${usd(poolTvl,1)}</b> tracked
    · ${cov==null?'—':cov.toFixed(0)+'%'} of protocol TVL · project=<span style="color:var(--txt-2)">${esc(S.poolProject)}</span>`;

  const sorted = rows.slice().sort((a,b)=>{
    const k = S.sort.key, d = S.sort.dir;
    const va = valFor(a,k), vb = valFor(b,k);
    if (va==null && vb==null) return 0;
    if (va==null) return 1; if (vb==null) return -1;
    return (va-vb)*d;
  }).slice(0, POOL_LIMIT);

  /* only columns backed by a numeric field are clickable */
  const th  = (key, label, right) =>
    `<th data-key="${key}" class="${S.sort.key===key?'active':''}${right?' numh':''}">${label}<span class="sort">${S.sort.key===key?(S.sort.dir<0?'▾':'▴'):'▾'}</span></th>`;
  const thx = (label, right) => `<th class="${right?' numh':''}">${label}</th>`;

  const chainColor = chainPaletteMap(rows);
  body.innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr>
      ${thx('Pool')}${thx('Chain')}${th('tvlUsd','Pool TVL',1)}
      ${th('apy','APY',1)}${th('apyMean30d','30d mean',1)}${th('probability','Quality signal')}
      ${thx('Structure')}
    </tr></thead><tbody>${sorted.map(r => rowHTML(r, chainColor)).join('')}</tbody></table></div>
    <div class="p-foot"><span>Signal = DefiLlama's published <b>predictions</b> object for the pool (class, probability, binned confidence 1–3)</span>
    <span>σ = provider-reported APY volatility · n = daily observations</span></div>`;
}
function valFor(r, key){
  if (key === 'probability'){ const p = (r.predictions||{}).predictedProbability; return Number.isFinite(p)?p:null; }
  if (key === 'symbol' || key === 'chain' || key === 'risk') return null;
  const v = r[key]; return Number.isFinite(v) ? v : null;
}
function chainPaletteMap(rows){
  const chains = [...new Set(rows.map(r=>r.chain))];
  const m = {}; chains.forEach((c,i)=>{ m[c] = PALETTE[i % PALETTE.length]; }); return m;
}
function rowHTML(r, colors){
  const pr = r.predictions || {};
  const cls = pr.predictedClass;
  const prob = Number.isFinite(pr.predictedProbability) ? pr.predictedProbability : null;
  const conf = Number.isFinite(pr.binnedConfidence) ? pr.binnedConfidence : null;
  const badge = cls
    ? `<span class="sig-badge ${/up|stable/i.test(cls)?'up':'down'}">${esc(cls)} · ${prob==null?'—':prob.toFixed(0)+'%'}</span>`
    : `<span class="sig-badge na">no signal</span>`;
  const dots = [1,2,3].map(i => `<i class="${conf&&i<=conf?'on':''}"></i>`).join('');
  const apyBase = Number.isFinite(r.apyBase) ? r.apyBase : null;
  const apyRew  = Number.isFinite(r.apyReward) ? r.apyReward : null;
  const split   = apyBase!=null && apyRew!=null ? `base ${apyBase.toFixed(2)} + rew ${apyRew.toFixed(2)}`
                : apyBase!=null ? `base ${apyBase.toFixed(2)}` : apyRew!=null ? `reward ${apyRew.toFixed(2)}` : '';
  const meta = r.poolMeta ? `<span class="pool-meta">${esc(r.poolMeta)}</span>` : '';

  const fl = [];
  fl.push(`<span class="flag ${r.exposure==='single'?'tone-pos':''}">${esc(r.exposure||'n/a')} exposure</span>`);
  fl.push(`<span class="flag ${r.ilRisk==='yes'?'tone-neg':(r.ilRisk==='no'?'tone-pos':'')}">${r.ilRisk==='yes'?'IL risk':r.ilRisk==='no'?'no IL':'IL n/a'}</span>`);
  if (r.stablecoin) fl.push('<span class="flag tone-pos">stablecoin</span>');
  if (r.outlier)    fl.push('<span class="flag tone-warn">flagged outlier</span>');

  return `<tr>
    <td class="pool"><div class="pool-nm"><span class="pool-sym">${esc(r.symbol||'—')}</span></div>${meta}</td>
    <td><span class="chain-tag"><i style="background:${colors[r.chain]||OTHER_COLOR}"></i>${esc(r.chain||'—')}</span></td>
    <td class="numc">${usd(r.tvlUsd, r.tvlUsd>=1e6?2:1)}</td>
    <td class="numc">${Number.isFinite(r.apy)?r.apy.toFixed(2)+'%':'<span class="na">—</span>'}
      <div class="apy-split">${split}</div></td>
    <td class="numc" style="color:${divergence(r)}">${Number.isFinite(r.apyMean30d)?r.apyMean30d.toFixed(2)+'%':'<span class="na">—</span>'}</td>
    <td><div class="sig">${badge}<span class="conf" title="binned confidence ${conf??'n/a'}">${dots}</span></div>
      <div class="sig-ev">σ ${Number.isFinite(r.sigma)?r.sigma.toFixed(3):'—'} · n ${int(r.count)}</div></td>
    <td><div class="flags">${fl.join('')}</div></td>
  </tr>`;
}
function divergence(r){
  const a = r.apy, m = r.apyMean30d;
  if (!Number.isFinite(a) || !Number.isFinite(m) || m <= 0) return 'var(--txt-2)';
  const ratio = a / m;
  if (ratio < .7) return 'var(--warn)';
  if (ratio > 1.4) return 'var(--info)';
  return 'var(--txt-2)';
}

/* ---------------------------------------------------------------- composition */
function renderComposition(){
  const body = $('#comp-body'); clearSk(body);
  const pts = S.proto.tokensInUsd;
  const last = Array.isArray(pts) && pts.length ? pts[pts.length-1] : null;
  const toks = last && last.tokens ? Object.entries(last.tokens).filter(([,v])=>Number.isFinite(v)&&v>0).sort((a,b)=>b[1]-a[1]) : [];
  const total = toks.reduce((a,[,v])=>a+v,0);
  if (!toks.length || !(total>0)){
    $('#comp-sub').textContent = '';
    body.innerHTML = `<div class="state"><div class="st-t">Token breakdown not published</div>
      <div class="st-d">tokensInUsd returned ${Array.isArray(pts)?pts.length+' rows':'no rows'} for this protocol</div></div>`;
    return;
  }
  const rest = toks.slice(8);
  /* a lone leftover asset is named, not buried inside "Other" */
  const rows = rest.length > 1 ? [...toks.slice(0,8), ['Other', rest.reduce((a,[,v])=>a+v,0)]] : toks.slice(0,9);
  const max = rows[0][1];
  $('#comp-sub').textContent = `${plural(toks.length,'asset')} · ${fdate(last.date*1000)} snapshot`;
  body.innerHTML = `<div class="comp">` + rows.map(([k,v],i) => {
    const sh = v/total*100;
    const c = k==='Other' ? OTHER_COLOR : PALETTE[i % PALETTE.length];
    return `<div class="comp-row" title="${esc(k)} · ${usdFull(v)} · ${sh.toFixed(2)}% of tracked assets">
      <span class="comp-tk">${esc(k)}</span>
      <span class="comp-track"><i style="width:${(v/max*100).toFixed(1)}%;background:${c}"></i></span>
      <span class="comp-v">${usd(v,1)}<em>${sh>=10?sh.toFixed(0)+'%':sh.toFixed(1)+'%'}</em></span></div>`;
  }).join('') + `</div>
    <div class="p-foot"><span>total tracked <b>${usd(total,1)}</b></span><span>largest asset <b>${esc(rows[0][0])}</b> ${(rows[0][1]/total*100).toFixed(1)}%</span></div>`;
}

/* ---------------------------------------------------------------- footprint */
function renderFootprint(){
  const body = $('#foot-body'); clearSk(body);
  const ct = S.proto.chainTvls || {};
  const real = new Set(chainList(S.proto));
  const items = Object.entries(ct).filter(([k])=>real.has(k)).map(([k,v]) => {
    const s = normSeries(v && v.tvl);
    const first = s.find(p => p.v > 0);
    const cur = currentChainTvl(S.proto).find(x=>x.chain===k);
    return { chain:k, first:first ? first.t : null, v: s.map(p=>p.v), obs:s.length, now: cur ? cur.tvl : (s.at(-1)||{}).v };
  }).sort((a,b) => (a.first??Infinity) - (b.first??Infinity));

  if (!items.length){
    body.innerHTML = `<div class="state"><div class="st-t">No per-chain series</div><div class="st-d">chainTvls returned no rows matching the protocol's chain list</div></div>`;
    return;
  }
  const total = items.reduce((a,x)=>a+(x.now||0),0) || 1;
  body.innerHTML = `<div class="timeline">` + items.map((x,i) => {
    const c = PALETTE[i % PALETTE.length];
    const peak = x.v.length ? Math.max(...x.v) : null;
    const share = (x.now/total*100);
    return `<div class="tl-row">
      <span class="tl-dot" style="background:${c}"></span>
      <span>
        <div class="tl-nm">${esc(x.chain)}</div>
        <div class="tl-when">first TVL ${x.first?fdate(x.first):'n/a'} · ${x.obs} daily obs · peak ${usd(peak,1)}</div>
        <div class="lg-bar" style="margin-top:5px"><i style="width:${Math.max(share,.6)}%;background:${c}"></i></div>
      </span>
      <span><div class="tl-v">${usd(x.now,1)}</div><div class="tl-p">${share.toFixed(1)}%</div></span>
    </div>`;
  }).join('') + `</div>`;
}

/* ---------------------------------------------------------------- record */
function renderRecord(){
  const body = $('#risk-body'); clearSk(body);
  const p = S.proto, f = S.fees||{};
  const rows = [];
  const audits = Number(p.audits);
  const hacks  = Array.isArray(p.hacks) ? p.hacks.length : 0;
  rows.push(['Category', p.category || '—']);
  rows.push(['Listed', p.listedAt ? fdate(p.listedAt*1000) : '—']);
  rows.push(['Chains', `${chainList(p).length}`]);
  rows.push(['Audits', Number.isFinite(audits) ? `${audits}` : '—']);
  rows.push(['Incident records', hacks ? `${hacks}` : '0']);
  if ((p.audit_links||[]).length) rows.push(['Audit docs', `<a href="${esc(p.audit_links[0])}" target="_blank" rel="noopener">${p.audit_links.length} link${p.audit_links.length>1?'s':''}</a>`]);
  rows.push(['Fees all-time', Number.isFinite(f.totalAllTime) ? usd(f.totalAllTime, f.totalAllTime>=1e6?1:0) : (f.unavailable?'not tracked':'—')]);
  rows.push(['Pool rows used', S.poolProject ? esc(S.poolProject) : '—']);
  rows.push(['Adapter', p.module ? `<span title="${esc(p.module)}">${esc(String(p.module).split('/')[0])}</span>` : '—']);
  rows.push(['DefiLlama id', p.id ? esc(p.id) : '—']);
  if (Number.isFinite(p.mcap)) rows.push(['Market cap', usd(p.mcap,2)]);
  if (S.rank) rows.push(['TVL rank', `#${S.rank.overall} / ${int(S.rank.total)}`]);

  body.innerHTML = `<dl class="deflist">` + rows.map(([k,v]) =>
    `<dt>${k}</dt><dd class="${typeof v==='string'&&!v.includes('class=')?'hi':''}">${v}</dd>`).join('') + `</dl>`;
}

/* ---------------------------------------------------------------- status */
function updateStatus(kind){
  const dot = $('#status-dot'), txt = $('#status-txt');
  dot.className = 'dot' + (kind==='live' ? ' live' : kind==='error' ? ' err' : kind==='partial' ? ' live' : ' load');
  const t = S.loadedAt ? ` · ${ftime(S.loadedAt)}` : '';
  txt.textContent = kind==='live' ? `LIVE${t}` : kind==='partial' ? `LIVE · partial${t}`
    : kind==='error' ? 'FETCH FAILED' : 'fetching…';
}

/* ---------------------------------------------------------------- controls */
function fillCompare(){
  const sel = $('#compare-select');
  if (!sel) return;
  const cat = S.proto && S.proto.category;
  const peers = (S.index && cat)
    ? S.index.filter(d => d.category === cat && d.slug !== S.slug)
             .sort((a,b)=>b.tvl-a.tvl).slice(0,20).map(d => [d.slug, d.name])
    : [];
  const keep = S.compare;
  sel.innerHTML = '';
  const none = el('option'); none.value=''; none.textContent='— none —'; sel.appendChild(none);
  const addGroup = (label, items) => {
    if (!items.length) return;
    const g = el('optgroup'); g.label = label;
    items.forEach(([v,t]) => { const o = el('option'); o.value=v; o.textContent=t||v; g.appendChild(o); });
    sel.appendChild(g);
  };
  addGroup('Demo set', CURATED);
  addGroup(`Peers · ${cat||'category'}`, peers);
  if (keep){
    if (![...sel.options].some(o => o.value === keep)){
      const o = el('option'); o.value = keep; o.textContent = keep; sel.appendChild(o);
    }
    sel.value = keep;
  }
}
async function loadCompare(slug, silent){
  if (!slug){ S.cmp=null; renderTvl(); return; }
  try{
    const p = await getJSON(`${API}/protocol/${encodeURIComponent(slug)}`, 60000);
    if (!p || !Array.isArray(p.tvl)) throw new ApiError('unexpected response shape', 200, 'protocol');
    S.cmp = p; S.cmp.name = p.name || slug;
  }catch(err){
    S.cmp = null; logFault(`Compare · /protocol/${slug}`, err);
  }
  if (S.proto){ renderTvl(); renderTvlFoot(); }
  if (!silent) syncURL();
}

function buildCombo(){
  const input = $('#proto-input'), list = $('#proto-list');
  let hi = -1, items = [];

  const candidates = () => {
    if (!S._sorted){
      S._sorted = S.index
        ? S.index.slice().sort((a,b)=>(b.tvl||0)-(a.tvl||0)).map(d => ({ slug:d.slug, name:d.name, category:d.category, tvl:d.tvl }))
        : CURATED.map(([slug,name]) => ({ slug, name, category:'', tvl:null }));
    }
    return S._sorted;
  };
  /* relevance first, then TVL — typing "renzo" must surface Renzo, not Lorenzo */
  const score = (c, s) => {
    if (!s) return 1;
    const n = (c.name||'').toLowerCase(), sl = (c.slug||'').toLowerCase();
    if (n === s) return 100;
    if (sl === s) return 96;
    if (n.startsWith(s)) return 90;
    if (sl.startsWith(s)) return 84;
    if (n.includes(' '+s)) return 72;
    if (sl.includes(s)) return 60;
    if (n.includes(s)) return 50;
    return 0;
  };
  const filter = q => {
    const s = String(q||'').trim().toLowerCase();
    const scored = candidates().map(c => ({ c, w: score(c, s) })).filter(x => x.w > 0);
    if (!scored.length) {
      const raw = String(q||'').trim();
      return raw ? [{ slug:raw, name:`Use slug “${raw}”`, category:'direct lookup', tvl:null }] : [];
    }
    scored.sort((a,b) => (b.w - a.w) || ((b.c.tvl||0) - (a.c.tvl||0)));
    return scored.slice(0,24).map(x => x.c);
  };
  const paint = () => {
    list.innerHTML = items.map((c,i) =>
      `<li class="combo-item${i===hi?' sel':''}" data-i="${i}" role="option" aria-selected="${i===hi}">
        <span class="ci-name">${esc(c.name)}</span><span class="ci-cat">${esc(c.category||'')}</span>
        <span class="ci-tvl">${c.tvl==null?'':usd(c.tvl,0)}</span></li>`).join('')
      + (!S.index ? `<li class="combo-note">curated set — full directory ${S.faults.some(f=>f.where.startsWith('Directory'))?'unavailable':'still indexing'}…</li>` : '');
    list.hidden = false; input.setAttribute('aria-expanded','true');
  };
  const close = () => { list.hidden = true; hi = -1; input.setAttribute('aria-expanded','false'); };

  input.addEventListener('input', () => { items = filter(input.value); hi = 0; paint(); });
  input.addEventListener('focus', () => { items = filter(input.value); hi = 0; paint(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp'){
      e.preventDefault(); if (list.hidden){ items = filter(input.value); hi=0; paint(); return; }
      hi = (hi + (e.key==='ArrowDown'?1:-1) + items.length) % items.length; paint();
      const n = list.children[hi]; if (n && n.scrollIntoView) n.scrollIntoView({ block:'nearest' });
    } else if (e.key === 'Enter'){
      e.preventDefault(); const c = items[hi<0?0:hi]; if (c){ close(); setProtocol(c.slug); }
    } else if (e.key === 'Escape'){ close(); input.blur(); }
  });
  list.addEventListener('mousedown', e => {
    const li = e.target.closest('.combo-item'); if (!li) return;
    e.preventDefault(); const c = items[+li.dataset.i]; close(); if (c) setProtocol(c.slug);
  });
  document.addEventListener('click', e => { if (!e.target.closest('#proto-combo')) close(); });
}

function syncURL(){
  try{
    const u = new URL(location.href);
    if (location.protocol === 'file:'){ return; }
    u.searchParams.set('protocol', S.slug);
    S.compare ? u.searchParams.set('compare', S.compare) : u.searchParams.delete('compare');
    u.searchParams.set('range', S.range);
    history.replaceState(null, '', u.toString());
  }catch(_){ /* file:// or unsupported — ignore silently, state still works in-memory */ }
}

/* ---------------------------------------------------------------- wire up */
function wire(){
  $$('#range-seg button').forEach(b => b.addEventListener('click', () => {
    $$('#range-seg button').forEach(x => x.classList.toggle('on', x===b));
    S.range = b.dataset.range;
    if (S.proto){ renderTvl(); renderFees(); }
    syncURL();
  }));

  $('#compare-select').addEventListener('change', e => {
    S.compare = e.target.value;
    if (!S.compare){ S.cmp = null; renderTvl(); return; }
    e.target.disabled = true;
    $('#tvl-sub').textContent = `loading ${S.compare}…`;
    loadCompare(S.compare).finally(() => { e.target.disabled = false; });
  });

  $('#refresh').addEventListener('click', () => refresh(true));
  document.addEventListener('click', e => {
    const r = e.target.closest('[data-retry]');
    if (r){ S.faults = []; renderAlerts(); refresh(true); }
    const th = e.target.closest('table.tbl th[data-key]');
    if (th && th.dataset.key){
      const k = th.dataset.key;
      S.sort = S.sort.key === k ? { key:k, dir:-S.sort.dir } : { key:k, dir:-1 };
      renderPools();
    }
  });

  document.addEventListener('keydown', e => {
    if (e.target.matches('input,select,textarea')) return;
    if (e.key === '/'){ e.preventDefault(); $('#proto-input').focus(); }
    if (e.key === 'r' || e.key === 'R'){ refresh(true); }
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) maybeAutoRefresh(); });
}
async function refresh(manual){
  const btn = $('#refresh');
  if (manual){ btn.classList.add('busy'); }
  updateStatus('loading');
  const keep = S.slug;
  S.faults = []; renderAlerts();
  S.poolsCache = null;                  // force live pool re-read
  await setProtocol(keep, { keepCompare:true });   // reloads the compare peer too
  if (manual) btn.classList.remove('busy');
}
function maybeAutoRefresh(){
  if (!S.loadedAt) return;
  if (Date.now() - S.loadedAt > AUTOREFRESH_MS) refresh(false);
}

/* ---------------------------------------------------------------- init */
async function init(){
  window.addEventListener('error', e => logFault('Runtime', e.error || { message: e.message }));
  window.addEventListener('unhandledrejection', e => logFault('Runtime', e.reason || { message: 'promise rejected' }));
  Chart.defaults.font.family = 'Inter Tight, sans-serif';
  Chart.defaults.color = '#95A0B0';
  $('#build-stamp').textContent = `Meridian · demo build ${new Date().toISOString().slice(0,10)}`;

  const params = (() => { try{ return new URLSearchParams(location.search); }catch(_){ return new URLSearchParams(); } })();
  const wanted = (params.get('protocol')||'').trim();
  const range  = params.get('range');
  const cmp    = (params.get('compare')||'').trim();
  if (RANGES[range]){ S.range = range; $$('#range-seg button').forEach(b => b.classList.toggle('on', b.dataset.range===range)); }
  if (cmp && cmp !== wanted) S.compare = cmp;

  wire();
  buildCombo();
  fillCompare();
  if (S.compare) $('#compare-select').value = S.compare;

  try{
    await setProtocol(wanted || 'ember-protocol');
  }catch(err){
    logFault('Init', err);
    updateStatus('error');
  }finally{
    const v = $('#boot-veil');
    if (v){ v.classList.add('off'); setTimeout(() => v.remove(), 400); }
  }

  loadIndex();                                  // lazy: powers rank + full directory search
  setInterval(() => { if (!document.hidden) maybeAutoRefresh(); }, 60000);
}

if (typeof Chart === 'undefined'){
  document.addEventListener('DOMContentLoaded', () => {
    document.body.innerHTML = `<div style="padding:60px;font-family:monospace;color:#E3E9F2">
      Chart library failed to load from the CDN. This dashboard needs outbound access to jsdelivr.</div>`;
  });
} else {
  document.addEventListener('DOMContentLoaded', init);
}
