import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../core/continuity.js';

const close = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('Poisson-binomial tail matches brute-force enumeration', () => {
  const ps = [0.3, 0.05, 0.6, 0.12, 0.9];
  for (let s = -1; s <= 5; s++) {
    let brute = 0;
    for (let mask = 0; mask < 32; mask++) {
      let pr = 1, k = 0;
      ps.forEach((p, i) => { if (mask >> i & 1) { pr *= p; k++; } else pr *= 1 - p; });
      if (k > s) brute += pr;
    }
    close(C.pExceed(ps, s), brute, 1e-12, `s=${s}`);
  }
});

test('Arrhenius acceleration and drift model are consistent', () => {
  close(C.accel(C.CFG.Tref), 1, 1e-12, 'AF at Tref');
  assert.ok(C.accel(80) > C.accel(60));
  const L = { logA: Math.log(6e-4), m: 0.5, start: 0 };
  const AF = C.accel(72), wear = Math.pow(C.CFG.eolDrift / 6e-4, 1 / 0.5) / AF;
  close(C.trueDrift(L, AF, wear), C.CFG.eolDrift, 1e-9, 'drift at wear-out time equals EOL');
});

test('simulation is deterministic and respects N-of-M sparing', () => {
  const a = C.simulate(7), b = C.simulate(7);
  assert.equal(a.engines.length, 4096);
  assert.deepEqual(a.engines.slice(0, 50).map(E => E.events.length), b.engines.slice(0, 50).map(E => E.events.length));
  for (const E of a.engines) {
    // an outage only happens after M - N spares have been used
    if (E.outages.length) assert.ok(E.events.filter(v => v.t <= E.outages[0].t).length >= C.CFG.M - C.CFG.N + 1);
  }
});

test('service plan DP is optimal (brute force on a small instance)', () => {
  const engines = [];
  const R = C.rng(3);
  for (let r = 0; r < 4; r++) for (let i = 0; i < 4; i++) engines.push({ e: engines.length, rack: r, outagesSoFar: 0, pOut: R() ** 3 });
  const an = { sim: { cfg: { ...C.CFG, racks: 4 }, engines }, newEngineP: 0.001 };
  for (const [B, V] of [[3, 1], [4, 2], [6, 3], [5, 4]]) {
    const picks = C.plan(an, B, V, 'pOut');
    const val = (set) => set.reduce((s, E) => s + Math.max(0, E.pOut - 0.001), 0);
    let best = 0;
    for (let mask = 0; mask < 1 << 16; mask++) {
      const set = engines.filter((_, i) => mask >> i & 1);
      if (set.length > B || new Set(set.map(E => E.rack)).size > V) continue;
      best = Math.max(best, val(set));
    }
    assert.ok(picks.length <= B && new Set(picks.map(E => E.rack)).size <= V, 'constraints');
    close(val(picks), best, 1e-12, `B=${B} V=${V}`);
  }
});

test('calibrated forecasts track the simulator truth; model-only under-predicts', () => {
  for (const seed of [20261110, 1003]) {
    const an = C.analyze(C.simulate(seed), { horizonWeeks: 26 });
    const cal = C.calibration(an);
    const rc = cal.totals.conformal / cal.totals.truth, rm = cal.totals.model / cal.totals.truth;
    assert.ok(rc > 0.9 && rc < 1.15, `conformal/truth lasers ${rc}`);
    assert.ok(rm < 0.8, `model/truth lasers ${rm}`);
    assert.ok(cal.coverage.conformal >= 0.89, `conformal coverage ${cal.coverage.conformal}`);
    assert.ok(cal.coverage.model < cal.coverage.conformal);
    // probabilities are probabilities
    for (const r of an.active.slice(0, 2000)) assert.ok(r.pConf >= 0 && r.pConf <= 1 && r.pModel >= 0 && r.pModel <= 1);
  }
});

test('calibrated ranking reaches low risk with far fewer swaps than drift ranking', () => {
  const need = [];
  for (const seed of [20261110, 1002, 1004]) {
    const sim = C.simulate(seed), an = C.analyze(sim, { horizonWeeks: 26 });
    const live = sim.engines.filter(E => !E.outagesSoFar);
    const front = (key) => { const o = [...live].sort(key); let v = live.reduce((s, E) => s + E.pOutTrue, 0); for (let i = 0; i < o.length; i++) { if (v <= 0.5) return i; v += an.newEngineP - o[i].pOutTrue; } return o.length; };
    const c = front((a, b) => b.pOut - a.pOut), d = front((a, b) => (a.sparesLeft - b.sparesLeft) || (b.worstDrift - a.worstDrift));
    need.push([c, d]);
    assert.ok(c * 5 < d, `seed ${seed}: calibrated ${c} vs drift ${d}`);
  }
});

test('evaluate counts swapped engines at fresh-engine risk', () => {
  const an = C.analyze(C.simulate(20261110), { horizonWeeks: 13 });
  const top = [...an.sim.engines].filter(E => !E.outagesSoFar).sort((a, b) => b.pOutTrue - a.pOutTrue).slice(0, 3);
  const before = C.evaluate(an, []).expected, after = C.evaluate(an, top).expected;
  close(before - after, top.reduce((s, E) => s + E.pOutTrue - an.newEngineP, 0), 1e-9, 'difference');
});
