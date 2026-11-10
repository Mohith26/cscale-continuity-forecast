// Continuity forecast for N-of-M light engines.
//
// Each light engine carries M lasers and drives N of them (N-of-M selection, as in
// CScale's public patents: e.g. 16 of 18, spares powered off until a laser fails).
// An engine stays whole until it has lost more than M - N lasers. This module:
//   1. simulates a scale-up domain's laser fleet with per-laser aging telemetry,
//   2. forecasts each active laser's drive-current drift with a pooled power-law model,
//   3. calibrates the forecast with normalized split conformal prediction (backtest at
//      now - H against what was observed now), giving per-laser probabilities of wearing
//      out within the horizon H,
//   4. turns those into per-engine probabilities of running out of spares
//      (Poisson-binomial over the N active lasers), and
//   5. plans a service window exactly with a dynamic program over racks
//      (engine swap budget + limit on racks opened).
// Pure functions; works in the browser (ES module) and in Node.

export const CFG = {
  racks: 16, accPerRack: 64, enginesPerAcc: 4,
  N: 16, M: 18,
  nowWeek: 44,            // weeks since the first rack was installed
  eolDrift: 0.20,         // end of life: drive current +20% at constant output power
  alarmDrift: 0.15,       // a conventional threshold alarm
  noise: 0.003,           // drift measurement noise (absolute)
  fit: 30e-9,             // sudden-failure hazard per laser-hour (30 FIT)
  A0: 5.77e-4,            // median aging prefactor: D = A (AF * hours)^m (EOL ~120k h at Tref)
  sdLogA: 0.35, mMean: 0.5, mSd: 0.05,
  weakMult: 5.5, weakFracNormal: 0.003, weakFracBadLot: 0.03,
  Ea: 0.45, Tref: 70,     // Arrhenius activation energy (eV) and reference temp (C)
};
const KB = 8.617e-5;
export const H_WEEK = 168;

export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let spare = null;
  next.normal = () => {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0; while (u === 0) u = next();
    const v = next(), r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
  return next;
}

export function accel(tempC, c = CFG) {
  return Math.exp(c.Ea / KB * (1 / (c.Tref + 273.15) - 1 / (tempC + 273.15)));
}

export const LOTS = ['L24-W08', 'L24-W11', 'L24-W14', 'L24-W19', 'L24-W22', 'L24-W26', 'L24-W29', 'L24-W31', 'L24-W35', 'L24-W38', 'L24-W41', 'L24-W44'];
export const BAD_LOT = 'L24-W31';

// ---------- fleet simulation ----------
// Returns engines with their laser history and the simulator's truth for the future.
export function simulate(seed = 20261110, cfg = CFG, horizonMaxWeeks = 26) {
  const R = rng(seed), c = cfg;
  const nowH = c.nowWeek * H_WEEK, endH = nowH + horizonMaxWeeks * H_WEEK;
  // racks installed in waves; the newest wave uses lasers from the bad lot for part of its engines
  const rackInstall = Array.from({ length: c.racks }, (_, r) => r < 6 ? 0 + r : r < 12 ? 14 + (r - 6) * 2 : 30 + (r - 12) * 2);
  const engines = [];
  for (let r = 0; r < c.racks; r++) {
    const inlet = 27 + 3 * R.normal() * 0.6;
    for (let a = 0; a < c.accPerRack; a++) {
      for (let k = 0; k < c.enginesPerAcc; k++) {
        const e = engines.length;
        const install = rackInstall[r];
        const okLots = LOTS.filter(l => l !== BAD_LOT);
        const lot = r >= 12 && a % 2 === 0 ? BAD_LOT : okLots[Math.floor(R() * okLots.length)];
        const temp = inlet + 34 + (a % 8) * 1.1 + k * 0.6 + R.normal() * 1.2; // ~61-75 C
        const AF = accel(temp, c);
        const weakFrac = lot === BAD_LOT ? c.weakFracBadLot : c.weakFracNormal;
        const newLaser = (startH) => {
          const weak = R() < weakFrac;
          const logA = Math.log(c.A0) + c.sdLogA * R.normal() + (weak ? Math.log(c.weakMult) : 0);
          const m = c.mMean + c.mSd * R.normal();
          const wearH = Math.pow(c.eolDrift / Math.exp(logA), 1 / m) / AF; // hours of operation to EOL
          const suddenH = -Math.log(1 - R()) / c.fit;
          return { logA, m, weak, start: startH, wearEnd: startH + wearH, suddenEnd: startH + suddenH };
        };
        const slots = [];
        let sparesLeft = c.M - c.N;
        const events = []; // failures (time, kind, slot)
        const outages = []; // uncontained: failure with no spare left
        for (let s = 0; s < c.N; s++) slots.push([newLaser(install * H_WEEK)]);
        // process failures in time order up to endH
        for (;;) {
          let best = null;
          for (let s = 0; s < c.N; s++) {
            const L = slots[s][slots[s].length - 1];
            if (L.dead) continue;
            const t = Math.min(L.wearEnd, L.suddenEnd);
            if (t < endH && (!best || t < best.t)) best = { t, s, kind: L.wearEnd <= L.suddenEnd ? 'wear' : 'sudden' };
          }
          if (!best) break;
          const L = slots[best.s][slots[best.s].length - 1];
          L.end = best.t; L.kind = best.kind;
          events.push({ t: best.t, slot: best.s, kind: best.kind });
          if (sparesLeft > 0) { sparesLeft--; slots[best.s].push(newLaser(best.t)); }
          else { L.dead = true; outages.push({ t: best.t, slot: best.s, kind: best.kind }); }
        }
        engines.push({ e, rack: r, acc: a, k, lot, temp, AF, install, slots, events, outages });
      }
    }
  }
  return { seed, cfg: c, nowH, horizonMaxWeeks, rackInstall, engines, R };
}

// Observed drift telemetry for a laser: weekly samples from its start to min(end, until).
export function observe(L, AF, untilH, seed, cfg = CFG) {
  const R = rng(seed);
  const out = [];
  const stop = Math.min(L.end ?? Infinity, untilH);
  for (let t = Math.ceil(L.start / H_WEEK + 1e-9) * H_WEEK; t <= stop; t += H_WEEK) {
    const age = t - L.start;
    if (age <= 0) continue;
    const d = Math.exp(L.logA) * Math.pow(AF * age, L.m);
    out.push([age, Math.max(1e-4, d + cfg.noise * R.normal())]);
  }
  return out;
}

export const trueDrift = (L, AF, ageH) => Math.exp(L.logA) * Math.pow(AF * Math.max(ageH, 0), L.m);

// ---------- forecasting ----------
// Pooled exponent m from robust per-laser slopes; per-laser intercept b with the slope fixed.
export function pooledSlope(series) {
  const slopes = [];
  for (const { obs, AF } of series) {
    const pts = obs.filter(p => p[1] > 0.03);
    if (pts.length < 8) continue;
    const xs = pts.map(p => Math.log(AF * p[0])), ys = pts.map(p => Math.log(p[1]));
    const mx = xs.reduce((s, v) => s + v, 0) / xs.length, my = ys.reduce((s, v) => s + v, 0) / ys.length;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
    if (sxx > 0.05) slopes.push(sxy / sxx);
  }
  slopes.sort((a, b) => a - b);
  return slopes.length ? slopes[Math.floor(slopes.length / 2)] : CFG.mMean;
}

export function fitLaser(obs, AF, m) {
  const pts = obs.filter(p => p[1] > 0.006).slice(-12); // recent points carry the signal
  if (pts.length < 4) return null;
  const r = pts.map(p => Math.log(p[1]) - m * Math.log(AF * p[0]));
  const b = r.reduce((s, v) => s + v, 0) / r.length;
  const sd = Math.sqrt(r.reduce((s, v) => s + (v - b) ** 2, 0) / Math.max(1, r.length - 1));
  return { b, sd: Math.max(sd, 0.01), n: pts.length };
}
export const predLog = (fit, AF, m, ageH) => fit.b + m * Math.log(AF * ageH);
export const ageScale = (ageH, hH) => Math.log((ageH + hH) / ageH);
// Mondrian groups by drift level at the forecast origin (conditional calibration)
export const GROUP_EDGES = [0.03, 0.08];
export const groupOf = (d) => d < GROUP_EDGES[0] ? 0 : d < GROUP_EDGES[1] ? 1 : 2;

// Standard normal CDF
export function Phi(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

// P(K > s) for K ~ Poisson-binomial(ps)
export function pExceed(ps, s) {
  if (s < 0) return 1;
  let dist = new Float64Array(s + 2); dist[0] = 1; // dist[s+1] accumulates ">= s+1"
  for (const p of ps) {
    for (let j = s + 1; j >= 0; j--) {
      const stay = dist[j] * (1 - p);
      const from = j > 0 ? dist[j - 1] * p : 0;
      dist[j] = j === s + 1 ? dist[j] + from : stay + from;
    }
  }
  return dist[s + 1];
}

// ---------- end-to-end analysis ----------
export function analyze(sim, opts = {}) {
  const c = sim.cfg, H = (opts.horizonWeeks ?? 13) * H_WEEK, nowH = sim.nowH;
  const alpha = opts.alpha ?? 0.1; // for the reported upper bound
  const logEol = Math.log(c.eolDrift);
  const lamH = 1 - Math.exp(-c.fit * H);
  // 1) telemetry for active lasers (now) and for the backtest at now - H
  const active = [], calib = [];
  let seedCtr = 1;
  for (const E of sim.engines) {
    E.active = [];
    E.failedSoFar = E.events.filter(v => v.t <= nowH).length;
    E.outagesSoFar = E.outages.filter(v => v.t <= nowH).length;
    E.sparesLeft = Math.max(0, (c.M - c.N) - E.failedSoFar);
    for (let s = 0; s < c.N; s++) {
      for (const L of E.slots[s]) {
        const ls = seedCtr++;
        if (L.start > nowH) continue;
        const isActive = L.start <= nowH && (L.end === undefined || L.end > nowH);
        // backtest candidates: started at least 6 weeks before now - H, alive at now - H
        const aliveBack = L.start <= nowH - H - 6 * H_WEEK && (L.end === undefined || L.end > nowH - H);
        if (!isActive && !aliveBack) continue;
        const obs = observe(L, E.AF, nowH, sim.seed * 7919 + ls, c);
        if (isActive) { const rec = { E, s, L, obs, AF: E.AF, age: nowH - L.start }; active.push(rec); E.active.push(rec); }
        if (aliveBack) calib.push({ E, L, obs, AF: E.AF });
      }
    }
  }
  const m = pooledSlope(active.map(r => ({ obs: r.obs, AF: r.AF })));
  // 2) conformal scores: forecast log drift at now from data up to now - H, compare with observation at now
  const groups = [[], [], []];
  for (const q of calib) {
    const past = q.obs.filter(p => q.L.start + p[0] <= nowH - H);
    const f = fitLaser(past, q.AF, m);
    if (!f) continue;
    const a0 = nowH - H - q.L.start, a1 = nowH - q.L.start;
    let yNow;
    const lastObs = q.obs.filter(p => q.L.start + p[0] > nowH - 2 * H_WEEK && q.L.start + p[0] <= nowH);
    if (lastObs.length) yNow = Math.log(lastObs.reduce((s, p) => s + p[1], 0) / lastObs.length);
    else { // wore out or failed before now: extrapolate its own full-history fit to now
      if (q.L.kind === 'sudden') continue; // sudden failures are handled by the hazard term
      const g = fitLaser(q.obs, q.AF, m); if (!g) continue; yNow = predLog(g, q.AF, m, a1);
    }
    groups[groupOf(past[past.length - 1][1])].push((yNow - predLog(f, q.AF, m, a1)) / ageScale(a0, H));
  }
  groups.forEach(g => g.sort((a, b) => a - b));
  const scores = groups.flat().sort((a, b) => a - b);
  const nS = scores.length;
  const qOf = (arr) => arr[Math.min(arr.length - 1, Math.ceil((arr.length + 1) * (1 - alpha)) - 1)];
  const qUpG = groups.map(qOf);
  const qUp = qOf(scores);
  // empirical prior for lasers with too little history: fitted intercepts by lot class
  const priorB = { bad: [], ok: [] };
  // 3) per-laser probabilities
  for (const r of active) {
    r.fit = fitLaser(r.obs, r.AF, m);
    r.dNow = r.obs.length ? r.obs[r.obs.length - 1][1] : 0;
    if (r.fit) (r.E.lot === BAD_LOT ? priorB.bad : priorB.ok).push(r.fit.b);
  }
  // conformal predictive probability within the laser's drift group: share of calibration
  // scores that would put the laser past EOL at the end of the horizon
  const conformalP = (mu, scale, g) => {
    const arr = groups[g], n = arr.length, thr = (logEol - mu) / scale; let lo = 0, hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < thr) lo = mid + 1; else hi = mid; }
    return (n - lo) / n;
  };
  for (const r of active) {
    const ageEnd = r.age + H;
    if (r.fit) {
      const mu = predLog(r.fit, r.AF, m, ageEnd), sc = ageScale(r.age, H);
      r.mu = mu; r.scale = sc;
      r.group = groupOf(r.dNow);
      r.upper = Math.exp(mu + sc * qUpG[r.group]);
      r.pWearConf = conformalP(mu, sc, r.group);
      const se = r.fit.sd * Math.sqrt(1 + 1 / r.fit.n);
      r.pWearModel = 1 - Phi((logEol - mu) / se);
      r.upperModel = Math.exp(mu + 1.2816 * se);
    } else {
      const pool = r.E.lot === BAD_LOT ? priorB.bad : priorB.ok;
      const need = logEol - m * Math.log(r.AF * ageEnd);
      const frac = pool.length ? pool.filter(b => b >= need).length / pool.length : 0;
      r.pWearConf = r.pWearModel = frac; r.mu = null; r.upper = r.upperModel = null;
    }
    r.pConf = 1 - (1 - r.pWearConf) * (1 - lamH);
    r.pModel = 1 - (1 - r.pWearModel) * (1 - lamH);
    // simulator truth: does this laser fail inside (now, now + H]? (sudden failure as its probability)
    const wearIn = r.L.wearEnd <= nowH + H;
    r.pTrue = wearIn ? 1 : lamH;
    r.dTrueEnd = trueDrift(r.L, r.AF, ageEnd);
  }
  // 4) engines
  const newEngineP = pExceed(new Array(c.N).fill(lamH), c.M - c.N); // fresh engine, sudden failures only
  for (const E of sim.engines) {
    const s = E.sparesLeft;
    const ps = E.active.map(r => r.pConf), pm = E.active.map(r => r.pModel), pt = E.active.map(r => r.pTrue);
    E.pOut = E.outagesSoFar ? 1 : pExceed(ps, s);
    E.pOutModel = E.outagesSoFar ? 1 : pExceed(pm, s);
    E.pOutTrue = E.outagesSoFar ? 1 : pExceed(pt, s);
    E.worstDrift = E.active.reduce((mx, r) => Math.max(mx, r.dNow), 0);
    E.worst = E.active.reduce((w, r) => (!w || r.pConf > w.pConf ? r : w), null);
  }
  return { sim, m, scores, groups, qUp, qUpG, alpha, H, horizonWeeks: H / H_WEEK, lamH, newEngineP, active, nCalib: nS };
}

// ---------- service planning: exact DP over racks ----------
// maximize sum of (risk removed) subject to <= budget swaps and <= maxRacks racks opened.
export function plan(an, budget, maxRacks, which = 'pOut') {
  const c = an.sim.cfg, base = an.newEngineP;
  const byRack = Array.from({ length: c.racks }, () => []);
  for (const E of an.sim.engines) if (!E.outagesSoFar) byRack[E.rack].push(E);
  const gains = byRack.map(list => list.map(E => ({ E, g: Math.max(0, E[which] - base) })).sort((a, b) => b.g - a.g));
  const pref = gains.map(gl => { const p = [0]; for (let i = 0; i < Math.min(budget, gl.length); i++) p.push(p[i] + gl[i].g); return p; });
  const NEG = -1e18;
  // dp[v][b] after processing racks; keep choice tables for reconstruction
  let dp = Array.from({ length: maxRacks + 1 }, () => new Float64Array(budget + 1).fill(NEG));
  dp[0][0] = 0;
  const choice = [];
  for (let r = 0; r < c.racks; r++) {
    const nd = Array.from({ length: maxRacks + 1 }, () => new Float64Array(budget + 1).fill(NEG));
    const ch = Array.from({ length: maxRacks + 1 }, () => new Int16Array(budget + 1));
    for (let v = 0; v <= maxRacks; v++) for (let b = 0; b <= budget; b++) {
      if (dp[v][b] === NEG) continue;
      if (dp[v][b] > nd[v][b]) { nd[v][b] = dp[v][b]; ch[v][b] = 0; }
      if (v < maxRacks) for (let k = 1; k < pref[r].length && b + k <= budget; k++) {
        const val = dp[v][b] + pref[r][k];
        if (val > nd[v + 1][b + k] + 1e-15) { nd[v + 1][b + k] = val; ch[v + 1][b + k] = k; }
      }
    }
    dp = nd; choice.push(ch);
  }
  let bv = 0, bb = 0, best = NEG;
  for (let v = 0; v <= maxRacks; v++) for (let b = 0; b <= budget; b++) if (dp[v][b] > best + 1e-15) { best = dp[v][b]; bv = v; bb = b; }
  const picks = [];
  for (let r = c.racks - 1; r >= 0; r--) {
    const k = choice[r][bv][bb];
    if (k > 0) { for (let i = 0; i < k; i++) picks.push(gains[r][i].E); bv--; bb -= k; }
  }
  return picks;
}

// Threshold policy an operator might run today: swap engines with no spare left or a laser past the alarm.
export function thresholdPlan(an) {
  const c = an.sim.cfg;
  return an.sim.engines.filter(E => !E.outagesSoFar && (E.sparesLeft === 0 || E.worstDrift >= c.alarmDrift));
}

// Expected engines that lose a channel inside the horizon under the simulator's truth.
export function evaluate(an, picks) {
  const set = new Set(picks.map(E => E.e));
  let ex = 0, pNone = 1;
  for (const E of an.sim.engines) {
    if (E.outagesSoFar) continue;
    const p = set.has(E.e) ? an.newEngineP : E.pOutTrue;
    ex += p; pNone *= 1 - p;
  }
  return { expected: ex, pAny: 1 - pNone, swaps: picks.length, racks: new Set(picks.map(E => E.rack)).size };
}

// Calibration summary against the simulator's truth.
export function calibration(an, bins = [0, 0.01, 0.05, 0.15, 0.4, 1.0001]) {
  const rows = bins.slice(0, -1).map((lo, i) => ({ lo, hi: bins[i + 1], n: 0, predC: 0, predM: 0, obs: 0, nM: 0, obsM: 0 }));
  let covC = 0, covM = 0, nCov = 0;
  for (const r of an.active) {
    const bi = rows.findIndex(b => r.pConf >= b.lo && r.pConf < b.hi);
    if (bi >= 0) { rows[bi].n++; rows[bi].predC += r.pConf; rows[bi].obs += r.pTrue; }
    const bm = rows.findIndex(b => r.pModel >= b.lo && r.pModel < b.hi);
    if (bm >= 0) { rows[bm].nM++; rows[bm].predM += r.pModel; rows[bm].obsM += r.pTrue; }
    if (r.upper != null) { nCov++; if (r.dTrueEnd <= r.upper) covC++; if (r.dTrueEnd <= r.upperModel) covM++; }
  }
  const sumC = an.active.reduce((s, r) => s + r.pConf, 0), sumM = an.active.reduce((s, r) => s + r.pModel, 0), sumT = an.active.reduce((s, r) => s + r.pTrue, 0);
  return { rows, coverage: { conformal: covC / nCov, model: covM / nCov, n: nCov, target: 1 - an.alpha }, totals: { conformal: sumC, model: sumM, truth: sumT } };
}
