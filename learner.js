// Online statistical learner. Logistic regression for P(Banker | not a tie).
// It starts exactly at the card math (weight 1 on the math, 0 on every pattern) and moves away
// only as far as real logged results justify. A pull back toward that starting point stops it
// from chasing short lucky runs.
(function (root) {
  'use strict';
  const B = root.Baccarat || (typeof require !== 'undefined' ? require('./engine.js') : null);

  const FEATURES = [
    { key: 'bias', name: 'Constant lean' },
    { key: 'math', name: 'Card math' },
    { key: 'last', name: 'Repeat last winner' },
    { key: 'streak', name: 'Streak length' },
    { key: 'chop', name: 'Ping-pong' },
    { key: 'hot', name: 'Hot side (last 10)' },
    { key: 'column', name: 'Big Road columns' },
    { key: 'derived', name: 'Derived roads (ask)' },
  ];
  const PRIOR = [0, 1, 0, 0, 0, 0, 0, 0];

  const sig = z => 1 / (1 + Math.exp(-z));
  const clampP = p => Math.min(0.99, Math.max(0.01, p));

  // Feature vector, positive values lean Banker.
  function features(history, mathQ) {
    const n = B.noTies(history);
    const last = n.length ? (n[n.length - 1] === 'B' ? 1 : -1) : 0;
    const streak = last * Math.min(B.streakLen(history), 6) / 6;
    const t = n.slice(-7);
    let alt = 0, tr = 0;
    for (let i = 1; i < t.length; i++) { tr++; if (t[i] !== t[i - 1]) alt++; }
    const chop = tr ? -last * (alt / tr) : 0;
    const w = n.slice(-10);
    const hot = w.length ? (2 * w.filter(x => x === 'B').length - w.length) / w.length : 0;
    const col = B.STRATEGIES.pattern.pick(history);
    const column = col === 'B' ? 1 : col === 'P' ? -1 : 0;
    // Derived roads: how many of Big Eye Boy / Small Road / Cockroach Pig turn red (pattern repeats)
    // if Banker wins next, minus the same count if Player wins next.
    const reds = arr => arr.filter(x => x === 'R').length;
    const derived = n.length ? (reds(B.derivedAsk(history, 'B')) - reds(B.derivedAsk(history, 'P'))) / 3 : 0;
    const q = clampP(mathQ);
    return [1, Math.log(q / (1 - q)), last, streak, chop, hot, column, derived];
  }

  function createModel(saved) {
    // Older saved models had fewer signals: keep what they learned and start new signals at zero.
    if (saved && Array.isArray(saved.w) && saved.w.length <= PRIOR.length) return { w: saved.w.concat(PRIOR.slice(saved.w.length)), n: saved.n || 0 };
    return { w: PRIOR.slice(), n: 0 };
  }

  function predict(m, x) {
    let z = 0;
    for (let i = 0; i < x.length; i++) z += m.w[i] * x[i];
    return sig(z);
  }

  // One stochastic gradient step. y = 1 if Banker won, 0 if Player won.
  function update(m, x, y) {
    const p = predict(m, x);
    const lr = 0.006 / Math.sqrt(1 + m.n / 500);
    const pull = 0.08;
    for (let i = 0; i < x.length; i++) m.w[i] += lr * ((y - p) * x[i] - pull * (m.w[i] - PRIOR[i]));
    m.n++;
  }

  // Scores the logged predictions (each made before its result was known).
  function stats(log, recent = 50) {
    const decided = log.filter(e => e.pred && e.result !== 'T');
    const acc = arr => arr.length ? arr.filter(e => e.pred.side === e.result).length / arr.length : null;
    const sure = decided.filter(e => e.pred.sure);
    let llModel = 0, llMath = 0;
    for (const e of decided) {
      const y = e.result === 'B' ? 1 : 0;
      const pm = clampP(e.pred.modelQ != null ? e.pred.modelQ : e.pred.q), pb = clampP(e.pred.mathQ);
      llModel += -Math.log(y ? pm : 1 - pm);
      llMath += -Math.log(y ? pb : 1 - pb);
    }
    const buckets = [[0.5, 0.52], [0.52, 0.55], [0.55, 0.6], [0.6, 1.01]].map(([lo, hi]) => {
      const inB = decided.filter(e => { const c = Math.max(e.pred.q, 1 - e.pred.q); return c >= lo && c < hi; });
      return { lo, hi, n: inB.length, said: inB.length ? inB.reduce((a, e) => a + Math.max(e.pred.q, 1 - e.pred.q), 0) / inB.length : null, hit: acc(inB) };
    });
    const road = log.filter(e => e.road && e.road.side && e.result !== 'T');
    const roadAcc = road.length ? road.filter(e => e.road.side === e.result).length / road.length : null;
    return {
      roadN: road.length,
      roadAccuracy: roadAcc,
      hands: log.length,
      decided: decided.length,
      accuracy: acc(decided),
      recent: acc(decided.slice(-recent)),
      recentN: Math.min(recent, decided.length),
      sureN: sure.length,
      sureAccuracy: acc(sure),
      // >0 means the learned model predicted better than the plain card math
      modelVsMath: decided.length ? (llMath - llModel) / decided.length : 0,
      buckets,
    };
  }

  root.Learner = { FEATURES, PRIOR, features, createModel, predict, update, stats };
  if (typeof module !== 'undefined') module.exports = root.Learner;
})(typeof window !== 'undefined' ? window : globalThis);
