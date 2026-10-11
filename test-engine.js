// Sanity check: node test-engine.js
const B = require('./engine.js');
const L = require('./learner.js');
const V = require('./vision.js');
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
const cardFrame = { width: 240, height: 80, data: new Uint8ClampedArray(240 * 80 * 4) };
for (let i = 0; i < cardFrame.data.length; i += 4) {
  cardFrame.data[i] = 145; cardFrame.data[i + 1] = 32; cardFrame.data[i + 2] = 18; cardFrame.data[i + 3] = 255;
}
for (const b of [
  { x: 20, y: 10, w: 38, h: 48 }, { x: 61, y: 20, w: 38, h: 38 },
  { x: 124, y: 20, w: 38, h: 38 }, { x: 165, y: 10, w: 38, h: 48 },
]) {
  for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
    const i = (y * cardFrame.width + x) * 4;
    cardFrame.data[i] = 195; cardFrame.data[i + 1] = 185; cardFrame.data[i + 2] = 180;
  }
  for (let y = b.y + 5; y < b.y + 13; y++) for (let x = b.x + 5; x < b.x + 9; x++) {
    const i = (y * cardFrame.width + x) * 4;
    cardFrame.data[i] = 35; cardFrame.data[i + 1] = 35; cardFrame.data[i + 2] = 35;
  }
}
const detectedCards = V.findCards(cardFrame, { x: 0, y: 0, width: 240, height: 80 });
assert(detectedCards, 'pale, overlapping live-style cards are detected');
assert.strictEqual(detectedCards.left.length, 2, 'live-style Player card group is split correctly');
assert.strictEqual(detectedCards.right.length, 2, 'live-style Banker card group is split correctly');
const tinyFrame = { width: 240, height: 80, data: new Uint8ClampedArray(240 * 80 * 4) };
for (let i = 0; i < tinyFrame.data.length; i += 4) {
  tinyFrame.data[i] = 145; tinyFrame.data[i + 1] = 32; tinyFrame.data[i + 2] = 18; tinyFrame.data[i + 3] = 255;
}
for (const x of [20, 42, 124, 146]) for (let y = 28; y < 46; y++) for (let xx = x; xx < x + 18; xx++) {
  const i = (y * tinyFrame.width + xx) * 4;
  tinyFrame.data[i] = 195; tinyFrame.data[i + 1] = 185; tinyFrame.data[i + 2] = 180;
}
assert.strictEqual(V.findCards(tinyFrame, { x: 0, y: 0, width: 240, height: 80 }), null,
  'small bright UI elements are not mistaken for four card faces');
const tieFrame = { width: 720, height: 120, data: new Uint8ClampedArray(720 * 120 * 4) };
for (let i = 0; i < tieFrame.data.length; i += 4) {
  tieFrame.data[i] = 145; tieFrame.data[i + 1] = 32; tieFrame.data[i + 2] = 18; tieFrame.data[i + 3] = 255;
}
for (const b of [
  { x: 20, y: 42, w: 92, h: 62 }, { x: 112, y: 14, w: 70, h: 87 }, { x: 187, y: 18, w: 70, h: 87 },
  { x: 424, y: 22, w: 69, h: 87 }, { x: 497, y: 19, w: 69, h: 86 }, { x: 570, y: 40, w: 92, h: 62 },
]) {
  for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
    const i = (y * tieFrame.width + x) * 4;
    tieFrame.data[i] = 195; tieFrame.data[i + 1] = 185; tieFrame.data[i + 2] = 180;
  }
}
for (let y = 14; y < 104; y++) for (let x = 108; x < 115; x++) {
  if (x >= 110 && x <= 112 && y >= 66 && y <= 71) continue;
  const i = (y * tieFrame.width + x) * 4;
  tieFrame.data[i] = 145; tieFrame.data[i + 1] = 32; tieFrame.data[i + 2] = 18;
}
const tieCards = V.findCards(tieFrame, { x: 0, y: 0, width: 720, height: 120 });
assert(tieCards, 'Pragmatic-style six-card tie layout with a dealer-obscured joined edge is detected');
assert.strictEqual(tieCards.left.length, 3, 'sideways third Player card stays with Player');
assert.strictEqual(tieCards.right.length, 3, 'sideways third Banker card stays with Banker');
assert(tieCards.left.some(c => c.rotated) && tieCards.right.some(c => c.rotated), 'sideways third cards on both sides are marked rotated');
const glyphRows = ['01110', '10001', '10001', '10001', '10101', '10010', '01101'];
function glyphFrame(topGlyph) {
  const frame = { width: 40, height: 56, data: new Uint8ClampedArray(40 * 56 * 4) };
  for (let i = 0; i < frame.data.length; i += 4) {
    frame.data[i] = frame.data[i + 1] = frame.data[i + 2] = 235; frame.data[i + 3] = 255;
  }
  const paint = (x0, y0, reverse) => {
    glyphRows.forEach((row, y) => [...row].forEach((on, x) => {
      if (on !== '1') return;
      for (let py = 0; py < 2; py++) for (let px = 0; px < 2; px++) {
        const x1 = x0 + (reverse ? 4 - x : x) * 2 + px, y1 = y0 + (reverse ? 6 - y : y) * 2 + py;
        const i = (y1 * frame.width + x1) * 4;
        frame.data[i] = frame.data[i + 1] = frame.data[i + 2] = 30;
      }
    }));
  };
  if (topGlyph) paint(4, 4, false);
  paint(26, 38, true);
  return frame;
}
function rotateFrame(frame, turns) {
  let out = frame;
  for (let turn = 0; turn < turns; turn++) {
    const next = { width: out.height, height: out.width, data: new Uint8ClampedArray(out.data.length) };
    for (let y = 0; y < out.height; y++) for (let x = 0; x < out.width; x++) {
      const from = (y * out.width + x) * 4, to = (x * next.width + next.width - 1 - y) * 4;
      next.data.set(out.data.subarray(from, from + 4), to);
    }
    out = next;
  }
  return out;
}
const glyphTemplateFrame = glyphFrame(true);
const glyphTemplate = V.glyphFeature(V.uprightAccessor(glyphTemplateFrame, { x: 0, y: 0, width: 40, height: 56 }, 0), 1, 1, 20, 16);
const obscuredRank = V.readCard(glyphFrame(false), { x: 0, y: 0, width: 40, height: 56 }, [{ ...glyphTemplate, rank: 'Q', seed: true }]);
assert(obscuredRank && obscuredRank.rank === 'Q' && obscuredRank.corner === 'bottom-right',
  'rank is recovered from the duplicate corner when a winner banner covers the other corner');
const wrongSeed = { ...glyphTemplate, rank: 'A', seed: true };
const calibrationRead = V.readCard(glyphFrame(true), { x: 0, y: 0, width: 40, height: 56 }, [wrongSeed]);
assert(calibrationRead && calibrationRead.feat, 'a confirmed calibration card retains its observed rank feature');
const confirmedTemplate = { ...calibrationRead.feat, rank: 'Q' };
for (let turn = 0; turn < 4; turn++) {
  const frame = rotateFrame(glyphFrame(true), turn);
  const read = V.readCard(frame, { x: 0, y: 0, width: frame.width, height: frame.height }, [wrongSeed, confirmedTemplate]);
  assert(read && read.rank === 'Q', `confirmed site template overrides the wrong generic guess after ${turn * 90} degree rotation`);
}
// Live-stream card faces: a big rank with the suit BESIDE it, a barcode down the middle, and table
// felt inside the card's box because the card lies at an angle. Only the rank may be read.
function liveCardFrame(suit) {
  const W = 64, H = 88;
  const frame = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  const put = (x, y, v) => { const i = (y * W + x) * 4; frame.data[i] = v[0]; frame.data[i + 1] = v[1]; frame.data[i + 2] = v[2]; frame.data[i + 3] = 255; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, [145, 32, 18]);   // felt
  for (let y = 4; y < H - 4; y++) for (let x = 6; x < W - 4; x++) put(x, y, [238, 234, 228]);
  const paint = (x0, y0, s) => glyphRows.forEach((row, y) => [...row].forEach((on, x) => {
    if (on !== '1') return;
    for (let py = 0; py < s; py++) for (let px = 0; px < s; px++) put(x0 + x * s + px, y0 + y * s + py, [25, 25, 25]);
  }));
  paint(10, 8, 4);                                                                   // rank, top left
  if (suit) for (let y = 8; y < 32; y++) for (let x = 33; x < 53; x++) put(x, y, [20, 20, 20]);
  for (let b = 0; b < 4; b++) for (let y = 42 + b * 4; y < 44 + b * 4; y++)
    for (let x = 26; x < 44; x++) put(x, y, [120, 120, 120]);                         // security barcode
  return frame;
}
const liveBox = { x: 0, y: 0, width: 64, height: 88 };
const liveTemplate = { ...V.glyphFeature(V.uprightAccessor(liveCardFrame(false), liveBox, 0), 1, 1, 38, 42), rank: 'Q', seed: true };
const beside = V.readCard(liveCardFrame(true), liveBox, [liveTemplate]);
const alone = V.readCard(liveCardFrame(false), liveBox, [liveTemplate]);
assert(beside && beside.rank === 'Q', 'rank is read from a live-stream card face that carries its suit beside it');
assert(alone && Math.abs(beside.dist - alone.dist) < 1e-9,
  'a suit printed beside the rank changes nothing about the rank that is read');
assert(beside.feat.parts === 1, 'a suit beside the rank is not counted as a second digit');

// ---- walk-forward model test ----
const E = require('./evaluate.js');
const oneHand = E.run([{ site: 's', shoe: 1, hand: 1, result: 'B' }]);
const [evalBase, evalLive] = [oneHand.models.find(m => m.key === 'baseline'), oneHand.models.find(m => m.key === 'live')];
assert.strictEqual(oneHand.handsScored, 1, 'a single decided hand is scored once');
assert(Math.abs(evalBase.logLoss - evalLive.logLoss) < 1e-12,
  'the first hand is predicted by an untrained model, so it cannot differ from the card odds: no result leaks into its own prediction');
assert.strictEqual(E.run([{ site: 's', shoe: 1, hand: 1, result: 'T' }]).handsScored, 0, 'ties are excluded from scoring');
const tenB = E.run(Array.from({ length: 10 }, (_, i) => ({ site: 's', shoe: 1, hand: i + 1, result: 'B' })));
assert.strictEqual(tenB.models.find(m => m.key === 'baseline').accuracy, 1, 'card odds call every hand of an all-Banker log correctly');
assert(Math.abs(tenB.models.find(m => m.key === 'baseline').returnPerBet - 0.95) < 1e-12, 'Banker wins pay 0.95 after commission');
// Cards logged against a hand are removed from the shoe for later hands, as the live app does.
const withCards = E.run([
  { site: 's', shoe: 1, hand: 1, result: 'B', cards: { P: ['5', '5'], B: ['9', 'K'] } },
  { site: 's', shoe: 1, hand: 2, result: 'P' },
]);
assert.strictEqual(withCards.withCards, 1, 'hands carrying cards are counted');
// On shoes dealt at random, neither learned model may beat the exact odds by more than its own noise.
const noiseRng = B.mulberry32(11), noiseLog = [];
for (let sh = 1; sh <= 25; sh++) B.dealShoe(noiseRng).forEach((res, i) => noiseLog.push({ site: 's', shoe: sh, hand: i + 1, result: res }));
const noise = E.run(noiseLog);
assert(noise.handsScored > 1000, 'the noise check has enough hands to mean something');
assert(!noise.models.some(m => m.beatsBaseline),
  'no roadmap model beats the exact card odds on randomly dealt shoes');

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
