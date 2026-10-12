// Background worker: trains the model on simulated shoes and tests it, without slowing the live reading.
/* global Baccarat, Learner */
importScripts('engine.js', 'learner.js');
const B = Baccarat, L = Learner;
const BASE_Q = 0.458597 / (0.458597 + 0.446247);

onmessage = e => {
  const { model, hands, seed, headline } = e.data;
  const m = L.createModel(model);
  const rng = B.mulberry32(seed >>> 0);
  let done = 0, h = [], shoe = B.dealShoe(rng), i = 0;
  while (done < hands) {
    if (i >= shoe.length) { shoe = B.dealShoe(rng); h = []; i = 0; }
    const r = shoe[i++];
    if (r !== 'T') {
      L.update(m, L.features(h, BASE_Q), r === 'B' ? 1 : 0);
      if (++done % 10000 === 0) postMessage({ progress: done });
    }
    h.push(r);
  }
  // Honest test on fresh shoes: predict the next hand after watching 4-6 hands.
  const modelPick = hh => (L.predict(m, L.features(hh, BASE_Q)) >= 0.5 ? 'B' : 'P');
  let n = 0, w = 0;
  for (let s = 0; s < 3000; s++) {
    const seq = B.dealShoe(rng);
    for (const k of [4, 5, 6]) {
      if (seq[k] === 'T') continue;
      const hh = seq.slice(0, k);
      const pick = headline !== 'model' ? (B.roadmapPick(hh).side || modelPick(hh)) : modelPick(hh);
      n++; if (pick === seq[k]) w++;
    }
  }
  postMessage({ done: true, model: m, hands, test: { n, rate: w / n } });
};
