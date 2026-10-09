// Baccarat engine: real 8-deck shoe, real third-card rules, pattern strategies, Monte Carlo.
(function (root) {
  'use strict';

  // ---------- RNG (seedable, fast) ----------
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------- Shoe ----------
  // Card values: A=1, 2-9, 10/J/Q/K=0
  function newShoe(decks, rng) {
    const cards = [];
    for (let d = 0; d < decks; d++)
      for (let s = 0; s < 4; s++)
        for (let r = 1; r <= 13; r++) cards.push(r >= 10 ? 0 : r);
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = cards[i]; cards[i] = cards[j]; cards[j] = t;
    }
    return cards;
  }

  // Resolve one hand. draw() returns the next card value (0-9). Returns 'B' | 'P' | 'T'.
  function resolve(draw) {
    const p1 = draw(), b1 = draw(), p2 = draw(), b2 = draw();
    let p = (p1 + p2) % 10, b = (b1 + b2) % 10;
    if (p < 8 && b < 8) {
      let p3 = -1;
      if (p <= 5) { p3 = draw(); p = (p + p3) % 10; }
      if (bankerDraws(b, p3)) b = (b + draw()) % 10;
    }
    return b > p ? 'B' : p > b ? 'P' : 'T';
  }

  // Banker drawing rule. p3 = Player's third card value, or -1 if Player stood.
  function bankerDraws(b, p3) {
    if (p3 === -1) return b <= 5;
    if (b <= 2) return true;
    if (b === 3) return p3 !== 8;
    if (b === 4) return p3 >= 2 && p3 <= 7;
    if (b === 5) return p3 >= 4 && p3 <= 7;
    if (b === 6) return p3 === 6 || p3 === 7;
    return false;
  }

  // Play one hand from the shoe starting at index pos.
  function playHand(shoe, pos) {
    let i = pos;
    const result = resolve(() => shoe[i++]);
    return { result, used: i - pos };
  }

  // Deal a whole shoe and return its outcome sequence.
  function dealShoe(rng, decks = 8, cutFromEnd = 14) {
    const shoe = newShoe(decks, rng);
    let pos = 0;
    const burn = shoe[pos++] || 10; pos += burn; // burn rule: first card's value (10s burn 10)
    const out = [];
    while (pos < shoe.length - cutFromEnd - 6) {
      const h = playHand(shoe, pos);
      pos += h.used; out.push(h.result);
    }
    return out;
  }

  // ---------- Payouts (net units for a 1-unit bet) ----------
  function payout(bet, result, commission = 0.05, tiePays = 8) {
    if (bet === 'T') return result === 'T' ? tiePays : -1;
    if (result === 'T') return 0; // B/P bets push on a tie
    if (bet === result) return bet === 'B' ? 1 - commission : 1;
    return -1;
  }

  // ---------- Pattern strategies ----------
  const noTies = h => h.filter(x => x !== 'T');
  const opp = x => (x === 'B' ? 'P' : 'B');

  function streakLen(h) {
    const n = noTies(h);
    if (!n.length) return 0;
    let k = 1; while (k < n.length && n[n.length - 1 - k] === n[n.length - 1]) k++;
    return k;
  }

  // Big Road columns (ties ignored)
  function bigRoadCols(h) {
    const cols = [];
    for (const x of noTies(h)) {
      if (cols.length && cols[cols.length - 1].side === x) cols[cols.length - 1].len++;
      else cols.push({ side: x, len: 1 });
    }
    return cols;
  }

  const STRATEGIES = {
    follow: {
      name: 'Follow the streak',
      desc: 'Bets the same side as the last result.',
      pick(h) { const n = noTies(h); return n.length ? n[n.length - 1] : null; },
    },
    chop: {
      name: 'Ping-pong / chop',
      desc: 'Bets the opposite of the last result.',
      pick(h) { const n = noTies(h); return n.length ? opp(n[n.length - 1]) : null; },
    },
    majority: {
      name: 'Hot side (last 10)',
      desc: 'Bets whichever side won more of the last 10 hands.',
      pick(h) {
        const n = noTies(h).slice(-10); if (n.length < 4) return null;
        const b = n.filter(x => x === 'B').length, p = n.length - b;
        return b === p ? n[n.length - 1] : b > p ? 'B' : 'P';
      },
    },
    minority: {
      name: 'Due side (last 10)',
      desc: 'Bets the side that won fewer of the last 10 hands.',
      pick(h) {
        const n = noTies(h).slice(-10); if (n.length < 4) return null;
        const b = n.filter(x => x === 'B').length, p = n.length - b;
        return b === p ? opp(n[n.length - 1]) : b > p ? 'P' : 'B';
      },
    },
    pattern: {
      name: 'Big Road column pattern',
      desc: 'If the last two columns have equal length (1-1, 2-2, 3-3), bets the current column repeats that length.',
      pick(h) {
        const c = bigRoadCols(h); if (c.length < 3) return null;
        const cur = c[c.length - 1], prev = c[c.length - 2], prev2 = c[c.length - 3];
        if (prev.len === prev2.len) return cur.len < prev.len ? cur.side : opp(cur.side);
        return cur.side;
      },
    },
    banker: {
      name: 'Always Banker',
      desc: 'Flat-bets Banker every hand. The lowest house edge.',
      pick() { return 'B'; },
    },
  };

  function backtest(strategyKey, seq, opts = {}) {
    const s = STRATEGIES[strategyKey];
    let bets = 0, wins = 0, losses = 0, pushes = 0, net = 0;
    for (let i = 0; i < seq.length; i++) {
      const pick = s.pick(seq.slice(0, i));
      if (!pick) continue;
      bets++;
      const u = payout(pick, seq[i], opts.commission);
      net += u;
      if (u > 0) wins++; else if (u < 0) losses++; else pushes++;
    }
    return { bets, wins, losses, pushes, net };
  }

  function simulateStrategies(numShoes, seed, opts = {}) {
    const rng = mulberry32(seed >>> 0);
    const keys = Object.keys(STRATEGIES);
    const agg = {};
    keys.forEach(k => (agg[k] = { bets: 0, wins: 0, losses: 0, pushes: 0, net: 0, shoeNets: [] }));
    const counts = { B: 0, P: 0, T: 0, hands: 0 };
    for (let s = 0; s < numShoes; s++) {
      const seq = dealShoe(rng, opts.decks || 8);
      for (const r of seq) { counts[r]++; counts.hands++; }
      for (const k of keys) {
        const r = backtest(k, seq, opts);
        const a = agg[k];
        a.bets += r.bets; a.wins += r.wins; a.losses += r.losses; a.pushes += r.pushes; a.net += r.net;
        a.shoeNets.push(r.net);
      }
    }
    return { agg, counts, numShoes };
  }

  // Given the last k results (ties dropped), how often did each outcome come next in simulated shoes?
  function conditionalNext(history, numShoes, seed, k = 3) {
    const rng = mulberry32(seed >>> 0);
    const tail = noTies(history).slice(-k).join('');
    const res = { B: 0, P: 0, T: 0, n: 0, tail };
    if (tail.length < k) return res;
    for (let s = 0; s < numShoes; s++) {
      const seq = dealShoe(rng);
      let win = '';
      for (const r of seq) {
        if (win === tail) { res[r]++; res.n++; }
        if (r !== 'T') win = (win + r).slice(-k);
      }
    }
    return res;
  }

  // ---------- Cards and shoe composition ----------
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  function rankValue(r) {
    if (r === 'A') return 1;
    const n = parseInt(r, 10);
    return n >= 2 && n <= 9 ? n : 0;
  }
  // counts[v] = cards of baccarat value v (0 = 10/J/Q/K) in a full shoe
  function fullCounts(decks = 8) {
    const c = new Array(10).fill(4 * decks);
    c[0] = 16 * decks;
    return c;
  }

  // Monte Carlo odds of the next hand drawn from the remaining cards.
  function probsFromCounts(counts, samples = 60000, rng = Math.random) {
    const total0 = counts.reduce((a, b) => a + b, 0);
    if (total0 < 6) return null;
    const taken = new Int32Array(10), used = new Int32Array(6);
    let k = 0, total = total0;
    const draw = () => {
      let r = Math.floor(rng() * total), v = 0;
      for (; v < 9; v++) { const left = counts[v] - taken[v]; if (r < left) break; r -= left; }
      taken[v]++; used[k++] = v; total--;
      return v;
    };
    let nb = 0, np = 0, nt = 0;
    for (let s = 0; s < samples; s++) {
      k = 0; total = total0;
      const res = resolve(draw);
      for (let j = 0; j < k; j++) taken[used[j]]--;
      if (res === 'B') nb++; else if (res === 'P') np++; else nt++;
    }
    return { B: nb / samples, P: np / samples, T: nt / samples };
  }

  // Check a fully dealt hand against the drawing rules. pv/bv = card values in any order.
  // Returns the winner if some ordering is legal, else null.
  function validateHand(pv, bv) {
    if (pv.length < 2 || pv.length > 3 || bv.length < 2 || bv.length > 3) return null;
    const pick3 = arr => arr.length === 2 ? [[arr, -1]] : arr.map((c, i) => [arr.filter((_, j) => j !== i), c]);
    for (const [p2, p3] of pick3(pv)) {
      for (const [b2, b3] of pick3(bv)) {
        const p = (p2[0] + p2[1]) % 10, b = (b2[0] + b2[1]) % 10;
        if (p >= 8 || b >= 8) { if (p3 !== -1 || b3 !== -1) continue; return b > p ? 'B' : p > b ? 'P' : 'T'; }
        if ((p <= 5) !== (p3 !== -1)) continue;
        if (bankerDraws(b, p3) !== (b3 !== -1)) continue;
        const pf = (p + (p3 === -1 ? 0 : p3)) % 10, bf = (b + (b3 === -1 ? 0 : b3)) % 10;
        return bf > pf ? 'B' : pf > bf ? 'P' : 'T';
      }
    }
    return null;
  }

  // ---------- Derived roads (Big Eye Boy k=1, Small Road k=2, Cockroach Pig k=3) ----------
  // Standard rules on Big Road columns (ties ignored). 'R' = red (pattern repeats), 'B' = blue (pattern breaks).
  function derivedRoad(h, k) {
    const cols = bigRoadCols(h), out = [];
    for (let c = 0; c < cols.length; c++) {
      for (let r = 0; r < cols[c].len; r++) {
        if (r === 0) {
          if (c - 1 - k >= 0) out.push(cols[c - 1].len === cols[c - 1 - k].len ? 'R' : 'B');
        } else if (c - k >= 0) {
          const L = cols[c - k].len;
          out.push(L === r ? 'B' : 'R');
        }
      }
    }
    return out;
  }
  // What each derived road would add if the next result is x (null when that road adds nothing yet).
  function derivedAsk(h, x) {
    return [1, 2, 3].map(k => {
      const a = derivedRoad(h, k), b = derivedRoad(h.concat([x]), k);
      return b.length > a.length ? b[b.length - 1] : null;
    });
  }

  // How streaks and ping-pong runs behave in real shoes: chance a run of length k continues,
  // and how many shoes contain long runs at all.
  function runStats(numShoes, seed) {
    const rng = mulberry32(seed >>> 0);
    const cont = [], chop = [];
    let s6 = 0, s8 = 0, c6 = 0, c10 = 0;
    for (let s = 0; s < numShoes; s++) {
      const n = dealShoe(rng).filter(x => x !== 'T');
      let run = 1, alt = 1, maxRun = 1, maxAlt = 1;
      for (let i = 1; i < n.length; i++) {
        const k = Math.min(run, 12), a = Math.min(alt, 12);
        (cont[k] = cont[k] || [0, 0])[1]++; if (n[i] === n[i - 1]) cont[k][0]++;
        (chop[a] = chop[a] || [0, 0])[1]++; if (n[i] !== n[i - 1]) chop[a][0]++;
        if (n[i] === n[i - 1]) { run++; alt = 1; } else { run = 1; alt++; }
        maxRun = Math.max(maxRun, run); maxAlt = Math.max(maxAlt, alt);
      }
      if (maxRun >= 6) s6++; if (maxRun >= 8) s8++; if (maxAlt >= 6) c6++; if (maxAlt >= 10) c10++;
    }
    const rate = arr => arr.map(v => (v ? v[0] / v[1] : null));
    return { streakContinue: rate(cont), chopContinue: rate(chop), shoes: numShoes,
      share: { streak6: s6 / numShoes, streak8: s8 / numShoes, chop6: c6 / numShoes, chop10: c10 / numShoes } };
  }

  // Current streak / ping-pong and the longest of each so far (ties ignored).
  function runsNow(h) {
    const n = noTies(h);
    let run = n.length ? 1 : 0, alt = n.length ? 1 : 0, maxRun = run, maxRunSide = n[0] || null, maxAlt = alt;
    for (let i = 1; i < n.length; i++) {
      if (n[i] === n[i - 1]) { run++; alt = 1; } else { run = 1; alt++; }
      if (run > maxRun) { maxRun = run; maxRunSide = n[i]; }
      maxAlt = Math.max(maxAlt, alt);
    }
    return { side: n[n.length - 1] || null, run, alt, maxRun, maxRunSide, maxAlt };
  }

  // What a roadmap player would bet: ride a streak, follow a ping-pong, repeat a column pattern,
  // or follow the derived roads. Returns { side, reason } (side null when the roadmap is too short).
  function roadmapPick(h) {
    const n = noTies(h);
    if (n.length < 2) return { side: null, reason: 'Not enough results yet' };
    const r = runsNow(h), last = n[n.length - 1], other = last === 'B' ? 'P' : 'B';
    const name = s => (s === 'B' ? 'Banker' : 'Player');
    if (r.run >= 3) return { side: last, reason: `${name(last)} streak of ${r.run}: ride the streak` };
    if (r.alt >= 3) return { side: other, reason: `Ping-pong of ${r.alt}: follow the chop` };
    const col = STRATEGIES.pattern.pick(h);
    const cols = bigRoadCols(h);
    if (col && cols.length >= 3 && cols[cols.length - 2].len === cols[cols.length - 3].len)
      return { side: col, reason: `Big Road columns repeat (${cols[cols.length - 3].len}-${cols[cols.length - 2].len}): follow the pattern` };
    const reds = x => derivedAsk(h, x).filter(v => v === 'R').length;
    const rb = reds('B'), rp = reds('P');
    if (rb !== rp) return { side: rb > rp ? 'B' : 'P', reason: `Derived roads stay red if ${name(rb > rp ? 'B' : 'P')} wins` };
    return { side: last, reason: `No clear pattern: follow the last winner` };
  }

  root.Baccarat = { roadmapPick, runStats, runsNow, derivedRoad, derivedAsk, RANKS, rankValue, fullCounts, probsFromCounts, validateHand, resolve, bankerDraws, mulberry32, newShoe, playHand, dealShoe, payout, STRATEGIES, backtest,
    simulateStrategies, conditionalNext, bigRoadCols, streakLen, noTies };
  if (typeof module !== 'undefined') module.exports = root.Baccarat;
})(typeof window !== 'undefined' ? window : globalThis);
