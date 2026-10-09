// Sanity check: node test-engine.js
const B = require('./engine.js');
let t = Date.now();
const r = B.simulateStrategies(1000, 42);
const c = r.counts;
const pct = x => (x * 100).toFixed(2) + '%';
console.log(`hands ${c.hands}  B ${pct(c.B / c.hands)}  P ${pct(c.P / c.hands)}  T ${pct(c.T / c.hands)}  (${Date.now() - t} ms)`);
console.log('Expected (8 decks): B 45.86%  P 44.62%  T 9.52%');
for (const k in r.agg) {
  const a = r.agg[k];
  console.log(k.padEnd(9), 'bets', a.bets, 'win', pct(a.wins / (a.wins + a.losses)), 'return/bet', pct(a.net / a.bets));
}
t = Date.now();
console.log(B.conditionalNext(['B', 'B', 'B'], 500, 7), Date.now() - t, 'ms');
