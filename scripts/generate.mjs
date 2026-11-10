// Writes a summary of the seeded synthetic fleet the page simulates (for inspection).
// Usage: node scripts/generate.mjs [seed]
import { writeFileSync } from 'node:fs';
import { simulate, H_WEEK } from '../core/continuity.js';
const seed = Number(process.argv[2] || 20261110), sim = simulate(seed);
const engines = sim.engines.map(E => ({ engine: `R${E.rack + 1}-A${E.acc + 1}-E${E.k + 1}`, lot: E.lot, tempC: +E.temp.toFixed(1), installWeek: E.install,
  failuresByNow: E.events.filter(v => v.t <= sim.nowH).length, outagesByNow: E.outages.filter(v => v.t <= sim.nowH).length }));
writeFileSync(new URL('../data/fleet-summary.json', import.meta.url), JSON.stringify({ seed, nowWeek: sim.cfg.nowWeek, cfg: sim.cfg, engines }));
console.log(`wrote data/fleet-summary.json: ${engines.length} engines, seed ${seed}`);
