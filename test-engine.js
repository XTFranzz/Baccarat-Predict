// Sanity check: node test-engine.js
const B = require('./engine.js');
const L = require('./learner.js');
const assert = require('assert');
let t = Date.now();
const fullShoe = B.fullCounts();
const fullShoeBefore = fullShoe.slice();
const exact = B.probsFromCounts(fullShoe);
assert(Math.abs(exact.B - 0.458597) < 0.000001, 'exact 8-deck Banker odds');
assert(Math.abs(exact.P - 0.446247) < 0.000001, 'exact 8-deck Player odds');
assert(Math.abs(exact.T - 0.095156) < 0.000001, 'exact 8-deck Tie odds');
assert(Math.abs(exact.B + exact.P + exact.T - 1) < 1e-12, 'exact odds sum to 1');
assert.deepStrictEqual(fullShoe, fullShoeBefore, 'odds calculation does not mutate card counts');
assert.deepStrictEqual(B.probsFromCounts(fullShoe), exact, 'exact odds are deterministic');
assert.strictEqual(B.probsFromCounts([1, 2]), null, 'invalid shoe count shape rejected');
const model = L.createModel(null);
model.w[3] = -2;
const streakOdds = L.predict(model, L.features(['B', 'B', 'B', 'B', 'B', 'B'], exact.B / (exact.B + exact.P)));
assert(streakOdds < 0.5, 'learned streak signal can move a forecast to Player');
assert.strictEqual(L.decision({
  modelQ: 0.65, math: { B: 0.3, P: 0.6, T: 0.1 }, proofN: 600, modelVsMath: 0.01, shoeComplete: false,
}).side, null, 'partial shoe never gets an edge recommendation');
assert.strictEqual(L.decision({
  modelQ: 0.65, math: { B: 0.3, P: 0.6, T: 0.1 }, proofN: 200, modelVsMath: 0.01, shoeComplete: true,
}).side, null, 'unvalidated model never gets an edge recommendation');
assert.strictEqual(L.decision({
  modelQ: 0.5, math: exact, proofN: 600, modelVsMath: 0.01, shoeComplete: true,
}).side, null, 'negative expected returns produce no pick');
const consensusOdds = { B: 0.46, P: 0.45, T: 0.09 };
assert.strictEqual(L.decision({
  modelQ: 0.7, math: consensusOdds, proofN: 600, modelVsMath: 0.01, shoeComplete: true,
  roadSide: 'B', roadN: 120, roadAccuracy: 0.58,
}).side, 'B', 'model and validated roadmap consensus can recommend Banker');
assert.strictEqual(L.decision({
  modelQ: 0.3, math: consensusOdds, proofN: 600, modelVsMath: 0.01, shoeComplete: true,
  roadSide: 'P', roadN: 120, roadAccuracy: 0.58,
}).side, 'P', 'model and validated roadmap consensus can recommend Player');
assert.strictEqual(L.decision({
  modelQ: 0.7, math: consensusOdds, proofN: 600, modelVsMath: 0.01, shoeComplete: true,
  roadSide: 'P', roadN: 120, roadAccuracy: 0.58,
}).side, null, 'disagreeing model and roadmap produce no consensus');
const score = L.stats([
  { joined: true, pred: { side: 'B', q: 0.9, mathQ: 0.9 }, road: { side: 'B' }, result: 'B' },
  { replay: true, pred: { side: 'B', q: 0.9, mathQ: 0.9 }, road: { side: 'B' }, result: 'B' },
  { pred: { side: 'P', q: 0.5, mathQ: 0.5, modelQ: 0.5 }, road: { side: 'B' }, result: 'P' },
]);
assert.strictEqual(score.decided, 1, 'joined and replayed predictions are excluded from odds scoring');
assert.strictEqual(score.accuracy, 1, 'only live prediction accuracy is scored');
assert.strictEqual(score.roadN, 1, 'joined and replayed roadmap picks are excluded');
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
