// Simulates shoes and measures how often each kind of roadmap call is right on the next hand.
// Writes pattern-stats.json, which the app loads to show this next to every roadmap pick.
//   node scripts/pattern-stats.js [shoes]
const path = require('path');
const fs = require('fs');
const B = require('../engine.js');
const SHOES = +process.argv[2] || 100000;
const rng = B.mulberry32(20261013);
const by = {};
let total = 0, right = 0, t0 = Date.now();
for (let s = 0; s < SHOES; s++) {
  const seq = B.dealShoe(rng), h = [];
  for (const r of seq) {
    const pick = B.roadmapPick(h);
    if (pick.side && r !== 'T') {
      const k = B.pickCategory(pick);
      const c = by[k] = by[k] || { calls: 0, right: 0 };
      c.calls++; total++;
      if (pick.side === r) { c.right++; right++; }
    }
    h.push(r);
  }
  if ((s + 1) % 10000 === 0) console.log(`${s + 1} shoes… (${Math.round((Date.now() - t0) / 1000)} s)`);
}
const categories = Object.fromEntries(Object.entries(by).sort((a, b) => b[1].calls - a[1].calls)
  .map(([k, c]) => [k, { calls: c.calls, right: c.right, rate: +(c.right / c.calls).toFixed(5) }]));
const out = { shoes: SHOES, made: new Date().toISOString(), allCalls: total, allRate: +(right / total).toFixed(5), categories };
fs.writeFileSync(path.join(__dirname, '..', 'pattern-stats.json'), JSON.stringify(out, null, 1));
console.log(`\n${SHOES.toLocaleString()} shoes: all roadmap picks right ${(out.allRate * 100).toFixed(2)}% of ${total.toLocaleString()}`);
for (const [k, c] of Object.entries(categories)) console.log('  ' + k.padEnd(48), (c.rate * 100).toFixed(2) + '%  of', c.calls.toLocaleString());
