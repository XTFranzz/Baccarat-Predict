// Computer vision for baccarat tables.
//  - readRoad:     read a cropped roadmap image into a B/P/T sequence
//  - findRoad:     locate the Bead Plate / Big Road on a full page capture
//  - readRoadLive: re-read a located road every scan (it grows to the right)
//  - findCards:    locate the dealt cards (white card faces) and split Player / Banker
//  - readCard:     read the rank symbol in a card corner by template matching
// Red = Banker, Blue = Player, Green = Tie.
(function (root) {
  'use strict';

  // Colour by hue, so the darker, lighter and pastel shades different sites use still count.
  // The hue decides which colour (orange / skin tones are not red); a pixel counts if it is clearly
  // saturated, or if it passes the original rule that keeps pale anti-aliased ring edges.
  function classify(r, g, b) {
    const max = Math.max(r, g, b), min = Math.min(r, g, b), c = max - min;
    if (c < 20) return 0;
    let hue;
    if (max === r) hue = 60 * (((g - b) / c) % 6);
    else if (max === g) hue = 60 * ((b - r) / c + 2);
    else hue = 60 * ((r - g) / c + 4);
    if (hue < 0) hue += 360;
    const band = hue <= 12 || hue >= 335 ? 1 : hue >= 195 && hue <= 260 ? 2 : hue >= 85 && hue <= 170 ? 3 : 0;
    if (!band) return 0;
    const strong = max >= 90 && c >= 45 && c / max >= 0.38;
    const pale = band === 1 ? r > 130 && r - g > 60 && r - b > 50
      : band === 2 ? b > 130 && b - r > 50 && b - g > 20
      : g > 110 && g - r > 40 && g - b > 20;
    return strong || pale ? band : 0;
  }

  // 4-connected components on a label map. With wantIds, also returns a per-pixel component id map.
  function components(labels, w, h, wantIds) {
    const ids = new Int32Array(w * h).fill(-1);
    const out = [];
    const stack = [];
    for (let i = 0; i < w * h; i++) {
      const lab = labels[i];
      if (!lab || ids[i] !== -1) continue;
      const id = out.length;
      let minX = w, minY = h, maxX = 0, maxY = 0, area = 0, sx = 0, sy = 0;
      stack.push(i); ids[i] = id;
      while (stack.length) {
        const j = stack.pop();
        const x = j % w, y = (j - x) / w;
        area++; sx += x; sy += y;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (x > 0 && ids[j - 1] === -1 && labels[j - 1] === lab) { ids[j - 1] = id; stack.push(j - 1); }
        if (x < w - 1 && ids[j + 1] === -1 && labels[j + 1] === lab) { ids[j + 1] = id; stack.push(j + 1); }
        if (y > 0 && ids[j - w] === -1 && labels[j - w] === lab) { ids[j - w] = id; stack.push(j - w); }
        if (y < h - 1 && ids[j + w] === -1 && labels[j + w] === lab) { ids[j + w] = id; stack.push(j + w); }
      }
      out.push({ id, lab, area, cx: sx / area, cy: sy / area, minX, minY, maxX, maxY,
        w: maxX - minX + 1, h: maxY - minY + 1 });
    }
    return wantIds ? { blobs: out, ids } : out;
  }

  function median(a) {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)];
  }

  // Autocorrelation of a profile after removing its slow trend (so empty areas don't dominate).
  function autocorr(profile, lo, hi, win) {
    const n = profile.length, d = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - win); j <= Math.min(n - 1, i + win); j++) { s += profile[j]; c++; }
      d[i] = profile[i] - s / c;
    }
    let e = 0; for (let i = 0; i < n; i++) e += d[i] * d[i];
    const ac = {};
    for (let lag = lo; lag <= hi; lag++) {
      let sum = 0; for (let i = 0; i + lag < n; i++) sum += d[i] * d[i + lag];
      ac[lag] = e ? sum / e * n / Math.max(1, n - lag) : 0;
    }
    return ac;
  }

  // Fallback cell spacing: strongest repeat near the mark diameter.
  function estimatePitch(colProfile, rowProfile, diam) {
    const lo = Math.max(2, Math.floor(diam * 0.85)), hi = Math.ceil(diam * 1.9) + 1;
    const win = Math.max(3, Math.round(diam * 2));
    const ax = autocorr(colProfile, lo, hi, win), ay = autocorr(rowProfile, lo, hi, win);
    const score = l => (ax[l] || 0) + 0.5 * (ay[l] || 0);
    let best = 0, bestV = -Infinity;
    for (let l = lo; l <= hi; l++) if (score(l) > bestV) { bestV = score(l); best = l; }
    if (bestV <= 0) return diam * 1.15;
    const a = score(best - 1), b = score(best), c = score(best + 1);
    const den = a - 2 * b + c;
    return best > lo && best < hi && den < 0 ? best + 0.5 * (a - c) / den : best;
  }

  // Grid offset: circular mean of positions modulo pitch, weighted by blob area.
  function phase(blobs, key, pitch) {
    let sx = 0, sy = 0;
    for (const b of blobs) { const t = (b[key] / pitch) * 2 * Math.PI; sx += Math.cos(t) * b.area; sy += Math.sin(t) * b.area; }
    let ph = Math.atan2(sy, sx) / (2 * Math.PI) * pitch;
    if (ph < 0) ph += pitch;
    return ph;
  }

  // How well centres line up on a grid of this pitch (0..2: x and y summed).
  function alignment(blobs, p) {
    let xc = 0, xs = 0, yc = 0, ys = 0;
    for (const b of blobs) {
      const tx = b.cx / p * 2 * Math.PI, ty = b.cy / p * 2 * Math.PI;
      xc += Math.cos(tx); xs += Math.sin(tx); yc += Math.cos(ty); ys += Math.sin(ty);
    }
    return (Math.hypot(xc, xs) + Math.hypot(yc, ys)) / Math.max(1, blobs.length);
  }

  function nnPitch(singles, diam) {
    const nn = singles.map(a => {
      let best = Infinity;
      for (const b of singles) if (b !== a) best = Math.min(best, Math.hypot(a.cx - b.cx, a.cy - b.cy));
      return best;
    }).filter(d => d >= diam * 0.8 && d <= diam * 2.5);
    return median(nn);
  }

  function labelImage(img, rect) {
    const { data, width: W } = img;
    const x0 = rect ? Math.max(0, Math.floor(rect.x)) : 0, y0 = rect ? Math.max(0, Math.floor(rect.y)) : 0;
    const w = rect ? Math.max(0, Math.min(img.width - x0, Math.ceil(rect.width))) : img.width;
    const h = rect ? Math.max(0, Math.min(img.height - y0, Math.ceil(rect.height))) : img.height;
    const labels = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      let p = ((y0 + y) * W + x0) * 4, i = y * w;
      for (let x = 0; x < w; x++, p += 4, i++) {
        if (data[p + 3] < 128) continue;
        labels[i] = classify(data[p], data[p + 1], data[p + 2]);
      }
    }
    return { labels, w, h, x0, y0 };
  }

  // Grid-based reading of labelled marks: every coloured pixel votes for its cell; cells read column by column.
  let TIE_FRAC = 0.05; // tested on real Big Road screenshots: no false ties down to 0.015
  function gridRead(labels, w, h, blobs, pitchHint, phaseHint, diamHint) {
    blobs = blobs.filter(b => b.area >= 2);
    if (!blobs.length) return { seq: [], marks: [], pitch: pitchHint || 0, note: 'no red, blue or green marks found' };

    const big = blobs.filter(b => b.area >= 4);
    const diam = median((big.length ? big : blobs).map(b => Math.min(b.w, b.h))) || 4;
    const singles = blobs.filter(b => b.w <= diam * 1.35 && b.h <= diam * 1.35 && b.w >= diam * 0.7 && b.h >= diam * 0.7);
    const typArea = median(singles.map(b => b.area)) || diam * diam * 0.5;

    let pitch = pitchHint || 0;
    if (!pitch && singles.length >= 3) pitch = nnPitch(singles, diam);
    if (!pitch) {
      const colProfile = new Float64Array(w), rowProfile = new Float64Array(h);
      for (let i = 0; i < w * h; i++) if (labels[i]) { colProfile[i % w]++; rowProfile[(i / w) | 0]++; }
      pitch = estimatePitch(colProfile, rowProfile, diam);
    }
    // Whole marks (not pieces of a mark split by its letter) are what the grid is measured from.
    const wholes = diamHint ? blobs.filter(b => Math.min(b.w, b.h) >= diamHint * 0.75 && Math.max(b.w, b.h) <= diamHint * 1.35) : singles;
    // Refine the spacing. A spacing measured earlier from whole marks (pitchHint) is trusted and only nudged.
    if (wholes.length >= 4) {
      const span = 0.15;
      let best = pitch, bv = alignment(wholes, pitch);
      for (let p = pitch * (1 - span); p <= pitch * (1 + span); p += pitch * 0.002) { const v = alignment(wholes, p); if (v > bv) { bv = v; best = p; } }
      pitch = best;
    }

    const ref = wholes.length ? wholes : singles.length ? singles : blobs;
    // Measure the grid offset from whole marks; with too few of them, use the road's known first cell.
    const usePhase = phaseHint && wholes.length < 6;
    const x0 = usePhase ? ((phaseHint.x % pitch) + pitch) % pitch : phase(ref, 'cx', pitch);
    const y0 = usePhase ? ((phaseHint.y % pitch) + pitch) % pitch : phase(ref, 'cy', pitch);
    const cells = new Map();
    for (let i = 0; i < w * h; i++) {
      const lab = labels[i]; if (!lab) continue;
      const x = i % w, y = (i - x) / w;
      const col = Math.round((x - x0) / pitch), row = Math.round((y - y0) / pitch);
      const key = col * 100000 + row;
      let c = cells.get(key);
      if (!c) { c = { col, row, area: [0, 0, 0, 0], minX: x, minY: y, maxX: x, maxY: y }; cells.set(key, c); }
      c.area[lab]++;
      if (x < c.minX) c.minX = x; if (x > c.maxX) c.maxX = x;
      if (y < c.minY) c.minY = y; if (y > c.maxY) c.maxY = y;
    }
    const real = [...cells.values()].filter(c => c.area[1] + c.area[2] + c.area[3] >= typArea * 0.3);
    real.sort((a, b) => a.col - b.col || a.row - b.row);

    const seq = [], marks = [];
    for (const c of real) {
      const rb = c.area[1] + c.area[2];
      const side = rb >= typArea * 0.3 ? (c.area[1] >= c.area[2] ? 'B' : 'P') : 'T';
      seq.push(side);
      // a green slash drawn over a Big Road circle is a tie after that hand
      // A green Tie line drawn through a Big Road circle: a thin line, so a small share of the mark is enough.
      const tie = side !== 'T' && c.area[3] >= Math.max(3, typArea * TIE_FRAC);
      if (tie) seq.push('T');
      marks.push({ side, col: c.col, row: c.row, tie,
        cx: (c.minX + c.maxX) / 2, minX: c.minX, minY: c.minY, maxX: c.maxX, maxY: c.maxY,
        w: c.maxX - c.minX + 1, h: c.maxY - c.minY + 1 });
    }
    const ncols = new Set(real.map(c => c.col)).size;
    return { seq, marks, pitch, note: `${marks.length} marks in ${ncols} columns, cell ${pitch.toFixed(1)}px` };
  }

  // Read a cropped roadmap image (one road only).
  function readRoad(imageData) {
    const { labels, w, h } = labelImage(imageData);
    return gridRead(labels, w, h, components(labels, w, h));
  }

  // ---------------- Roadmap auto-detection ----------------
  // Finds groups of same-size round marks laid out on a grid. Prefers the largest marks
  // (Bead Plate / Big Road; derived roads use half-size marks) and filled marks (Bead Plate).
  function findRoad(img, debug, all) {
    const { labels, w, h } = labelImage(img);
    const blobs = components(labels, w, h);
    const marks = blobs.filter(b => b.lab !== 3 && b.area >= 7 && b.w >= 4 && b.h >= 4 &&
      b.w / b.h > 0.75 && b.w / b.h < 1.33 && Math.max(b.w, b.h) <= 80);
    for (const b of marks) { b.d = Math.max(b.w, b.h); b.fill = b.area / (b.w * b.h); }
    marks.sort((a, b) => a.cx - b.cx);
    const parent = marks.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < marks.length; i++) {
      const a = marks[i];
      for (let j = i + 1; j < marks.length; j++) {
        const b = marks[j];
        if (b.cx - a.cx > 2.8 * 80) break;
        const reach = 2.8 * Math.max(a.d, b.d);
        if (b.cx - a.cx > reach) continue;
        if (b.d / a.d < 0.8 || b.d / a.d > 1.25 || Math.abs(a.fill - b.fill) > 0.2) continue;
        if (Math.hypot(a.cx - b.cx, a.cy - b.cy) <= reach) parent[find(i)] = find(j);
      }
    }
    const groups = new Map();
    marks.forEach((m, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(m); });

    const roads = [];
    for (const g of groups.values()) {
      if (g.length < 5) continue;
      const d = median(g.map(b => b.d));
      const fills = g.map(b => b.fill), fill = median(fills);
      const fillStd = Math.sqrt(fills.reduce((s, f) => s + (f - fill) ** 2, 0) / fills.length);
      const pitch = nnPitch(g, d * 0.9) || d * 1.15;
      const align = alignment(g, pitch) / 2;
      const rows = new Set(g.map(b => Math.round(b.cy / pitch))).size;
      if (debug) debug.push({ n: g.length, d: +d.toFixed(1), fill: +fill.toFixed(2), fillStd: +fillStd.toFixed(3), pitch: +pitch.toFixed(1), align: +align.toFixed(2), rows, x: Math.min(...g.map(b => b.minX)), y: Math.min(...g.map(b => b.minY)) });
      if (align < 0.55 || fillStd > 0.15) continue;
      roads.push({
        x0: Math.min(...g.map(b => b.minX)), y0: Math.min(...g.map(b => b.minY)),
        x1: Math.max(...g.map(b => b.maxX)), y1: Math.max(...g.map(b => b.maxY)),
        d, fill, pitch, align, count: g.length, rows,
        kind: roadKind(g, pitch, fill),
      });
    }
    if (!roads.length) return null;
    const maxD = Math.max(...roads.map(r => r.d));
    const cand = roads.filter(r => r.d >= 0.7 * maxD);
    const score = r => r.count * (0.4 + r.fill) * r.align * (r.rows > 1 ? 1.5 : 1);
    cand.sort((a, b) => score(b) - score(a));
    roads.forEach(r => { r.imgW = img.width; r.imgH = img.height; });
    if (all) return cand.concat(roads.filter(r => !cand.includes(r)));
    return cand[0];
  }

  // Bead Plate vs Big Road by layout, which survives small sizes better than mark shape:
  // Bead Plate columns are filled top to bottom with mixed results; Big Road columns hold one side each.
  function roadKind(g, pitch, fill) {
    const x0 = Math.min(...g.map(b => b.cx)), y0 = Math.min(...g.map(b => b.cy));
    const cols = new Map();
    for (const b of g) {
      const c = Math.round((b.cx - x0) / pitch);
      if (!cols.has(c)) cols.set(c, new Set());
      cols.get(c).add(b.lab);
    }
    const multi = [...cols.values()].filter(s => s.size > 1).length;
    if (cols.size >= 3) return multi / cols.size >= 0.3 ? 'Bead Plate' : 'Big Road';
    return fill > 0.55 ? 'Bead Plate' : 'Big Road';
  }

  // Re-read a located road. The road grows to the right, so it follows the chain of marks from its left edge.
  // fromLeft: the image is the user's box, so the road starts at its left edge (not where marks were first seen).
  function readRoadLive(img, sig, fromLeft) {
    const p = sig.pitch;
    const rx = fromLeft ? 0 : Math.max(0, sig.x0 - 1.5 * p);
    const rect = { x: rx, y: sig.y0 - 0.8 * p, width: img.width - rx, height: 6.6 * p };
    const { labels, w, h, x0, y0 } = labelImage(img, rect);
    const { blobs, ids } = components(labels, w, h, true);
    const leftEdge = sig.x0 - x0;
    const filled = sig.fill > 0.55; // Bead Plate: ties are full-size green circles, so they count as marks
    const marks = blobs.filter(b => {
      if (b.lab === 3 && !filled) return false;
      const short = Math.min(b.w, b.h), long = Math.max(b.w, b.h);
      if (short < sig.d * 0.6 || short > sig.d * 1.5 || long > sig.d * 7.5) return false;
      if (long <= sig.d * 1.4 && Math.abs(b.area / (b.w * b.h) - sig.fill) > 0.35) return false;
      return true;
    }).sort((a, b) => a.minX - b.minX);
    const keep = new Set();
    let right = -Infinity, left = Infinity, top = Infinity, bottom = -Infinity;
    for (const m of marks) {
      if (right === -Infinity) {
        if (!fromLeft && m.minX > leftEdge + 3 * p) break; // road is empty (e.g. after a shuffle)
      } else if (m.minX - right > 2.6 * p) break; // roads have no empty columns; allow one unclear mark
      keep.add(m.id); right = Math.max(right, m.maxX); left = Math.min(left, m.minX);
      top = Math.min(top, m.minY); bottom = Math.max(bottom, m.maxY);
    }
    if (fromLeft) {
      // Inside the user's box the whole width is the road: take every mark, so a circle broken by a tie line
      // (or anything else unusual) can never end the road early.
      const ms = blobs.filter(b => b.lab !== 3 && b.area >= 2 && b.cy >= sig.y0 - y0 - p * 0.5 && b.cy <= sig.y0 - y0 + p * 5.8);
      if (ms.length) { left = Math.min(...ms.map(b => b.minX)); right = Math.max(...ms.map(b => b.maxX));
        top = Math.min(...ms.map(b => b.minY)); bottom = Math.max(...ms.map(b => b.maxY)); ms.forEach(b => keep.add(b.id)); }
    }
    if (!keep.size) return { seq: [], marks: [], note: 'road is empty', box: null };
    // Clear marks found the road's extent; now count every coloured pixel inside it. Small marks split
    // into pieces by their white letters would otherwise be lost.
    const xa = Math.max(0, Math.floor(left - p * 0.5)), xb = Math.min(w - 1, Math.ceil(right + p * 0.5));
    const ya = Math.max(0, Math.floor(sig.y0 - y0 - p * 0.45)), yb = Math.min(h - 1, Math.ceil(sig.y0 - y0 + p * 5.75));
    const masked = new Uint8Array(w * h);
    const inside = new Set();
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
      const i = y * w + x;
      if (labels[i]) { masked[i] = labels[i]; inside.add(ids[i]); }
    }
    for (const id of inside) keep.add(id);
    // centre of the road's first cell, in this crop's coordinates
    const phaseHint = { x: sig.x0 + sig.d / 2 - x0, y: sig.y0 + sig.d / 2 - y0 };
    const res = gridRead(masked, w, h, blobs.filter(b => keep.has(b.id)), p, phaseHint, sig.d);
    if (sig.kind === 'Big Road') {
      for (const m of res.marks) {
        if (!m.tie) continue;
        // Look only at the middle of the circle, where the digit is drawn (edges hold the ring, pair dots, anti-aliasing).
        let dark = 0, n = 0;
        const mx = (m.maxX - m.minX) * 0.27, my = (m.maxY - m.minY) * 0.27;
        for (let y = Math.round(m.minY + my); y <= Math.round(m.maxY - my); y++) for (let x = Math.round(m.minX + mx); x <= Math.round(m.maxX - mx); x++) {
          const q = ((y + y0) * img.width + x + x0) * 4, r = img.data[q], g = img.data[q + 1], b = img.data[q + 2];
          n++;
          if (0.299 * r + 0.587 * g + 0.114 * b < 110 && Math.max(r, g, b) - Math.min(r, g, b) < 50) dark++;
        }
        if (n && dark >= Math.max(2, n * 0.06)) m.ties = 2; // the digit's dark outline; 3+ ties in a row are rare
      }
      res.seq = decodeBigRoad(res.marks);
    }
    res.marks.forEach(m => { m.minX += x0; m.maxX += x0; m.minY += y0; m.maxY += y0; m.cx += x0; });
    res.box = { x: x0 + left - p * 0.25, y: y0 + top - p * 0.25, width: right - left + p * 0.5, height: bottom - top + p * 0.5 };
    return res;
  }

  // Big Road order: a run goes down its column; a long run (dragon tail) turns right along its last row.
  // Reading column by column would mix tail marks into later runs, so follow each run instead.
  function decodeBigRoad(marks) {
    const at = new Map(), used = new Set();
    for (const m of marks) if (m.side !== 'T') at.set(m.col + ',' + m.row, m);
    const cols = [...new Set(marks.map(m => m.col))].sort((a, b) => a - b);
    const minRow = Math.min(...marks.map(m => m.row));
    const seq = [];
    // A Tie before the first result of the shoe is a green line in an otherwise empty first cell.
    for (const m of marks) if (m.side === 'T' && !at.has(m.col + ',' + m.row)) seq.push('T');
    const take = m => { used.add(m); seq.push(m.side); if (m.tie) for (let k = 0; k < (m.ties || 1); k++) seq.push('T'); };
    for (const c of cols) {
      const head = at.get(c + ',' + minRow);
      if (!head || used.has(head)) continue;
      let r = minRow, cc = c;
      take(head);
      for (;;) {
        const down = at.get(cc + ',' + (r + 1));
        if (down && !used.has(down) && down.side === head.side && cc === c) { take(down); r++; continue; }
        const right = at.get((cc + 1) + ',' + r);
        if (r > minRow && right && !used.has(right) && right.side === head.side) { take(right); cc++; continue; }
        break;
      }
    }
    // Marks that fit no run are fragments (a circle split across cells): adding them would invent results, so skip them.
    return seq;
  }

  // ---------------- Cards ----------------
  const isWhite = (r, g, b) => Math.min(r, g, b) >= 200 && Math.max(r, g, b) - Math.min(r, g, b) <= 40;

  // Finds 4-6 white card faces near each other and splits them into a left and a right group.
  function findCards(img, zone) {
    const r = zone || { x: 0, y: 0, width: img.width, height: img.height };
    const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
    const w = Math.min(img.width - x0, Math.ceil(r.width)), h = Math.min(img.height - y0, Math.ceil(r.height));
    if (w <= 0 || h <= 0) return null;
    const labels = new Uint8Array(w * h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      let p = ((y0 + y) * img.width + x0) * 4, i = y * w;
      for (let x = 0; x < w; x++, p += 4, i++) if (isWhite(d[p], d[p + 1], d[p + 2])) labels[i] = 1;
    }
    const cands = components(labels, w, h).filter(b => {
      const short = Math.min(b.w, b.h), long = Math.max(b.w, b.h);
      return short >= 14 && long / short >= 1.2 && long / short <= 1.85 && b.area / (b.w * b.h) >= 0.5;
    });
    for (const b of cands) { b.box = b.w * b.h; b.long = Math.max(b.w, b.h); }
    const parent = cands.map((_, i) => i);
    const find = i => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) {
      const a = cands[i], b = cands[j];
      if (b.box / a.box < 0.6 || b.box / a.box > 1.65) continue;
      if (Math.hypot(a.cx - b.cx, a.cy - b.cy) <= 3.2 * Math.max(a.long, b.long)) parent[find(i)] = find(j);
    }
    const groups = new Map();
    cands.forEach((c, i) => { const k = find(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); });
    let best = null;
    for (const g of groups.values()) {
      if (g.length < 4 || g.length > 6) continue;
      if (!best || g.length > best.length || (g.length === best.length && g[0].box > best[0].box)) best = g;
    }
    if (!best) return null;
    best.sort((a, b) => a.cx - b.cx);
    let gapAt = 1, gap = -Infinity;
    for (let i = 1; i < best.length; i++) { const gp = best[i].minX - best[i - 1].maxX; if (gp > gap) { gap = gp; gapAt = i; } }
    const toBox = b => ({ x: b.minX + x0, y: b.minY + y0, width: b.w, height: b.h, rotated: b.w > b.h });
    const left = best.slice(0, gapAt).map(toBox), right = best.slice(gapAt).map(toBox);
    if (left.length < 2 || left.length > 3 || right.length < 2 || right.length > 3) return null;
    const all = left.concat(right);
    const bx = Math.min(...all.map(b => b.x)), by = Math.min(...all.map(b => b.y));
    const bx1 = Math.max(...all.map(b => b.x + b.width)), by1 = Math.max(...all.map(b => b.y + b.height));
    return { left, right, bounds: { x: bx, y: by, width: bx1 - bx, height: by1 - by },
      cardShort: median(all.map(b => Math.min(b.width, b.height))) };
  }

  // Pixel accessor for a card turned upright. rot: 0 = as shown, 1/2 = the two 90° turns.
  function uprightAccessor(img, box, rot) {
    const W = img.width, d = img.data;
    const bx = Math.round(box.x), by = Math.round(box.y), bw = Math.round(box.width), bh = Math.round(box.height);
    if (rot === 0) return { w: bw, h: bh, at: (x, y) => ((by + y) * W + bx + x) * 4, d };
    if (rot === 1) return { w: bh, h: bw, at: (x, y) => ((by + bh - 1 - x) * W + bx + y) * 4, d };
    return { w: bh, h: bw, at: (x, y) => ((by + x) * W + bx + bw - 1 - y) * 4, d };
  }

  const GW = 10, GH = 14;
  const isInk = (r, g, b) => (0.299 * r + 0.587 * g + 0.114 * b) < 150 || (r > 130 && r - g > 60 && r - b > 40);

  // Ink strength of a pixel (0..1): dark text, or red text on a white card.
  function inkLevel(r, g, b) {
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const dark = (215 - lum) / 140, red = (r - Math.max(g, b) - 50) / 110;
    return Math.max(0, Math.min(1, Math.max(dark, red)));
  }

  // Rank symbol feature from a region given by an accessor. Region = card corner, or a whole canvas for seeds.
  // The rank is the first band of ink from the top, ending at the blank gap above the suit symbol.
  function glyphFeature(acc, rx, ry, rw, rh) {
    rw = Math.max(1, Math.round(rw)); rh = Math.max(1, Math.round(rh));
    const ink = new Float32Array(rw * rh), labels = new Uint8Array(rw * rh);
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) {
      const p = acc.at(rx + x, ry + y), v = inkLevel(acc.d[p], acc.d[p + 1], acc.d[p + 2]);
      ink[y * rw + x] = v;
      if (v >= 0.35) labels[y * rw + x] = 1;
    }
    // Remove ink touching the outer edge (rounded card corner, borders) and specks.
    const { blobs, ids } = components(labels, rw, rh, true);
    const bad = new Set(blobs.filter(b => b.minX === 0 || b.minY === 0 || b.area < 2).map(b => b.id));
    const rowInk = new Float32Array(rh);
    for (let i = 0; i < rw * rh; i++) {
      if (labels[i] && bad.has(ids[i])) { labels[i] = 0; ink[i] = 0; }
      if (labels[i]) rowInk[(i / rw) | 0]++;
    }
    let y0 = 0; while (y0 < rh && !rowInk[y0]) y0++;
    if (y0 >= rh) return null;
    let y1 = y0; while (y1 + 1 < rh && rowInk[y1 + 1]) y1++;
    if (y1 - y0 + 1 < Math.max(4, rh * 0.12)) return null;
    let x0 = rw, x1 = -1;
    const partIds = new Set();
    for (let y = y0; y <= y1; y++) for (let x = 0; x < rw; x++) if (labels[y * rw + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; partIds.add(ids[y * rw + x]); }
    // count separate pieces side by side (e.g. "1" and "0")
    const pieces = [...partIds].map(id => blobs[id]).filter(b => b.h >= (y1 - y0 + 1) * 0.6).length;
    const gw = x1 - x0 + 1, gh = y1 - y0 + 1;
    const f = new Float32Array(GW * GH), n = new Float32Array(GW * GH);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const cx = Math.min(GW - 1, Math.floor((x - x0) / gw * GW)), cy = Math.min(GH - 1, Math.floor((y - y0) / gh * GH));
      n[cy * GW + cx]++; f[cy * GW + cx] += ink[y * rw + x];
    }
    for (let i = 0; i < f.length; i++) f[i] = n[i] ? f[i] / n[i] : 0;
    return { f: Array.from(f), aspect: gw / gh, parts: Math.max(1, Math.min(2, pieces)) };
  }

  function glyphDistance(a, b) {
    let s = 0;
    for (let i = 0; i < a.f.length; i++) { const d = a.f[i] - b.f[i]; s += d * d; }
    const da = Math.log(a.aspect / b.aspect);
    return s / a.f.length + 0.25 * da * da + (a.parts !== b.parts ? 0.04 : 0);
  }

  // Best distance per rank, closest first.
  function matchGlyph(feat, templates) {
    const bestPer = new Map();
    for (const t of templates) {
      const dd = glyphDistance(feat, t);
      if (!bestPer.has(t.rank) || dd < bestPer.get(t.rank)) bestPer.set(t.rank, dd);
    }
    const sorted = [...bestPer.entries()].sort((a, b) => a[1] - b[1]);
    if (!sorted.length) return null;
    return { rank: sorted[0][0], dist: sorted[0][1], margin: sorted.length > 1 ? sorted[1][1] - sorted[0][1] : 1,
      alts: sorted.slice(0, 4).map(([rank, dist]) => ({ rank, dist })) };
  }

  // Read one card: tries the upright orientation (or both turns for a sideways card).
  // A site's own learned templates only win on a near-exact match (same graphic drawn again);
  // otherwise the generic font templates decide, so a few learned ranks cannot pull other ranks toward them.
  const EXACT = 0.03;
  function readCard(img, box, templates) {
    const learned = templates.filter(t => !t.seed), seeds = templates.filter(t => t.seed);
    const rots = box.width > box.height ? [1, 2] : [0];
    let best = null;
    for (const rot of rots) {
      const acc = uprightAccessor(img, box, rot);
      const feat = glyphFeature(acc, 1, 1, acc.w * 0.5, acc.h * 0.3);
      if (!feat) continue;
      let m = matchGlyph(feat, seeds.length ? seeds : templates);
      const ml = learned.length ? matchGlyph(feat, learned) : null;
      if (ml && ml.dist <= EXACT) {
        const alts = [{ rank: ml.rank, dist: ml.dist }].concat((m ? m.alts : []).filter(a => a.rank !== ml.rank).map(a => ({ rank: a.rank, dist: Math.max(a.dist, ml.dist + 0.001) })));
        m = { rank: ml.rank, dist: ml.dist, margin: alts.length > 1 ? alts[1].dist - ml.dist : 1, alts, exact: true };
      }
      if (m && (!best || m.dist < best.dist)) best = { ...m, feat };
    }
    return best;
  }

  // Seed templates (browser only): every rank drawn in common card fonts at several sizes.
  function makeSeedTemplates(ranks) {
    ranks = ranks || ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
    const fonts = ['Arial', 'Helvetica', 'Verdana', 'Tahoma', 'Segoe UI', 'Calibri', 'Times New Roman', 'Georgia', 'Trebuchet MS', 'Impact', 'Cambria'];
    const c = document.createElement('canvas'); c.width = 110; c.height = 80;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const out = [];
    for (const size of [12, 14, 17, 22, 30, 46]) for (const font of fonts) for (const wt of ['bold', 'normal']) for (const r of ranks) {
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 110, 80);
      ctx.fillStyle = '#000'; ctx.font = `${wt} ${size}px "${font}"`; ctx.textBaseline = 'top';
      ctx.fillText(r, 8, 8);
      const img = ctx.getImageData(0, 0, 110, 80);
      const f = glyphFeature(uprightAccessor(img, { x: 0, y: 0, width: 110, height: 80 }, 0), 1, 1, 108, 78);
      if (f) out.push({ ...f, rank: r, seed: true, size });
    }
    return out;
  }

  root.RoadVision = { setTieFrac: f => { TIE_FRAC = f; }, decodeBigRoad, makeSeedTemplates, classify, components, readRoad, gridRead, findRoad, readRoadLive, findCards,
    glyphFeature, matchGlyph, readCard, uprightAccessor, glyphDistance, autocorr, estimatePitch, labelImage };
  if (typeof module !== 'undefined') module.exports = root.RoadVision;
})(typeof window !== 'undefined' ? window : globalThis);
