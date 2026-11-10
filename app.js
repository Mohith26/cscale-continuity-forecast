import * as C from './core/continuity.js';

const $ = (s) => document.querySelector(s);
const SEED = 20261110;
const NOW = Date.UTC(2026, 10, 10); // Tue Nov 10 2026
const state = { sim: null, cache: {}, an: null, budget: 8, racksMax: 4, horizon: 26, which: 'pOut', sel: null, selLaser: null };

const fmt = (v, d = 1) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const int = (v) => Math.round(v).toLocaleString('en-US');
const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;
const dateIn = (weeks) => new Date(NOW + weeks * 7 * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dateFull = (weeks) => new Date(NOW + weeks * 7 * 86400000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
const engName = (E) => `R${String(E.rack + 1).padStart(2, '0')}·A${String(E.acc + 1).padStart(2, '0')}·E${E.k + 1}`;
const installDate = (wk) => new Date(NOW - (C.CFG.nowWeek - wk) * 7 * 86400000).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

function analysis() {
  if (!state.cache[state.horizon]) state.cache[state.horizon] = C.analyze(state.sim, { horizonWeeks: state.horizon });
  return state.cache[state.horizon];
}
const live = () => state.sim.engines.filter(E => !E.outagesSoFar);
const sumOf = (k) => live().reduce((s, E) => s + E[k], 0);

// frontier: expected channel losses (simulator truth) when swapping the top-k engines by a ranking
function frontier(an, key, kmax) {
  const L = live(), order = [...L].sort(key), out = [L.reduce((s, E) => s + E.pOutTrue, 0)];
  for (let i = 0; i < Math.min(kmax, order.length); i++) out.push(out[i] + an.newEngineP - order[i].pOutTrue);
  return out;
}
const RANK = {
  pOut: (a, b) => b.pOut - a.pOut,
  pOutModel: (a, b) => b.pOutModel - a.pOutModel,
  drift: (a, b) => (a.sparesLeft - b.sparesLeft) || (b.worstDrift - a.worstDrift),
};
const firstBelow = (f, thr) => { for (let i = 0; i < f.length; i++) if (f[i] <= thr) return i; return null; };

function init() {
  state.sim = C.simulate(SEED);
  // horizon labels
  $('#horizon').innerHTML = [13, 26].map(w => `<option value="${w}"${w === state.horizon ? ' selected' : ''}>${w} weeks · ${dateIn(w)}</option>`).join('');
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('budget')) state.budget = +h.get('budget');
  if (h.get('racks')) state.racksMax = +h.get('racks');
  if (h.get('h')) state.horizon = +h.get('h');
  if (h.get('which')) state.which = h.get('which');
  $('#budget').value = state.budget; $('#racksMax').value = state.racksMax; $('#horizon').value = state.horizon; $('#which').value = state.which;
  $('#budget').oninput = (e) => { state.budget = +e.target.value; renderPlan(); renderRacks(); };
  $('#racksMax').oninput = (e) => { state.racksMax = +e.target.value; renderPlan(); renderRacks(); };
  $('#horizon').onchange = (e) => { state.horizon = +e.target.value; state.sel = null; renderAll(); };
  $('#which').onchange = (e) => { state.which = e.target.value; renderPlan(); renderRacks(); };
  $('#exportBtn').onclick = (e) => { e.preventDefault(); exportPlan(); };
  renderAll();
  if (h.get('engine')) { const E = state.sim.engines.find(x => engName(x).replace(/·/g, '-') === h.get('engine')); if (E) { state.sel = E.e; renderEngine(); } }
}

function renderAll() {
  state.an = analysis();
  if (state.sel == null) state.sel = [...live()].sort(RANK.pOut)[0].e;
  renderHero(); renderPlan(); renderRacks(); renderCalib(); renderEngine();
}

// ---------- hero ----------
function renderHero() {
  const an = state.an, c = state.sim.cfg, w = state.horizon;
  const fc = sumOf('pOut');
  const lasersFc = an.active.reduce((s, r) => s + r.pConf, 0);
  const spares = [0, 0, 0]; state.sim.engines.forEach(E => { if (!E.outagesSoFar) spares[E.sparesLeft]++; });
  const down = state.sim.engines.filter(E => E.outagesSoFar).length;
  $('#heroEyebrow').textContent = `Continuity forecast · Domain PA-01 · through ${dateFull(w)}`;
  $('#heroTitle').innerHTML = `<em>${fmt(fc)}</em> light engines are forecast to run out of spare lasers before ${dateFull(w)}.`;
  const picks = C.plan(an, state.budget, state.racksMax, 'pOut');
  const after = fc - picks.reduce((s, E) => s + E.pOut - an.newEngineP, 0);
  $('#heroLede').innerHTML = `Each engine drives ${c.N} of its ${c.M} lasers and stays whole until a third laser fails. Across ${int(c.racks * c.accPerRack * c.enginesPerAcc)} engines, ${int(lasersFc)} lasers are forecast to wear out by then. Swapping ${picks.length} engines in next week's window cuts the forecast to ${fmt(after)}.`;
  const rows = [
    ['Light engines', int(state.sim.engines.length)],
    ['Active lasers', int(an.active.length)],
    ['Spares left 2 · 1 · 0', `${int(spares[2])} · ${int(spares[1])} · ${int(spares[0])}`],
    ['Engines down a channel', int(down)],
    ['Lasers wearing out', `${int(lasersFc)}<small>by ${dateIn(w)}</small>`],
    ['Fitted drift exponent', fmt(an.m, 3)],
  ];
  $('#heroStats').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
}

// ---------- racks ----------
function riskColor(p) {
  if (p < 0.0005) return '#e9e8e2';
  const t = Math.min(1, Math.log10(p / 0.0005) / Math.log10(1 / 0.0005)); // log scale 0.05% .. 100%
  const stops = [[233, 232, 226], [255, 210, 194], [255, 138, 95], [255, 86, 35]];
  const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgb(${c.join(',')})`;
}
function renderRacks() {
  const an = state.an, c = state.sim.cfg, key = state.which;
  const picks = new Set(C.plan(an, state.budget, state.racksMax, key).map(E => E.e));
  const total = sumOf(key);
  const sorted = [...live()].sort((a, b) => b[key] - a[key]);
  let acc = 0, n80 = 0; for (const E of sorted) { if (acc >= 0.8 * total) break; acc += E[key]; n80++; }
  const bad = sorted.slice(0, n80).filter(E => E.lot === C.BAD_LOT).length;
  const badShare = live().filter(E => E.lot === C.BAD_LOT).reduce((s, E) => s + E[key], 0) / Math.max(total, 1e-9);
  $('#riskSub').innerHTML = `One square per light engine, 64 accelerators × 4 engines per rack. <b>${n80}</b> of ${int(live().length)} engines still whole carry 80% of the forecast risk; <b>${bad}</b> of them use lasers from lot <b>${C.BAD_LOT}</b>, which accounts for <b>${pct(badShare, 0)}</b> of the total.`;
  $('#riskLegend').innerHTML = `<span>P(run out of spares before ${dateIn(state.horizon)})</span><span>0.05%<i class="ramp"></i>100%</span><span><i class="sw" style="outline:1.5px solid #14131a;outline-offset:-1.5px;background:#e9e8e2"></i>No spare left</span><span><i class="sw" style="box-shadow:inset 0 0 0 2px #2e9e78;background:#e9e8e2"></i>In service plan</span><span><i class="sw" style="outline:2px solid #5566c4;background:#e9e8e2"></i>Selected</span>`;
  const html = [];
  for (let r = 0; r < c.racks; r++) {
    const es = state.sim.engines.filter(E => E.rack === r);
    const risk = es.filter(E => !E.outagesSoFar).reduce((s, E) => s + E[key], 0);
    const s0 = es.filter(E => !E.outagesSoFar && E.sparesLeft === 0).length;
    const cells = es.map(E => {
      const p = E.outagesSoFar ? 1 : E[key];
      const cls = [E.sparesLeft === 0 || E.outagesSoFar ? 's0' : '', picks.has(E.e) ? 'picked' : '', E.e === state.sel ? 'sel' : ''].join(' ');
      return `<i class="${cls}" data-e="${E.e}" style="background:${riskColor(p)}" title="${engName(E)} · ${E.lot} · spares ${E.sparesLeft} · P ${pct(p)}"></i>`;
    }).join('');
    html.push(`<div class="rack"><div class="rack-h"><b>Rack ${String(r + 1).padStart(2, '0')}</b><span>${installDate(state.sim.rackInstall[r])}</span></div><div class="cells">${cells}</div><div class="rack-f"><span>Exp. losses <b>${fmt(risk, 2)}</b></span><span>No spare <b>${s0}</b></span></div></div>`);
  }
  $('#racks').innerHTML = html.join('');
  document.querySelectorAll('.cells i').forEach(el => el.onclick = () => { state.sel = +el.dataset.e; state.selLaser = null; renderRacks(); renderEngine(); toast(`${engName(state.sim.engines[state.sel])} selected · details in 04 below`); });
}

// ---------- plan ----------
function renderPlan() {
  const an = state.an, key = state.which, w = state.horizon;
  $('#budgetV').textContent = state.budget; $('#racksV').textContent = state.racksMax;
  const picks = C.plan(an, state.budget, state.racksMax, key);
  const racks = new Set(picks.map(E => E.rack));
  const before = sumOf('pOut');
  const after = before - picks.reduce((s, E) => s + E.pOut - an.newEngineP, 0);
  const truthBefore = sumOf('pOutTrue'), truthAfter = C.evaluate(an, picks).expected;
  $('#planTitle').textContent = picks.length ? `Swap ${picks.length} engine${picks.length > 1 ? 's' : ''} in ${racks.size} rack${racks.size > 1 ? 's' : ''}.` : 'No swaps.';
  $('#planSub').innerHTML = `Exact plan over racks: at most <b>${state.budget}</b> swaps and <b>${state.racksMax}</b> racks opened, maximizing the forecast risk removed before ${dateFull(w)}. Forecast channel losses: <b>${fmt(before)}</b> → <b>${fmt(after)}</b>.`;
  const rows = [...picks].sort((a, b) => b[key] - a[key]);
  const maxP = Math.max(1e-9, ...rows.map(E => E[key]));
  const body = rows.slice(0, 10).map(E => `<tr class="click" data-e="${E.e}"><td class="mono">${engName(E)}</td><td>${E.lot === C.BAD_LOT ? `<span class="pill o">${E.lot}</span>` : `<span class="pill k">${E.lot}</span>`}</td><td class="r">${E.sparesLeft}</td><td class="r">${pct(E.worstDrift)}</td><td class="r">${pct(E[key])}</td><td><span class="bar" style="width:${(E[key] / maxP * 70).toFixed(0)}px"></span></td></tr>`).join('');
  $('#planTableCell').innerHTML = `<h3>Engines to swap</h3><p class="role">Ranked by ${key === 'pOut' ? 'calibrated' : 'model-only'} probability of running out</p>
    <table class="t"><thead><tr><th>Engine</th><th>Laser lot</th><th class="r">Spares</th><th class="r">Worst drift</th><th class="r">P(run out)</th><th></th></tr></thead><tbody>${body || `<tr><td colspan="6">Set a swap budget above zero.</td></tr>`}</tbody></table>
    ${rows.length > 10 ? `<p class="more">and ${rows.length - 10} more in the exported plan</p>` : ''}`;
  document.querySelectorAll('#planTableCell tr.click').forEach(tr => tr.onclick = () => { state.sel = +tr.dataset.e; state.selLaser = null; renderRacks(); renderEngine(); document.getElementById('engine').scrollIntoView({ behavior: 'smooth' }); });
  // frontier chart
  const K = 64;
  const fc = frontier(an, RANK.pOut, 1200), fm = frontier(an, RANK.pOutModel, 1200), fd = frontier(an, RANK.drift, 1200);
  const need = { c: firstBelow(fc, 0.5), m: firstBelow(fm, 0.5), d: firstBelow(fd, 0.5) };
  $('#frontierCell').innerHTML = `<h3>Swaps versus channel losses</h3><p class="role">Scored on the simulator's truth · ${w}-week horizon</p>${frontierSVG(fc, fm, fd, K)}`;
  const kp = [
    ['Forecast losses', `${fmt(before)} → ${fmt(after)}`, `calibrated forecast before ${dateIn(w)}`],
    ['Simulator truth', `${fmt(truthBefore)} → ${fmt(truthAfter)}`, `expected engines losing a channel, this plan`],
    ['Swaps to reach 0.5', `${need.c ?? '—'}<small>vs ${need.d ?? '>1,200'}</small>`, `calibrated ranking vs ranking by drift and spares (how threshold alarms prioritize); model-only needs ${need.m ?? '>1,200'}`],
    ['Racks opened', `${racks.size}<small>× 64 accelerators</small>`, `drained for the window; ${picks.length} light engines replaced`],
  ];
  $('#planKpis').innerHTML = kp.map(([k, v, d]) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="d">${d}</div></div>`).join('');
  state.planPicks = picks;
  renderHero();
}

function frontierSVG(fc, fm, fd, K) {
  const W = 520, H = 250, L = 44, R = 14, T = 16, B = 34, iw = W - L - R, ih = H - T - B;
  const ymax = Math.ceil(Math.max(fc[0], 1) + 0.5);
  const x = (k) => L + k / K * iw, y = (v) => T + ih - Math.max(0, v) / ymax * ih;
  const path = (f) => f.slice(0, K + 1).map((v, k) => `${k ? 'L' : 'M'}${x(k).toFixed(1)},${y(v).toFixed(1)}`).join('');
  let g = '';
  for (let t = 0; t <= ymax; t += Math.max(1, Math.round(ymax / 4))) g += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="#dddce2"/><text x="${L - 8}" y="${y(t) + 4}" font-size="11" fill="#6b6a73" text-anchor="end">${t}</text>`;
  for (let k = 0; k <= K; k += 16) g += `<text x="${x(k)}" y="${H - B + 17}" font-size="11" fill="#6b6a73" text-anchor="middle">${k}</text>`;
  g += `<line x1="${L}" x2="${W - R}" y1="${y(0.5)}" y2="${y(0.5)}" stroke="#14131a" stroke-dasharray="3 4" opacity=".5"/><text x="${W - R}" y="${y(0.5) - 5}" font-size="10.5" fill="#45444d" text-anchor="end">0.5 expected losses</text>`;
  g += `<path d="${path(fd)}" fill="none" stroke="#8e8d96" stroke-width="2" stroke-dasharray="5 4"/>`;
  g += `<path d="${path(fm)}" fill="none" stroke="#5566c4" stroke-width="2.2"/>`;
  g += `<path d="${path(fc)}" fill="none" stroke="#ff5623" stroke-width="2.6"/>`;
  const bx = x(Math.min(state.budget, K));
  g += `<line x1="${bx}" x2="${bx}" y1="${T}" y2="${T + ih}" stroke="#14131a" stroke-width="1"/><text x="${bx + 5}" y="${T + 10}" font-size="10.5" fill="#14131a">${state.budget} swaps</text>`;
  g += `<text x="${L}" y="${H - 4}" font-size="11" fill="#6b6a73">Engines swapped (top-ranked first)</text>`;
  const leg = `<div class="legend-row" style="margin:6px 0 0"><span><i class="sw" style="background:#ff5623;height:3px;vertical-align:3px"></i>Calibrated ranking</span><span><i class="sw" style="background:#5566c4;height:3px;vertical-align:3px"></i>Model-only ranking</span><span><i class="sw" style="background:#8e8d96;height:3px;vertical-align:3px"></i>Drift and spares ranking</span></div>`;
  return `<svg width="100%" viewBox="0 0 ${W} ${H}">${g}</svg>${leg}`;
}

// ---------- calibration ----------
function renderCalib() {
  const an = state.an, cal = C.calibration(an), w = state.horizon;
  const engs = { c: sumOf('pOut'), m: sumOf('pOutModel'), t: sumOf('pOutTrue') };
  $('#calibSub').innerHTML = `Every forecast is checked the same way it will be used: refit each laser on data up to ${w} weeks ago, forecast today's drift, and compare with what was measured. Those <b>${int(an.nCalib)}</b> backtests, split by drift level, become the forecast's error distribution (split conformal prediction).`;
  // reliability diagram
  const W = 520, H = 300, L = 46, R = 14, T = 16, B = 40, iw = W - L - R, ih = H - T - B;
  const x = (v) => L + v * iw, y = (v) => T + ih - v * ih;
  let g = '';
  [0, 0.25, 0.5, 0.75, 1].forEach(t => { g += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="#dddce2"/><text x="${L - 8}" y="${y(t) + 4}" font-size="11" fill="#6b6a73" text-anchor="end">${t * 100}%</text><text x="${x(t)}" y="${H - B + 17}" font-size="11" fill="#6b6a73" text-anchor="middle">${t * 100}%</text>`; });
  g += `<line x1="${x(0)}" y1="${y(0)}" x2="${x(1)}" y2="${y(1)}" stroke="#14131a" stroke-dasharray="3 4" opacity=".5"/>`;
  const pts = (pk, ok, nk, color, shape) => cal.rows.filter(r => r[nk] >= 5).map(r => {
    const px = r[pk] / r[nk], py = r[ok] / r[nk];
    const sz = 4 + Math.min(8, Math.log10(r[nk]) * 2);
    return shape === 'sq' ? `<rect x="${x(px) - sz / 2}" y="${y(py) - sz / 2}" width="${sz}" height="${sz}" fill="${color}"><title>${r[nk]} lasers: predicted ${pct(px)}, observed ${pct(py)}</title></rect>` : `<circle cx="${x(px)}" cy="${y(py)}" r="${sz / 2}" fill="none" stroke="${color}" stroke-width="2"><title>${r[nk]} lasers: predicted ${pct(px)}, observed ${pct(py)}</title></circle>`;
  }).join('');
  g += pts('predM', 'obsM', 'nM', '#5566c4', 'c') + pts('predC', 'obs', 'n', '#ff5623', 'sq');
  g += `<text x="${L}" y="${H - 4}" font-size="11" fill="#6b6a73">Predicted probability a laser wears out before ${dateIn(w)}</text><text x="${L + 4}" y="${T + 12}" font-size="11" fill="#6b6a73">Observed share (simulator truth)</text>`;
  const leg = `<div class="legend-row" style="margin:6px 0 0"><span><i class="sw" style="background:#ff5623"></i>Calibrated (conformal)</span><span><i class="sw" style="border:2px solid #5566c4;border-radius:50%"></i>Model only (Gaussian error bars)</span><span>Marker size grows with lasers per bin</span></div>`;
  const rows = [
    ['Lasers wearing out by ' + dateIn(w), int(cal.totals.conformal), int(cal.totals.model), int(cal.totals.truth)],
    ['Engines losing a channel', fmt(engs.c), fmt(engs.m), fmt(engs.t)],
    [`${Math.round(cal.coverage.target * 100)}% upper bound covers true drift`, pct(cal.coverage.conformal), pct(cal.coverage.model), `target ${Math.round(cal.coverage.target * 100)}%`],
  ];
  $('#calGrid').innerHTML = `<div class="cell"><h3>Reliability</h3><p class="role">${int(an.active.length)} active lasers · ${w}-week horizon</p><svg width="100%" viewBox="0 0 ${W} ${H}">${g}</svg>${leg}</div>
    <div class="cell"><h3>Forecast versus truth</h3><p class="role">This domain, ${dateFull(w)}</p>
      <div class="stat-list"><div class="h"><span></span><span class="r">Calibrated</span><span class="r">Model only</span><span class="r">Truth</span></div>
      ${rows.map(r => `<div><span>${r[0]}</span><span class="r"><b>${r[1]}</b></span><span class="r">${r[2]}</span><span class="r">${r[3]}</span></div>`).join('')}</div>
      <p class="note">The model alone fits a pooled power law (drift = A·(AF·t)<sup>m</sup>, Arrhenius-scaled by engine temperature) and trusts its own residuals, so it misses lasers whose exponent differs from the fleet's. Conformal calibration measures that error directly on last quarter's forecasts, within the same drift band, and widens the forecast where it was wrong. Sudden failures are added as a ${Math.round(C.CFG.fit * 1e9)} FIT hazard. Lasers with too little history borrow the fleet's distribution for their lot.</p></div>`;
}

// ---------- engine ----------
function renderEngine() {
  const an = state.an, c = state.sim.cfg, w = state.horizon;
  const E = state.sim.engines[state.sel];
  const lasers = [...E.active].sort((a, b) => a.s - b.s);
  const hot = [...lasers].sort((a, b) => b.pConf - a.pConf)[0];
  if (state.selLaser == null || !lasers.find(r => r.s === state.selLaser)) state.selLaser = hot ? hot.s : 0;
  const sel = lasers.find(r => r.s === state.selLaser);
  $('#engTitle').textContent = `Engine ${engName(E)}.`;
  $('#engSub').innerHTML = `Lot <b>${E.lot}</b> · ${fmt(E.temp, 0)} °C · <b>${E.sparesLeft}</b> of ${c.M - c.N} spares left · ${E.failedSoFar} laser${E.failedSoFar === 1 ? '' : 's'} replaced so far. P(run out before ${dateIn(w)}): <b>${pct(E.pOut)}</b> calibrated, ${pct(E.pOutModel)} model only.`;
  const slots = lasers.map(r => `<div class="slot ${r.pConf > 0.3 ? 'hot' : ''} ${r.s === state.selLaser ? 'on' : ''}" data-s="${r.s}"><b>CH${String(r.s + 1).padStart(2, '0')}</b><span>${pct(r.dNow, 0)}</span></div>`).join('')
    + Array.from({ length: c.M - c.N }, (_, i) => i < E.sparesLeft ? `<div class="slot spare"><b>SPARE</b><span>off</span></div>` : `<div class="slot dead"><b>SPARE</b><span>used</span></div>`).join('');
  const top = [...lasers].sort((a, b) => b.pConf - a.pConf).slice(0, 6);
  const tbl = top.map(r => `<tr class="click" data-s="${r.s}"><td class="mono">CH${String(r.s + 1).padStart(2, '0')}</td><td class="r">${fmt(r.age / C.H_WEEK, 0)}</td><td class="r">${pct(r.dNow)}</td><td class="r">${r.mu != null ? pct(Math.exp(r.mu)) : '—'}</td><td class="r">${r.upper != null ? pct(r.upper) : '—'}</td><td class="r"><b>${pct(r.pConf)}</b></td><td class="r">${pct(r.pModel)}</td></tr>`).join('');
  $('#engGrid').innerHTML = `<div class="cell"><h3>Lasers</h3><p class="role">${c.N} active of ${c.M} · current drive-current drift</p><div class="slots">${slots}</div>
      <table class="t"><thead><tr><th>Channel</th><th class="r">Age wk</th><th class="r">Drift now</th><th class="r">${dateIn(w)} median</th><th class="r">90% upper</th><th class="r">P wear-out</th><th class="r">Model</th></tr></thead><tbody>${tbl}</tbody></table></div>
    <div class="cell"><h3>CH${String(sel.s + 1).padStart(2, '0')} drift and forecast</h3><p class="role">Calibrated band to ${dateIn(w)} · end of life at +${c.eolDrift * 100}%</p>${driftSVG(E, sel)}</div>`;
  document.querySelectorAll('#engGrid [data-s]').forEach(el => el.onclick = () => { state.selLaser = +el.dataset.s; renderEngine(); });
}

function quantile(arr, p) { return arr[Math.min(arr.length - 1, Math.max(0, Math.round(p * (arr.length - 1))))]; }
function driftSVG(E, r) {
  const an = state.an, c = state.sim.cfg, H = an.H;
  const W = 520, Hh = 300, L = 46, R = 14, T = 16, B = 40, iw = W - L - R, ih = Hh - T - B;
  const ageMax = (r.age + H) / C.H_WEEK;
  const ymax = Math.max(0.25, ...(r.upper ? [r.upper * 1.05] : []), ...r.obs.map(p => p[1] * 1.1));
  const x = (wk) => L + wk / ageMax * iw, y = (d) => T + ih - Math.min(1, d / ymax) * ih;
  let g = '';
  for (let t = 0; t <= ymax + 1e-9; t += 0.05) g += `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" stroke="#dddce2"/><text x="${L - 8}" y="${y(t) + 4}" font-size="11" fill="#6b6a73" text-anchor="end">${Math.round(t * 100)}%</text>`;
  const step = ageMax > 40 ? 10 : 5;
  for (let wk = 0; wk <= ageMax; wk += step) g += `<text x="${x(wk)}" y="${Hh - B + 17}" font-size="11" fill="#6b6a73" text-anchor="middle">${wk}</text>`;
  // other lasers of this engine (faint)
  for (const o of E.active) if (o !== r && o.obs.length) g += `<path d="${o.obs.map((p, i) => `${i ? 'L' : 'M'}${x(p[0] / C.H_WEEK).toFixed(1)},${y(p[1]).toFixed(1)}`).join('')}" fill="none" stroke="#c9c8cf" stroke-width="1"/>`;
  // forecast band from conformal scores of this laser's drift group
  if (r.fit && r.mu != null) {
    const grp = an.groups[r.group];
    const qs = { lo: quantile(grp, 0.05), md: quantile(grp, 0.5), hi: quantile(grp, 1 - an.alpha) };
    const steps = 20, up = [], lo = [], md = [];
    for (let i = 0; i <= steps; i++) {
      const a = r.age + H * i / steps, sc = i === 0 ? 0 : C.ageScale(r.age, H * i / steps), mu = C.predLog(r.fit, r.AF, an.m, a);
      up.push([a, Math.exp(mu + sc * qs.hi)]); lo.push([a, Math.exp(mu + sc * qs.lo)]); md.push([a, Math.exp(mu + sc * qs.md)]);
    }
    const P = (arr) => arr.map(([a, d]) => `${x(a / C.H_WEEK).toFixed(1)},${y(d).toFixed(1)}`);
    g += `<polygon points="${[...P(up), ...P(lo).reverse()].join(' ')}" fill="#ff5623" opacity=".16"/>`;
    g += `<polyline points="${P(md).join(' ')}" fill="none" stroke="#ff5623" stroke-width="2" stroke-dasharray="5 4"/>`;
    g += `<polyline points="${P(up).join(' ')}" fill="none" stroke="#ff5623" stroke-width="1" opacity=".7"/>`;
  }
  g += `<path d="${r.obs.map((p, i) => `${i ? 'L' : 'M'}${x(p[0] / C.H_WEEK).toFixed(1)},${y(p[1]).toFixed(1)}`).join('')}" fill="none" stroke="#14131a" stroke-width="2"/>`;
  r.obs.forEach(p => { g += `<circle cx="${x(p[0] / C.H_WEEK).toFixed(1)}" cy="${y(p[1]).toFixed(1)}" r="2" fill="#14131a"/>`; });
  g += `<line x1="${L}" x2="${W - R}" y1="${y(c.eolDrift)}" y2="${y(c.eolDrift)}" stroke="#ff5623" stroke-width="1.5"/><text x="${W - R}" y="${y(c.eolDrift) - 5}" font-size="10.5" fill="#c23d14" text-anchor="end">End of life +${c.eolDrift * 100}%</text>`;
  g += `<line x1="${L}" x2="${W - R}" y1="${y(c.alarmDrift)}" y2="${y(c.alarmDrift)}" stroke="#8e8d96" stroke-dasharray="3 4"/><text x="${L + 6}" y="${y(c.alarmDrift) - 5}" font-size="10.5" fill="#6b6a73">Alarm +${c.alarmDrift * 100}%</text>`;
  const nx = x(r.age / C.H_WEEK);
  g += `<line x1="${nx}" x2="${nx}" y1="${T}" y2="${T + ih}" stroke="#14131a" stroke-dasharray="2 3" opacity=".6"/><text x="${nx - 5}" y="${T + 10}" font-size="10.5" fill="#14131a" text-anchor="end">Today</text>`;
  g += `<text x="${L}" y="${Hh - 4}" font-size="11" fill="#6b6a73">Laser age (weeks) · P(wear-out by ${dateIn(state.horizon)}) = ${pct(r.pConf)} calibrated, ${pct(r.pModel)} model only</text>`;
  return `<svg width="100%" viewBox="0 0 ${W} ${Hh}">${g}</svg>`;
}

function exportPlan() {
  const key = state.which, picks = state.planPicks || [];
  const lines = ['engine,rack,accelerator,engine_index,laser_lot,spares_left,worst_drift,p_run_out_calibrated,p_run_out_model'];
  picks.forEach(E => lines.push([engName(E), E.rack + 1, E.acc + 1, E.k + 1, E.lot, E.sparesLeft, E.worstDrift.toFixed(4), E.pOut.toFixed(4), E.pOutModel.toFixed(4)].join(',')));
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
  a.download = `service-plan-${state.budget}-swaps.csv`; a.click();
  toast(`Exported ${picks.length} engine swaps (${key === 'pOut' ? 'calibrated' : 'model-only'} plan)`);
}
let tt;
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 2400); }

try { init(); } catch (e) { console.error(e); document.body.insertAdjacentHTML('beforeend', `<pre style="color:#c00">${e.stack}</pre>`); }
