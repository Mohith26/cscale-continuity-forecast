// Re-simulate N fleets and report calibration and planning results against simulator truth.
// Usage: node scripts/validate.mjs [fleets] [horizonWeeks]
import * as C from '../core/continuity.js';
const n = Number(process.argv[2] || 20), hw = Number(process.argv[3] || 26);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const R = { ratioC: [], ratioM: [], covC: [], covM: [], engC: [], engM: [], engT: [], needC: [], needM: [], needD: [] };
for (let s = 0; s < n; s++) {
  const sim = C.simulate(5000 + s), an = C.analyze(sim, { horizonWeeks: hw }), cal = C.calibration(an);
  const live = sim.engines.filter(E => !E.outagesSoFar);
  R.ratioC.push(cal.totals.conformal / cal.totals.truth); R.ratioM.push(cal.totals.model / cal.totals.truth);
  R.covC.push(cal.coverage.conformal); R.covM.push(cal.coverage.model);
  R.engC.push(live.reduce((q, E) => q + E.pOut, 0)); R.engM.push(live.reduce((q, E) => q + E.pOutModel, 0)); R.engT.push(live.reduce((q, E) => q + E.pOutTrue, 0));
  const front = (key) => { const o = [...live].sort(key); let v = live.reduce((q, E) => q + E.pOutTrue, 0); for (let i = 0; i < o.length; i++) { if (v <= 0.5) return i; v += an.newEngineP - o[i].pOutTrue; } return o.length; };
  R.needC.push(front((a, b) => b.pOut - a.pOut)); R.needM.push(front((a, b) => b.pOutModel - a.pOutModel)); R.needD.push(front((a, b) => (a.sparesLeft - b.sparesLeft) || (b.worstDrift - a.worstDrift)));
}
const f = (a, d = 3) => `median ${med(a).toFixed(d)} [${Math.min(...a).toFixed(d)}, ${Math.max(...a).toFixed(d)}]`;
console.log(`${n} fleets, ${hw}-week horizon`);
console.log(`lasers wearing out, forecast/truth: calibrated ${f(R.ratioC)}; model-only ${f(R.ratioM)}`);
console.log(`90% upper-bound coverage of true drift: calibrated ${f(R.covC)}; model-only ${f(R.covM)}`);
console.log(`engines losing a channel: calibrated ${f(R.engC, 2)}; model-only ${f(R.engM, 2)}; truth ${f(R.engT, 2)}`);
console.log(`swaps to reach 0.5 expected losses: calibrated ${f(R.needC, 0)}; model-only ${f(R.needM, 0)}; drift ranking ${f(R.needD, 0)}`);
