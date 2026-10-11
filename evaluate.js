// Offline model evaluation over the hands this app has logged.
//
// Every number here comes from a walk-forward replay: each hand is predicted by a model that has
// only ever seen the hands before it, then the true result is used to train for the next one. No
// hand ever contributes to its own prediction, so these scores are prospective, not fitted.
//
// It scores a candidate model against the exact card odds, which is the bar that matters: a model
// that cannot beat plain shoe math is not carrying any information of its own.
(function (root) {
  'use strict';
  const B = root.Baccarat || (typeof require !== 'undefined' ? require('./engine.js') : null);
  const L = root.Learner || (typeof require !== 'undefined' ? require('./learner.js') : null);

  const clampP = p => Math.min(0.99, Math.max(0.01, p));
  const sig = z => 1 / (1 + Math.exp(-z));

  // Same online logistic rule the live learner uses, but with the width and starting point passed in,
  // so a wider feature set can be tried without disturbing the model that is running live.
  function fit(prior) {
    return { w: prior.slice(), prior, n: 0 };
  }
  function predictWith(m, x) {
    let z = 0;
    for (let i = 0; i < x.length; i++) z += m.w[i] * x[i];
    return sig(z);
  }
  function learn(m, x, y) {
    const p = predictWith(m, x);
    const lr = 0.006 / Math.sqrt(1 + m.n / 500);
    const pull = 0.08;
    for (let i = 0; i < x.length; i++) m.w[i] += lr * ((y - p) * x[i] - pull * (m.w[i] - m.prior[i]));
    m.n++;
  }

  // The live feature set, plus roadmap and shoe-progress signals it does not currently use.
  const RICH_PRIOR = [0, 1].concat(new Array(14).fill(0));   // 16 signals, starting at the card math
  function richFeatures(history, mathQ, ctx) {
    const base = L.features(history, mathQ);          // 8 signals the live model already weighs
    const n = B.noTies(history);
    const last = n.length ? (n[n.length - 1] === 'B' ? 1 : -1) : 0;
    const w20 = n.slice(-20);
    const hot20 = w20.length ? (2 * w20.filter(x => x === 'B').length - w20.length) / w20.length : 0;
    const cols = B.bigRoadCols(history);
    const curCol = cols.length ? cols[cols.length - 1] : null;
    const colLen = curCol ? last * Math.min(curCol.len, 6) / 6 : 0;
    const prevCol = cols.length > 1 ? cols[cols.length - 2] : null;
    // Does the current column match the length of the one before it? ("columns repeat")
    const colMatch = curCol && prevCol ? (curCol.len === prevCol.len ? 1 : curCol.len > prevCol.len ? -1 : 0) * last : 0;
    const three = ['big', 'small', 'cockroach'];
    const ask = side => B.derivedAsk(history, side);
    const askB = ask('B'), askP = ask('P');
    const road = three.map((_, i) => ((askB[i] === 'R' ? 1 : 0) - (askP[i] === 'R' ? 1 : 0)));
    const progress = ctx.handsThisShoe / 70;
    const seen = ctx.cardsSeen / 416;
    return base.concat([hot20, colLen, colMatch, road[0], road[1], road[2], progress - 0.5, seen]);
  }

  const MODELS = {
    baseline: { name: 'Exact card odds', baseline: true },
    live: { name: 'Live model (8 signals)', prior: [0, 1, 0, 0, 0, 0, 0, 0], features: (h, q) => L.features(h, q) },
    rich: { name: 'Roadmap-rich model (16 signals)', prior: RICH_PRIOR, features: richFeatures },
  };

  // Group logged hands into shoes, in the order they were played.
  function shoes(log) {
    const out = [];
    let cur = null;
    for (const e of log) {
      if (!e || !e.result) continue;
      if (!cur || cur.shoe !== e.shoe || cur.site !== e.site) { cur = { shoe: e.shoe, site: e.site, hands: [] }; out.push(cur); }
      cur.hands.push(e);
    }
    return out;
  }

  // Walk forward through every shoe, scoring each model on hands it has not seen.
  // mathQ is recomputed from the cards logged so far, exactly as the live app does it.
  function run(log, opts = {}) {
    const picked = opts.models || ['baseline', 'live', 'rich'];
    const state = {};
    for (const key of picked) {
      const spec = MODELS[key];
      state[key] = { spec, key, m: spec.baseline ? null : fit(spec.prior), n: 0, hits: 0, ll: 0, brier: 0, net: 0, perHandLL: [], buckets: new Map() };
    }
    const oddsCache = new Map();
    const oddsFor = counts => {
      const sig2 = counts.join(',');
      if (!oddsCache.has(sig2)) oddsCache.set(sig2, B.probsFromCounts(counts));
      return oddsCache.get(sig2);
    };
    let handsScored = 0, handsSkipped = 0, withCards = 0;

    const allShoes = shoes(log);
    for (const shoe of allShoes) {
      const counts = B.fullCounts();
      const history = [];
      let cardsSeen = 0;
      for (const e of shoe.hands) {
        const odds = oddsFor(counts) || { B: 0.4586, P: 0.4462, T: 0.0952 };
        const mathQ = clampP(odds.B / (odds.B + odds.P));
        const ctx = { handsThisShoe: history.length, cardsSeen };
        const decided = e.result !== 'T';
        const y = e.result === 'B' ? 1 : 0;

        for (const key of picked) {
          const s = state[key];
          const x = s.spec.baseline ? null : s.spec.features(history, mathQ, ctx);
          const q = s.spec.baseline ? mathQ : predictWith(s.m, x);
          if (decided) {
            const p = clampP(q), side = p >= 0.5 ? 'B' : 'P', conf = Math.max(p, 1 - p);
            const hit = side === e.result;
            s.n++; if (hit) s.hits++;
            const llh = -Math.log(y ? p : 1 - p);
            s.ll += llh; s.perHandLL.push(llh);
            s.brier += (p - y) ** 2;
            s.net += hit ? (side === 'B' ? 0.95 : 1) : -1;
            const band = conf < 0.52 ? '50–52%' : conf < 0.55 ? '52–55%' : conf < 0.60 ? '55–60%' : '60%+';
            const bk = s.buckets.get(band) || { n: 0, hit: 0, conf: 0 };
            bk.n++; bk.hit += hit ? 1 : 0; bk.conf += conf; s.buckets.set(band, bk);
          }
          // Train on the result only after it has been scored.
          if (!s.spec.baseline && decided) learn(s.m, x, y);
        }

        if (decided) handsScored++; else handsSkipped++;
        history.push(e.result);
        if (e.cards) {
          withCards++;
          for (const r of e.cards.P.concat(e.cards.B)) {
            const v = B.rankValue(r);
            if (counts[v] > 0) { counts[v]--; cardsSeen++; }
          }
        }
      }
    }

    const base = state.baseline;
    const out = { handsScored, ties: handsSkipped, withCards, shoes: allShoes.length, models: [] };
    for (const key of picked) {
      const s = state[key];
      if (!s.n) continue;
      const row = {
        key, name: s.spec.name, n: s.n,
        accuracy: s.hits / s.n,
        logLoss: s.ll / s.n,
        brier: s.brier / s.n,
        returnPerBet: s.net / s.n,
        buckets: [...s.buckets.entries()].map(([band, b]) => ({ band, n: b.n, claimed: b.conf / b.n, actual: b.hit / b.n })),
      };
      // Is the difference from the card-odds baseline bigger than its own noise? Paired per hand.
      if (base && base !== s && base.perHandLL.length === s.perHandLL.length) {
        const d = base.perHandLL.map((v, i) => v - s.perHandLL[i]);   // >0 means the model beat the baseline
        const mean = d.reduce((a, c) => a + c, 0) / d.length;
        const varr = d.reduce((a, c) => a + (c - mean) ** 2, 0) / Math.max(1, d.length - 1);
        const se = Math.sqrt(varr / d.length);
        row.vsBaseline = { gain: mean, se, lo: mean - 1.96 * se, hi: mean + 1.96 * se };
        row.beatsBaseline = row.vsBaseline.lo > 0;
      }
      out.models.push(row);
    }
    return out;
  }

  // Plain-language verdict, so a number that looks good is not mistaken for a result that is real.
  function verdict(res) {
    if (!res.handsScored) return 'No decided hands logged yet.';
    if (res.handsScored < 500) return `Only ${res.handsScored} decided hands: far too few to tell any model apart from chance. Several thousand are needed.`;
    const winners = res.models.filter(m => m.beatsBaseline);
    if (!winners.length) return `No model beat the exact card odds on ${res.handsScored} unseen hands.`;
    return `${winners.map(w => w.name).join(' and ')} beat the exact card odds on ${res.handsScored} unseen hands; worth a second look, not a bet.`;
  }

  root.Evaluator = { run, verdict, MODELS, richFeatures };
  if (typeof module !== 'undefined') module.exports = root.Evaluator;
})(typeof window !== 'undefined' ? window : globalThis);
