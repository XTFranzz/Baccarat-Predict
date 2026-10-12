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
  // onCard('P'|'B', value) is told every card as it is dealt, so a simulated shoe can be recorded
  // hand by hand without a second copy of the drawing rules drifting out of step with this one.
  function resolve(draw, onCard) {
    const take = who => { const v = draw(); if (onCard) onCard(who, v); return v; };
    const p1 = take('P'), b1 = take('B'), p2 = take('P'), b2 = take('B');
    let p = (p1 + p2) % 10, b = (b1 + b2) % 10;
    if (p < 8 && b < 8) {
      let p3 = -1;
      if (p <= 5) { p3 = take('P'); p = (p + p3) % 10; }
      if (bankerDraws(b, p3)) b = (b + take('B')) % 10;
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

  // Deal a whole shoe, keeping each hand's cards: the same shoe a live table would produce, written
  // in the form the app logs. Ranks worth zero are all recorded as "10", which counts identically.
  function dealShoeHands(rng, decks = 8, cutFromEnd = 14) {
    const shoe = newShoe(decks, rng);
    let pos = 0;
    const burn = shoe[pos++] || 10; pos += burn;
    const name = v => (v === 0 ? '10' : v === 1 ? 'A' : String(v));
    const out = [];
    while (pos < shoe.length - cutFromEnd - 6) {
      const hand = { P: [], B: [] };
      hand.result = resolve(() => shoe[pos++], (who, v) => hand[who].push(name(v)));
      out.push(hand);
    }
    return out;
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

  // Exact odds for the next hand, enumerating draws without replacement from the known shoe.
  function probsFromCounts(counts) {
    if (!Array.isArray(counts) || counts.length !== 10 ||
        counts.some(n => !Number.isInteger(n) || n < 0)) return null;
    const total0 = counts.reduce((a, b) => a + b, 0);
    if (total0 < 6) return null;
    const left = counts.slice(), odds = { B: 0, P: 0, T: 0 };
    const addResult = (p, b, weight) => {
      odds[b > p ? 'B' : p > b ? 'P' : 'T'] += weight;
    };
    const drawThird = (bankerTotal, playerTotal, playerThird, weight, remaining) => {
      if (!bankerDraws(bankerTotal, playerThird)) {
        addResult(playerTotal, bankerTotal, weight);
        return;
      }
      for (let v = 0; v < 10; v++) {
        if (!left[v]) continue;
        const chance = weight * left[v] / remaining;
        left[v]--;
        addResult(playerTotal, (bankerTotal + v) % 10, chance);
        left[v]++;
      }
    };
    const afterInitial = (p1, b1, p2, b2, weight, remaining) => {
      const player = (p1 + p2) % 10, banker = (b1 + b2) % 10;
      if (player >= 8 || banker >= 8) {
        addResult(player, banker, weight);
      } else if (player <= 5) {
        for (let v = 0; v < 10; v++) {
          if (!left[v]) continue;
          const chance = weight * left[v] / remaining;
          left[v]--;
          drawThird(banker, (player + v) % 10, v, chance, remaining - 1);
          left[v]++;
        }
      } else {
        drawThird(banker, player, -1, weight, remaining);
      }
    };
    const initial = (depth, cards, weight, remaining) => {
      if (depth === 4) {
        afterInitial(cards[0], cards[1], cards[2], cards[3], weight, remaining);
        return;
      }
      for (let v = 0; v < 10; v++) {
        if (!left[v]) continue;
        const chance = weight * left[v] / remaining;
        left[v]--;
        cards[depth] = v;
        initial(depth + 1, cards, chance, remaining - 1);
        left[v]++;
      }
    };
    initial(0, new Array(4), 1, total0);
    return odds;
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
  // Every pattern a roadmap player looks for, found generally rather than from a fixed list:
  //  - column cycles: the Big Road column lengths repeat with any period of 1-6 columns
  //    (3P 3B, 4B 4P, 4B 1P, 2B 1P 3B 1P ...),
  //  - result cycles: the results themselves repeat with any period of 2-8 hands (BBP BBP, BPPB BPPB ...),
  //  - staircases: each column one longer (1-2-3-4) or one shorter (4-3-2) than the one before.
  // A cycle counts once it has repeated at least twice. Candidates are ranked by how much history they
  // match; the best one is returned with the side it calls next.
  function findPatterns(h) {
    const n = noTies(h), cols = bigRoadCols(h), out = [];
    if (cols.length >= 2) {
      const done = cols.slice(0, -1), cur = cols[cols.length - 1];
      const opp = s => (s === 'B' ? 'P' : 'B');
      // column cycles
      for (let p = 1; p <= 6; p++) {
        if (done.length < 2 * p) continue;
        let k = 0;
        for (let i = done.length - 1; i - p >= 0 && done[i].len === done[i - p].len; i--) k++;
        if (k < p) continue;
        const expected = done[done.length - p].len;
        const shape = (p === 1 ? done.slice(-2) : done.slice(-p)).map(c => c.len + c.side).join(' ');
        out.push({ kind: 'columns', period: p, support: k + p, repeats: Math.floor((k + p) / p), shape, expected, current: cur.len,
          broke: cur.len > expected, side: cur.len < expected ? cur.side : opp(cur.side) });
      }
      // staircases over the last 3+ completed columns
      for (const step of [1, -1]) {
        let k = 0;
        for (let i = done.length - 1; i >= 1 && done[i].len - done[i - 1].len === step; i--) k++;
        if (k >= 2) {
          const expected = done[done.length - 1].len + step;
          if (expected >= 1) out.push({ kind: 'staircase', support: k + 1, repeats: k + 1,
            shape: done.slice(-(k + 1)).map(c => c.len).join('-') + (step > 0 ? ' (growing)' : ' (shrinking)'),
            expected, current: cur.len, broke: cur.len > expected, side: cur.len < expected ? cur.side : opp(cur.side) });
        }
      }
    }
    // result cycles (period 2-8), read hand by hand
    for (let q = 2; q <= 8; q++) {
      if (n.length < 2 * q) continue;
      let k = 0;
      for (let i = n.length - 1; i - q >= 0 && n[i] === n[i - q]; i--) k++;
      if (k < q) continue;
      const block = n.slice(-q);
      if (block.every(x => x === block[0])) continue;   // one side only = a streak, handled by the streak rules
      out.push({ kind: 'results', period: q, support: k + q, repeats: Math.floor((k + q) / q), shape: n.slice(-q).join(''),
        side: n[n.length - q], broke: false });
    }
    // strongest first: repeated most often; on a tie column patterns before staircases before result cycles,
    // then the shorter (simpler) pattern
    const rank = { columns: 0, staircase: 1, results: 2 };
    out.sort((a, b) => b.repeats - a.repeats || rank[a.kind] - rank[b.kind] || (a.period || 0) - (b.period || 0));
    return out;
  }
  function columnPattern(h) {
    const all = findPatterns(h).filter(x => x.kind !== 'results');
    return all.find(x => !x.broke) || all[0] || null;
  }

  // What a roadmap player would bet: ride a streak, follow a ping-pong, repeat a column pattern,
  // or follow the derived roads. Returns { side, reason } (side null when the roadmap is too short).
  // Repeating column shapes on the Big Road: equal columns (3P 3B 3P, 4B 4P 4B), two-column cycles
  // (4B 1P 4B 1P, 2B 1P 2B 1P) and three-column cycles. A pattern counts once it has repeated at least
  // twice; the strongest (longest matching) one wins. Returns the expected length of the current column.
  function columnPattern(h) {
    const cols = bigRoadCols(h);
    if (cols.length < 3) return null;
    const done = cols.slice(0, -1), cur = cols[cols.length - 1];
    let best = null;
    for (let p = 1; p <= 3; p++) {
      if (done.length < 2 * p) continue;
      let k = 0;
      for (let i = done.length - 1; i - p >= 0 && done[i].len === done[i - p].len; i--) k++;
      if (k < p) continue;                     // needs two full cycles
      if (!best || k > best.k) best = { p, k };
    }
    if (!best) return null;
    const period = done.slice(done.length - best.p);
    const shape = best.p === 1 ? `${period[0].len}${done[done.length - 2].side} ${period[0].len}${period[0].side}`
      : period.map(c => c.len + c.side).join(' ');
    const expected = done[done.length - best.p].len;
    return { period: best.p, repeats: Math.floor((best.k + best.p) / best.p), shape, expected, current: cur.len, side: cur.side, broke: cur.len > expected };
  }

  // What a roadmap player would bet: follow a repeating column pattern, expect a streak to stop where this
  // shoe's streaks stop, ride a streak, follow a ping-pong, or follow the derived roads.
  // Returns { side, reason, pattern } (side null when the roadmap is too short).
  function roadmapPick(h) {
    const n = noTies(h);
    if (n.length < 2) return { side: null, reason: 'Not enough results yet' };
    const r = runsNow(h), last = n[n.length - 1], other = last === 'B' ? 'P' : 'B';
    const name = s => (s === 'B' ? 'Banker' : 'Player');
    const opp = s => (s === 'B' ? 'P' : 'B');
    const all = findPatterns(h);
    const live = all.filter(x => !x.broke), broken = all.find(x => x.broke && x.kind !== 'results');
    const pat = live[0] || null;
    let note = '';
    if (pat) {
      const cur = bigRoadCols(h).slice(-1)[0];
      if (pat.kind === 'results')
        return { side: pat.side, pattern: pat, reason: `Pattern ${pat.shape} repeating (seen ${pat.repeats} times): next in the cycle is ${name(pat.side)}` };
      const label = pat.kind === 'staircase' ? `Staircase ${pat.shape}` : `Pattern ${pat.shape} (seen ${pat.repeats} times)`;
      return pat.current < pat.expected
        ? { side: pat.side, pattern: pat, reason: `${label}: this ${name(cur.side)} column should reach ${pat.expected}, now ${pat.current}, so continue` }
        : { side: pat.side, pattern: pat, reason: `${label}: this ${name(cur.side)} column has reached ${pat.expected}, so switch` };
    }
    if (broken) note = `The ${broken.shape} pattern broke (column reached ${broken.current}, expected ${broken.expected}). `;
    // This shoe's streak limit: completed streaks keep stopping at the same length.
    const cols = bigRoadCols(h), done = cols.slice(0, -1);
    const maxRun = done.reduce((m, c) => Math.max(m, c.len), 0);
    if (done.length >= 4 && maxRun >= 3 && r.run >= maxRun)
      return { side: other, pattern: pat, reason: `${note}Streaks this shoe have stopped by ${maxRun}; this ${name(last)} streak is at ${r.run}, so expect a break` };
    if (r.run >= 3) return { side: last, pattern: pat, reason: `${note}${name(last)} streak of ${r.run}: ride the streak` };
    if (r.alt >= 3) return { side: other, pattern: pat, reason: `${note}Ping-pong of ${r.alt}: follow the chop` };
    const reds = x => derivedAsk(h, x).filter(v => v === 'R').length;
    const rb = reds('B'), rp = reds('P');
    if (rb !== rp) return { side: rb > rp ? 'B' : 'P', pattern: pat, reason: `${note}Derived roads stay red if ${name(rb > rp ? 'B' : 'P')} wins` };
    return { side: last, pattern: pat, reason: `${note}No clear pattern: follow the last winner` };
  }

  root.Baccarat = { findPatterns, columnPattern, roadmapPick, runStats, runsNow, derivedRoad, derivedAsk, RANKS, rankValue, fullCounts, probsFromCounts, validateHand, resolve, bankerDraws, mulberry32, newShoe, playHand, dealShoe, dealShoeHands, payout, STRATEGIES, backtest,
    simulateStrategies, conditionalNext, bigRoadCols, streakLen, noTies };
  if (typeof module !== 'undefined') module.exports = root.Baccarat;
})(typeof window !== 'undefined' ? window : globalThis);
