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

  // A reading fault that logs the same result over and over shows up as a streak far too long for the
  // hands around it. Length alone does not settle it — across 1.1M dealt hands a run of 20 did turn up
  // — so what counts is the run against the length of its own shoe: 23 in a row inside 25 hands is a
  // one-in-two-million event, while 16 inside a full shoe is merely rare. Flagged below once in a
  // thousand shoes, where a misreading is the overwhelmingly likelier explanation.
  const SIDE_P = 0.5068;        // the more likely side on a decided hand
  function runImplausible(len, n) {
    if (len < 10 || n < 2) return false;
    const expected = Math.max(1, n - len + 1) * Math.pow(SIDE_P, len) * (1 - SIDE_P);
    return 1 - Math.exp(-expected) < 0.001;
  }
  function longestRun(hands) {
    const n = hands.map(e => e.result).filter(r => r !== 'T');
    let best = 0, c = 0, prev = null;
    for (const r of n) { c = r === prev ? c + 1 : 1; prev = r; if (c > best) best = c; }
    return best;
  }

  // Group logged hands into shoes, in the order they were played.
  function shoes(log) {
    const out = [];
    let cur = null;
    for (const e of log) {
      if (!e || !e.result) continue;
      if (!cur || cur.shoe !== e.shoe || cur.site !== e.site) { cur = { shoe: e.shoe, site: e.site, hands: [] }; out.push(cur); }
      cur.hands.push(e);
    }
    for (const s of out) {
      s.longestRun = longestRun(s.hands);
      s.decided = s.hands.filter(e => e.result !== 'T').length;
      s.suspect = runImplausible(s.longestRun, s.decided);
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
    // The exact odds take about 10ms, which is the whole cost of a large run. On a very long run the
    // card-composition drift can be refreshed every few hands instead of every hand; the pattern
    // signals are unaffected, and how much the composition itself is worth is measured separately.
    const everyN = Math.max(1, opts.oddsEveryN || 1);
    const oddsCache = new Map();
    let sinceOdds = 0, lastOdds = null;
    const oddsFor = counts => {
      if (lastOdds && sinceOdds % everyN !== 0) { sinceOdds++; return lastOdds; }
      sinceOdds++;
      const sig2 = counts.join(',');
      if (!oddsCache.has(sig2)) {
        if (oddsCache.size > 50000) oddsCache.clear();
        oddsCache.set(sig2, B.probsFromCounts(counts));
      }
      lastOdds = oddsCache.get(sig2);
      return lastOdds;
    };
    let handsScored = 0, handsSkipped = 0, withCards = 0;

    const allShoes = shoes(log);
    const suspect = allShoes.filter(s => s.suspect);
    for (const shoe of allShoes) {
      if (shoe.suspect) continue;   // logged by a misreading, not played
      const counts = B.fullCounts();
      const history = [];
      let cardsSeen = 0;
      sinceOdds = 0; lastOdds = null;
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
    const out = { handsScored, ties: handsSkipped, withCards, shoes: allShoes.length - suspect.length, models: [],
      dropped: suspect.map(s => ({ shoe: s.shoe, hands: s.hands.length, decided: s.decided, longestRun: s.longestRun })) };
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
      if (s.m) row.weights = s.m.w.slice();
      out.models.push(row);
    }
    return out;
  }

  // Plain-language verdict, so a number that looks good is not mistaken for a result that is real.
  function verdict(res) {
    const dropped = res.dropped && res.dropped.length
      ? ` ${res.dropped.length} shoe${res.dropped.length > 1 ? 's were' : ' was'} left out: a streak of ${Math.max(...res.dropped.map(d => d.longestRun))} in a shoe that short is far likelier to be the same result logged repeatedly than a real deal.`
      : '';
    if (!res.handsScored) return 'No decided hands logged yet.' + dropped;
    if (res.handsScored < 500) return `Only ${res.handsScored} decided hands: far too few to tell any model apart from chance. Several thousand are needed.` + dropped;
    const winners = res.models.filter(m => m.beatsBaseline);
    if (!winners.length) return `No model beat the exact card odds on ${res.handsScored} unseen hands.` + dropped;
    return `${winners.map(w => w.name).join(' and ')} beat the exact card odds on ${res.handsScored} unseen hands; worth a second look, not a bet.` + dropped;
  }

  // Shoes dealt by the engine, written in the form the app logs them. The same model test can then be
  // run at a scale live play would need hundreds of hours to reach — on hands that are fair by
  // construction, so anything a model "finds" in them is by definition noise.
  function simulate(numShoes, seed) {
    const rng = B.mulberry32(seed || 1);
    const log = [];
    for (let s = 1; s <= numShoes; s++) {
      B.dealShoeHands(rng).forEach((h, i) => log.push({
        site: 'sim', shoe: s, hand: i + 1, result: h.result, cards: { P: h.P, B: h.B },
      }));
    }
    return log;
  }

  root.Evaluator = { run, verdict, simulate, MODELS, richFeatures };
  if (typeof module !== 'undefined') module.exports = root.Evaluator;
})(typeof window !== 'undefined' ? window : globalThis);
