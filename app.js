/* global Baccarat, RoadVision, Learner */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const B = Baccarat, V = RoadVision, L = Learner, E = Evaluator;
  const bridge = window.bridge;

  const BASE = { B: 0.458597, P: 0.446247, T: 0.095156 };
  const NAMES = { B: 'Banker', P: 'Player', T: 'Tie' };
  const COLORS = { B: '#e5484d', P: '#3e7bfa', T: '#30a46c' };
  const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
  const signPct = (x, d = 2) => (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(d) + '%';

  // ------------------------------------------------------------------ state
  const S = {
    host: '', mode: 'web', wcId: null, scale: 1, frame: null,
    sig: null, roadMisses: 0, roadBox: null,
    sites: {},                       // per-site setup: { cards: { ready, swap, zone, templates } }
    seeds: [],
    history: [], maxVisible: 0, emptyScans: 0, possibleShuffle: false, joined: false,
    shoe: null,
    cards: { lastKey: null, streak: 0, stable: null, openEntry: null, attachedKey: null, calibOpen: false, calibStreak: 0, snoozeUntil: 0, last: null, box: null, epoch: 0, epochAt: 0, staleEpoch: null, present: false },
    model: L.createModel(null), log: [], settings: { sure: 0.55, interval: 1000, frames: true },
    pending: null,
    timer: null, scanning: false, debug: [], events: [],
  };

  function freshShoe(id, fromStart) {
    return { id, counts: B.fullCounts(), cardsSeen: 0, handsWithCards: 0, fromStart, startedAt: Date.now() };
  }

  // ------------------------------------------------------------------ storage
  let saveTimer = null;
  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 800);
  }
  // When the app closes, save everything one last time so the latest hand is never lost.
  window.addEventListener('beforeunload', () => {
    if (!bridge || !S.model) return;
    clearTimeout(saveTimer);
    bridge.saveAllSync({ log: S.log.slice(-20000), model: S.model, settings: S.settings, sites: S.sites });
  });

  async function saveNow() {
    if (!bridge) return;
    await bridge.save('log', S.log.slice(-20000));
    await bridge.save('model', S.model);
    await bridge.save('settings', S.settings);
    await bridge.save('sites', S.sites);
  }
  async function loadAll() {
    S.log = (await bridge.load('log')) || [];
    S.model = L.createModel(await bridge.load('model'));
    Object.assign(S.settings, (await bridge.load('settings')) || {});
    S.sites = (await bridge.load('sites')) || {};
    S.lastUrl = (await bridge.load('lastUrl')) || '';
    // Data from before version 2 could include misread and repeated hands: back it up and start learning fresh.
    if ((S.settings.dataVersion || 1) < 2) {
      const stamp = new Date().toISOString().slice(0, 10);
      if (S.log.length) await bridge.save('backup-' + stamp + '-log', S.log);
      await bridge.save('backup-' + stamp + '-model', S.model);
      S.log = []; S.model = L.createModel(null);
      S.settings.dataVersion = 2;
      S.cleanedUp = true;
      await saveNow();
    }
    const previousLog = S.log.map(e => ({ ...e, pred: e.pred && { ...e.pred }, road: e.road && { ...e.road } }));
    let normalized = false;
    for (const e of S.log) {
      if ((e.joined || e.replay) && (e.pred || e.road || !e.replay)) {
        e.pred = null; e.road = null; delete e.correct; delete e.roadCorrect; e.replay = true;
        normalized = true;
      }
    }
    if (normalized) {
      const stamp = new Date().toISOString().slice(0, 10);
      await bridge.save('backup-' + stamp + '-prediction-log', previousLog);
      await bridge.save('log', S.log.slice(-20000));
    }
  }
  const site = () => (S.sites[S.host] = S.sites[S.host] || {});
  // 3: ranks are cut out of the corner as a shape, so templates saved before that no longer compare.
  const CARD_TEMPLATE_VERSION = 3;
  const cardsReady = () => !!(site().cards && site().cards.ready &&
    site().cards.templateVersion >= CARD_TEMPLATE_VERSION);

  // ------------------------------------------------------------------ rank templates
  const makeSeeds = () => V.makeSeedTemplates();
  const templates = () => ((site().cards && site().cards.templates) || []).concat(S.seeds);

  // ------------------------------------------------------------------ navigation
  const wv = $('casino');
  function normalizeUrl(s) {
    s = (s || '').trim();
    if (!s) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
    try { return new URL(s).href; } catch { return null; }
  }
  function openUrl(raw) {
    const u = normalizeUrl(raw);
    if (!u) { toast('That link does not look right.'); return; }
    stopWindowMode();
    try { S.host = new URL(u).host || 'local'; } catch { /* keep */ }
    $('startScreen').hidden = true;
    $('urlInput').value = u;
    bridge.save('lastUrl', u);
    setStep('Link', 'busy', 'Loading the game…');
    wv.loadURL(u);
  }
  $('startForm').addEventListener('submit', e => { e.preventDefault(); openUrl($('startInput').value); });
  $('urlForm').addEventListener('submit', e => { e.preventDefault(); openUrl($('urlInput').value); });
  $('navBack').onclick = () => wv.canGoBack() && wv.goBack();
  $('navReload').onclick = () => wv.reload();

  wv.addEventListener('dom-ready', () => { S.wcId = wv.getWebContentsId(); });
  wv.addEventListener('did-navigate', e => {
    if (S.mode !== 'web') return;
    $('urlInput').value = e.url;
    let host = '';
    try { host = new URL(e.url).host || 'local'; } catch { host = 'local'; }
    if (host !== S.host) {
      // Setup made before the page finished loading (no site yet) carries over to this site.
      if (!S.host && S.sites[''] && !S.sites[host]) S.sites[host] = S.sites[''];
      delete S.sites[''];
      S.host = host; S.sig = null; renderSteps();
    }
  });
  wv.addEventListener('did-finish-load', () => {
    if (S.mode === 'web' && $('startScreen').hidden) { setStep('Link', 'ok', S.host); startLoop(); }
  });

  // ------------------------------------------------------------------ watch-a-window mode
  // The casino runs in the user's own browser (normal login and captcha); the app reads that window.
  let shareStream = null, shareCapture = null;
  async function openPicker() {
    $('picker').hidden = false;
    $('pickerList').innerHTML = '<p class="muted">Looking for windows...</p>';
    const list = await bridge.listSources();
    S.sources = list;
    const esc = t => t.replace(/[<>&"]/g, '');
    $('pickerList').innerHTML = list.map((src, i) => `<button data-i="${i}">
      ${src.thumb ? `<img src="${src.thumb}" alt="">` : '<div class="muted small">No preview</div>'}
      <span>${src.screen ? 'Whole screen: ' : ''}${esc(src.name)}</span></button>`).join('') || '<p class="muted">No windows found.</p>';
    document.querySelectorAll('#pickerList button').forEach(b => (b.onclick = () => startWindowMode(S.sources[+b.dataset.i])));
  }
  async function startWindowMode(src) {
    $('picker').hidden = true;
    stopWindowMode();
    try {
      await bridge.chooseSource(src.id);
      shareStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 5, width: { ideal: 3840 }, height: { ideal: 2160 } }, audio: false });
    } catch (err) {
      toast('Could not read that window. Try again or pick another one.');
      return false;
    }
    shareCapture = new ImageCapture(shareStream.getVideoTracks()[0]);
    const v = $('shareVideo');
    v.srcObject = shareStream; v.hidden = false;
    await v.play().catch(() => {});
    shareStream.getVideoTracks()[0].addEventListener('ended', () => { toast('The watched window was closed.'); stopWindowMode(); });
    S.mode = 'window';
    wv.style.visibility = 'hidden';
    $('startScreen').hidden = true;
    if (S.host !== 'window') { S.host = 'window'; S.sig = null; }
    S.sourceName = src.name; S.lastFreshAt = Date.now(); S.staleWarned = false;
    S.settings.lastSource = src.name; scheduleSave();
    setStep('Link', 'ok', 'Watching: ' + src.name);
    startLoop();
    setCompact(true);
    toast('Keep the casino window visible on the left. A fully covered window stops updating.');
    return true;
  }
  function setCompact(on) {
    document.body.classList.toggle('compact', on);
    $('btnFull').hidden = !on;
    bridge.compact(on);
  }
  function stopWindowMode() {
    if (document.body.classList.contains('compact')) setCompact(false);
    if (shareStream) shareStream.getTracks().forEach(t => t.stop());
    shareStream = null; shareCapture = null;
    $('shareVideo').hidden = true; $('shareVideo').srcObject = null;
    wv.style.visibility = 'visible';
    if (S.mode === 'window') { S.mode = 'web'; S.sig = null; }
  }
  // Reconnect to the window watched last time (window ids change between sessions, so match by title).
  async function watchAgain() {
    const want = S.settings.lastSource || '';
    const list = await bridge.listSources();
    const words = w => w.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(x => x.length > 2);
    const score = s => { const a = new Set(words(s.name)); return words(want).filter(x => a.has(x)).length; };
    const exact = list.find(s => s.name === want);
    const best = exact || list.filter(s => !s.screen).sort((a, b) => score(b) - score(a))[0];
    if (best && (exact || score(best) >= 2)) { S.sources = list; startWindowMode(best); }
    else { toast('That window was not found. Pick it from the list.'); openPicker(); }
  }
  $('startWatchAgain').onclick = watchAgain;
  $('btnWatch').onclick = openPicker;
  $('btnFull').onclick = () => setCompact(false);
  $('startWatch').onclick = openPicker;
  $('pickerRefresh').onclick = openPicker;
  $('pickerClose').onclick = () => { $('picker').hidden = true; };

  // ------------------------------------------------------------------ main loop
  function startLoop() {
    clearInterval(S.timer);
    S.timer = setInterval(scan, S.settings.interval);
  }

  // One frame from the current source: the built-in browser, or the watched window.
  const grab = document.createElement('canvas');
  async function captureFrame() {
    if (S.mode === 'window') {
      // Grab the newest frame straight from the stream (works even when the preview is hidden).
      if (!shareCapture) return null;
      const bmp = await shareCapture.grabFrame();
      grab.width = bmp.width; grab.height = bmp.height;
      const ctx = grab.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      const d = ctx.getImageData(0, 0, grab.width, grab.height);
      return { width: d.width, height: d.height, data: d.data };
    }
    if (S.wcId == null) return null;
    const r = wv.getBoundingClientRect();
    const cap = await bridge.capture(S.wcId, null, { x: r.left, y: r.top, width: r.width, height: r.height });
    return cap && { width: cap.width, height: cap.height, data: cap.data };
  }

  // Image pixels <-> positions on screen inside the game area (for outlines and the manual box).
  function viewGeom() {
    if (S.mode === 'window') {
      const v = $('shareVideo'), cw = v.clientWidth, ch = v.clientHeight;
      const vw = v.videoWidth || (S.frame && S.frame.width) || 1, vh = v.videoHeight || (S.frame && S.frame.height) || 1;
      const k = Math.min(cw / vw, ch / vh);
      return { k, ox: (cw - vw * k) / 2, oy: (ch - vh * k) / 2 };
    }
    return { k: 1 / S.scale, ox: 0, oy: 0 };
  }
  const imgToCss = b => { const g = viewGeom(); return { x: g.ox + b.x * g.k, y: g.oy + b.y * g.k, width: b.width * g.k, height: b.height * g.k }; };
  const cssToImg = b => { const g = viewGeom(); return { x: (b.x - g.ox) / g.k, y: (b.y - g.oy) / g.k, width: b.width / g.k, height: b.height / g.k }; };

  async function scan() {
    // Watchdog: if a scan has been stuck for more than 8 seconds, start fresh.
    if (S.scanning && Date.now() - S.scanStarted < 8000) return;
    S.scanning = true; S.scanStarted = Date.now();
    try {
      const tc = performance.now();
      const img = await captureFrame();
      S.captureMs = Math.round(performance.now() - tc);
      S.scanCount = (S.scanCount || 0) + 1;
      if (!img) { S.captureFails = (S.captureFails || 0) + 1; return; }
      // fingerprint to see whether the picture actually changed
      let fp = 0; for (let i = 0; i < img.data.length; i += 4001) fp = (fp * 31 + img.data[i]) | 0;
      if (fp !== S.lastFp) { S.freshFrames = (S.freshFrames || 0) + 1; S.lastFp = fp; S.lastFreshAt = Date.now(); if (S.staleWarned) { S.staleWarned = false; setStep('Link', 'ok', 'Watching: ' + S.sourceName); } }
      else if (S.mode === 'window' && Date.now() - (S.lastFreshAt || Date.now()) > 8000 && !S.staleWarned) {
        S.staleWarned = true;
        setStep('Link', 'busy', 'The casino window is not updating. Make sure it is visible, not minimised or fully covered.');
        toast('The casino window is not updating. Keep it visible on the left.');
      }
      S.frame = img;
      if (S.mode === 'web') S.scale = img.width / Math.max(1, wv.clientWidth);
      const t0 = performance.now();
      processCards(img);
      processRoad(img);
      drawFrames();
      S.scanMs = Math.round(performance.now() - t0);
    } catch (err) {
      console.error(err);
    } finally { S.scanning = false; }
  }

  // ------------------------------------------------------------------ roadmap
  // ---- the user's roadmap box (saved per site as fractions of the picture, so it survives resizing)
  const boxToImg = (b, img) => ({ x: b.fx * img.width, y: b.fy * img.height, width: b.fw * img.width, height: b.fh * img.height });
  function cropImg(img, r) {
    const x0 = Math.max(0, Math.round(r.x)), y0 = Math.max(0, Math.round(r.y));
    const w = Math.max(0, Math.min(img.width - x0, Math.round(r.width))), h = Math.max(0, Math.min(img.height - y0, Math.round(r.height)));
    const data = new Uint8ClampedArray(w * h * 4);
    for (let yy = 0; yy < h; yy++) data.set(img.data.subarray(((y0 + yy) * img.width + x0) * 4, ((y0 + yy) * img.width + x0 + w) * 4), yy * w * 4);
    return { width: w, height: h, data, x0, y0 };
  }
  // Read the road inside a box. holder.sig keeps the last good grid, so an empty or nearly empty road
  // (right after a shuffle) is still read correctly.
  function readBoxed(img, rect, holder) {
    const crop = cropImg(img, rect);
    if (crop.width < 10 || crop.height < 10) return { seq: [], marks: [], box: null, sig: null };
    const found = V.findRoad(crop);
    if (found) holder.sig = found;
    if (!holder.sig) {
      // Too few marks for the grid finder (e.g. early in a shoe): read every coloured mark in the box directly.
      const r = V.readRoad(crop);
      if (!r.marks.length) return { seq: [], marks: [], box: null, sig: null };
      const ws = r.marks.map(m => Math.min(m.w, m.h)).sort((a, b) => a - b);
      const mixed = new Set(r.marks.map(m => m.col)).size >= 2 &&
        [...new Set(r.marks.map(m => m.col))].some(c => new Set(r.marks.filter(m => m.col === c && m.side !== 'T').map(m => m.side)).size > 1);
      holder.sig = { x0: Math.min(...r.marks.map(m => m.minX)), y0: Math.min(...r.marks.map(m => m.minY)),
        x1: Math.max(...r.marks.map(m => m.maxX)), y1: Math.max(...r.marks.map(m => m.maxY)),
        d: ws[Math.floor(ws.length / 2)] || 6, fill: 0.6, pitch: r.pitch || 8, kind: mixed ? 'Bead Plate' : 'Big Road',
        imgW: crop.width, imgH: crop.height, fallback: true };
    }
    const sig = holder.sig;
    const res = V.readRoadLive(crop, sig, true);
    if (res.box) { res.box.x += crop.x0; res.box.y += crop.y0; }
    res.marks.forEach(m => { m.minX += crop.x0; m.maxX += crop.x0; m.minY += crop.y0; m.maxY += crop.y0; m.cx += crop.x0; });
    res.sig = sig;
    return res;
  }

  function processRoad(img) {
    const ub = site().roadBox;
    if (ub) {
      if (S.boxFrame !== img.width + 'x' + img.height) { S.boxFrame = img.width + 'x' + img.height; S.boxHolder = { sig: null }; }
      const rect = boxToImg(ub, img);
      const res = readBoxed(img, rect, S.boxHolder || (S.boxHolder = { sig: null }));
      S.roadBox = rect; S.sig = res.sig; S.sig2 = null;
      S.lastRead = res;
      renderBoxStatus();
      if (!res.sig || !res.seq.length) {
        setStep('Road', 'busy', 'Nothing read inside your roadmap box yet. Click the yellow Roadmap label to adjust it.');
        if (S.history.length) onRoadRead([]);
        return;
      }
      finishRoad(res);
      return;
    }
    if (S.sig && (S.sig.imgW !== img.width || S.sig.imgH !== img.height)) { S.sig = null; S.sig2 = null; S.pendingRoadKey = null; }
    if (!S.sig) {
      const pick = pickRoads(img);
      if (!pick) { setStep('Road', 'busy', 'Looking for the roadmap…'); S.roadBox = null; return; }
      S.sig = pick.main; S.sig2 = pick.check;
    }
    const res = V.readRoadLive(img, S.sig);
    // Cross-check with the second road (e.g. Big Road vs Bead Plate): one usually shows only the latest hands,
    // so the shorter reading must match the end of the longer one. If not, wait for the next scan.
    if (S.sig2 && res.seq.length) {
      const r2 = V.readRoadLive(img, S.sig2).seq;
      if (r2.length) {
        const [lo, hi] = r2.length <= res.seq.length ? [r2, res.seq] : [res.seq, r2];
        if (!endsWith(hi, lo)) {
          if (++S.roadDisagree < 8) { setStep('Road', 'busy', 'Double-checking the roadmap…'); return; }
          // Still disagreeing: trust the Bead Plate (one mark per hand, simplest to read) and use the other as the check.
          if (S.sig2.kind === 'Bead Plate' && S.sig.kind !== 'Bead Plate') {
            [S.sig, S.sig2] = [S.sig2, S.sig]; S.roadDisagree = 0; S.pendingRoadKey = null;
            return;
          }
        } else S.roadDisagree = 0;
      }
    }
    S.roadBox = res.box || { x: S.sig.x0, y: S.sig.y0, width: S.sig.x1 - S.sig.x0, height: S.sig.y1 - S.sig.y0 };
    if (!res.seq.length) {
      // Empty: usually a shuffle. Only if it stays empty for a long time, look for the same kind of road elsewhere
      // (the page layout may have changed). Never switch to a road with different marks.
      if (++S.roadMisses % 20 === 0) {
        const sig = V.findRoad(img);
        const sameKind = sig && sig.kind === S.sig.kind && Math.abs(sig.d - S.sig.d) <= S.sig.d * 0.25 && sig.count >= 6;
        if (sameKind && (Math.abs(sig.x0 - S.sig.x0) > sig.pitch * 2 || Math.abs(sig.y0 - S.sig.y0) > sig.pitch * 2)) S.sig = sig;
      }
    } else S.roadMisses = 0;
    finishRoad(res);
  }

  function finishRoad(res) {
    // Very small marks (a small or zoomed-out window) are easy to misread: warn instead of guessing quietly.
    const tiny = S.sig.d < 5;
    // Big Road tie lines are thin: below about 11 px per cell some ties can be missed.
    const smallTies = !tiny && S.sig.kind === 'Big Road' && S.sig.pitch < 11;
    setStep('Road', tiny || smallTies ? 'busy' : 'ok', tiny
      ? `Reading the ${S.sig.kind}, but it is very small on screen. Make the casino window bigger (or full screen) for accurate reading.`
      : smallTies ? `Reading the Big Road${site().roadBox ? ' inside your box' : ''}, but it is small (${S.sig.pitch.toFixed(0)} px per cell), so some Ties can be missed. Make the casino window bigger.`
      : `Reading the ${S.sig.kind}${site().roadBox ? ' inside your box' : ''}`);
    if (tiny && !S.tinyWarned) { S.tinyWarned = true; toast('The roadmap is very small. Make the casino window bigger for accurate reading.'); }
    if (!tiny) S.tinyWarned = false;
    S.lastRead = res;
    // A change must be read the same way on two scans in a row. This filters the blinking newest mark,
    // hover effects and half-drawn frames. (An empty road already needs two scans before it counts.)
    const key = res.seq.join('');
    if (res.seq.length && key !== S.history.join('') && key !== S.pendingRoadKey) { S.pendingRoadKey = key; return; }
    S.pendingRoadKey = null;
    onRoadRead(res.seq);
  }

  // Main road = the full-size road that shows the most results (the whole shoe); the next one is used to cross-check.
  function pickRoads(img) {
    const all = V.findRoad(img, null, true) || [];
    if (!all.length) return null;
    const maxD = Math.max(...all.map(r => r.d));
    const reads = all.filter(r => r.d >= 0.6 * maxD).map(s => ({ s, n: V.readRoadLive(img, s).seq.length }))
      .sort((a, b) => b.n - a.n || b.s.d - a.s.d);
    if (!reads.length) return null;
    return { main: reads[0].s, check: reads[1] ? reads[1].s : null };
  }

  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const endsWith = (arr, suf) => suf.length <= arr.length && same(arr.slice(arr.length - suf.length), suf);

  // A mark that appears for a single scan is not a hand. One flickering mark on the Big Road, read as
  // new each scan, used to append a result every time: that is what produced logged streaks of 23 in a
  // row, which cannot happen at a real table. New results must now be read the same way twice running.
  function confirmed(add, histLen) {
    const key = histLen + ':' + add.join('');
    if (S.roadPending && S.roadPending === key) { S.roadPending = null; return true; }
    S.roadPending = key;
    return false;
  }

  function onRoadRead(seq) {
    const h = S.history;
    if (!seq.length) {
      if (h.length && ++S.emptyScans >= 2 && !S.possibleShuffle) {
        S.possibleShuffle = true;
        S.emptyAt = Date.now();
        S.events.push({ t: Date.now(), type: 'roadmap empty' });
        renderShoe('Roadmap cleared. Waiting for the new shoe…');
      }
      return;
    }
    const afterEmpty = S.possibleShuffle;
    S.emptyScans = 0; S.possibleShuffle = false;
    S.maxVisible = Math.max(S.maxVisible, seq.length);
    if (same(seq, h)) return; // the same roadmap came back (it was hidden, not shuffled)

    if (!S.joined) { joinShoe(seq); return; }

    // After the roadmap was empty: either the same shoe came back with new hands, or a new shoe started.
    if (afterEmpty) {
      if (seq.length >= h.length && same(seq.slice(0, h.length), h)) { const add = seq.slice(h.length); if (confirmed(add, h.length)) add.forEach(r => addResult(r, add.length === 1)); return; }
      if (h.length >= 3) { newShoe(seq, true); return; }
    }

    // New hands appended (also handles a full roadmap that scrolled left).
    for (let d = 1; d <= 6 && d <= seq.length; d++) {
      const prefix = seq.slice(0, seq.length - d);
      const fits = prefix.length === h.length ? same(prefix, h) : prefix.length >= 6 && endsWith(h, prefix);
      if (fits) { const add = seq.slice(-d); if (confirmed(add, h.length)) add.forEach(r => addResult(r, d === 1)); return; }
    }
    // Roadmap shows an older part of the same shoe (scrolled view): ignore.
    if (h.length > seq.length && endsWith(h, seq) && seq.length >= 0.6 * S.maxVisible) return;

    // A reading that only repeats the start of this shoe is a partial view of the roadmap, not a new shoe.
    if (seq.length < h.length && same(seq, h.slice(0, seq.length))) return;

    // A short roadmap that does not continue the old one is a new shoe (missed the empty roadmap).
    // It must be read the same way on three scans in a row. A very young shoe is never replaced this way.
    if (h.length >= 6 && seq.length < Math.max(6, 0.5 * h.length)) {
      const key = seq.join('');
      S.shoeCandidate = S.shoeCandidate && S.shoeCandidate.key === key ? { key, n: S.shoeCandidate.n + 1 } : { key, n: 1 };
      if (S.shoeCandidate.n >= 3) { S.shoeCandidate = null; newShoe(seq, false); }
      return;
    }

    // Otherwise the screen corrected an earlier misread: trust the screen, and fix the log of this shoe too.
    S.events.push({ t: Date.now(), type: 'correction', from: h.join(''), to: seq.join('') });
    let c = 0; while (c < h.length && c < seq.length && h[c] === seq[c]) c++;
    S.log = S.log.filter(e => !(S.shoe && e.shoe === S.shoe.id && e.hand > c));
    S.history = h.slice(0, c);
    computePrediction();
    seq.slice(c).forEach(r => addResult(r, false));
    renderAll(); scheduleSave();
  }

  function joinShoe(seq) {
    S.events.push({ t: Date.now(), type: 'join', seq: seq.join('') });
    S.joined = true;
    S.shoe = freshShoe(nextShoeId(), seq.length <= 1);
    S.history = [];
    S.maxVisible = seq.length;
    // Log the results already on the roadmap, marked "before you joined" (no prediction, not learned from).
    S.joining = true;
    for (const r of seq) { S.pending = null; addResult(r, false); }
    S.joining = false;
    computePrediction(); renderAll(); scheduleSave();
    if (seq.length > 1) toast(`Joined a shoe in progress: ${seq.length} results read.`);
  }

  function newShoe(seq, sawEmpty) {
    S.events.push({ t: Date.now(), type: 'new shoe', seq: seq.join(''), sawEmpty, epoch: S.cards.epoch });
    // Seeing the roadmap empty is what proves we are at the start of the shoe (allow one extra mark of read lag).
    S.shoe = freshShoe(nextShoeId(), sawEmpty && seq.length <= 2);
    // A deal that was already on the table when the roadmap cleared is the old shoe's last hand. It can
    // still be sitting there as the new shoe is declared, so the whole deal is retired by its epoch —
    // otherwise the next scan of those same cards would be counted as the new shoe's first hand.
    if (S.cards.present && (S.cards.epochAt || 0) <= (S.emptyAt || 0)) S.cards.staleEpoch = S.cards.epoch;
    const st = S.cards.stable;
    if (st && !st.used) {
      // What decides is when the deal began, not when it was last read: cards dealt before the roadmap
      // cleared are the old shoe's last hand, even if they were still being read after it cleared.
      if (sawEmpty && st.epochAt > (S.emptyAt || 0)) { st.shoe = S.shoe.id; st.hist = 0; } // first hand of the new shoe
      else st.used = true; // cards from the old shoe
    }
    S.history = []; S.maxVisible = 0;
    computePrediction();
    toast('New shoe detected. Counting cards from the start.');
    // Not scored (the result was already on screen when the shoe was spotted), but when it is the only
    // one there, the cards being dealt are its own.
    seq.forEach(r => addResult(r, false, seq.length === 1));
    if (seq.length > 2) S.shoe.fromStart = false;
    renderAll();
  }
  const nextShoeId = () => Math.max(0, ...S.log.map(e => e.shoe || 0), S.shoe ? S.shoe.id : 0) + 1;

  // ------------------------------------------------------------------ results, logging, learning
  // live = this hand appeared on its own, after its prediction was shown. Hands re-added by a correction,
  // the roadmap box, Fix results or several at once are "replayed": logged, but never learned from or scored.
  // pairable = the cards on the table can be this hand's. It follows live, except at the start of a shoe,
  // where the first result is not scored but its cards are the ones being dealt.
  function addResult(r, live = true, pairable = live) {
    const p = S.pending;
    const e = { t: Date.now(), epoch: S.cards.epoch, site: S.host, shoe: S.shoe.id, hand: S.history.length + 1, result: r, cards: null,
      pred: live && !S.joining && p ? { side: p.side, q: +p.q.toFixed(8), mathQ: +p.mathQ.toFixed(8),
        sure: p.sure, conf: +p.conf.toFixed(8), modelQ: +p.modelQ.toFixed(8), oddsVersion: 2 } : null,
      road: live && !S.joining && p && p.road && p.road.side ? { side: p.road.side, reason: p.road.reason } : null };
    if (!live) e.replay = true;
    if (S.joining) e.joined = true;
    if (e.road && r !== 'T') e.roadCorrect = e.road.side === r;
    if (e.pred && p) e.pred.modelQ = +p.modelQ.toFixed(8);
    if (e.pred && r !== 'T') {
      e.correct = e.pred.side === r;
      L.update(S.model, p.x, r === 'B' ? 1 : 0);
    }
    S.log.push(e);
    S.history.push(r);
    // When the roadmap catches up with several hands at once, the cards on the table belong to the
    // newest of them, not to the one being logged here, so no hand in that batch may claim them.
    S.cards.openEntry = pairable ? e : null;
    const st = S.cards.stable;
    // Cards belong to a result only if they were on the table during the same deal.
    if (pairable && cardsBelong(st, e)) {
      const fit = resolveFor(st, r);
      if (fit) attachCards(e, fit, st);
      else e.noCards = 'read a different hand';
    } else if (!e.joined) {
      // Say in the log why a hand holds no cards, so a gap can be chased instead of guessed at.
      e.noCards = !pairable ? 'roadmap caught up late'
        : !st || st.used ? 'no confirmed reading'
          : st.shoe !== e.shoe || st.epoch > e.epoch || e.epoch - st.epoch > 1 ? 'reading was another deal'
            : 'reading did not line up';
    }
    if (S.joining) return; // the caller renders once at the end
    computePrediction();
    renderAll();
    flash('prediction');
    scheduleSave();
  }

  function attachCards(entry, st, original) {
    entry.cards = { P: st.pRanks, B: st.bRanks };
    delete entry.noCards;   // the cards arrived after all
    if (st.corrected) entry.cards.corrected = true;
    for (const r of st.pRanks.concat(st.bRanks)) {
      const v = B.rankValue(r);
      if (S.shoe.counts[v] > 0) S.shoe.counts[v]--;
      S.shoe.cardsSeen++;
    }
    S.shoe.handsWithCards++;
    S.cards.attachedKey = cardStamp(st);
    st.used = true;
    if (original) original.used = true;
    if (!st.corrected) learnTemplates(st);
    setStep('Cards', 'ok', `Recorded hand ${entry.hand}: Player ${st.pRanks.join(' ')} · Banker ${st.bRanks.join(' ')}.` + cardsProgress());
    computePrediction();
    renderAll();
    scheduleSave();
  }

  // Cards that passed the rules check and matched the roadmap teach the reader this site's font.
  function learnTemplates(st) {
    const c = site().cards; if (!c) return;
    c.templates = c.templates || [];
    for (const card of st.reads) {
      if (!card.feat || card.dist < 0.004 || card.margin < 0.01) continue;
      const mine = c.templates.filter(t => t.rank === card.rank);
      if (mine.length >= 6) c.templates.splice(c.templates.indexOf(mine[0]), 1);
      c.templates.push({ f: card.feat.f, aspect: card.feat.aspect, parts: card.feat.parts, rank: card.rank });
    }
  }

  // Cards fit a logged hand only if they were seen in the same shoe, just before (or just after) that
  // hand's result appeared on the roadmap. Fast tables clear the cards and deal again before the
  // roadmap catches up, so the result may arrive one deal late; the hand number is what pins the cards
  // to their result, and the reading still has to produce that result before it is used.
  const cardStamp = st => `${st.shoe}:${st.epoch}:${st.hist}:${st.key}`;
  const cardsBelong = (st, e) => st && e && !st.used && st.shoe === e.shoe &&
    (e.epoch - st.epoch === 0 || e.epoch - st.epoch === 1) &&
    (e.hand - st.hist === 1 || e.hand - st.hist === 0) && S.cards.attachedKey !== cardStamp(st);

  // ------------------------------------------------------------------ prediction
  function computePrediction() {
    const shoe = S.shoe;
    const math = shoe && shoe.cardsSeen ? (B.probsFromCounts(shoe.counts) || BASE) : BASE;
    const mathQ = math.B / (math.B + math.P);
    const x = L.features(S.history, mathQ);
    const modelQ = L.predict(S.model, x);
    const liveStats = L.stats(S.log.filter(e => !e.replay));
    const mathSide = mathQ >= 0.5 ? 'B' : 'P';
    const mathConf = Math.max(mathQ, 1 - mathQ);
    const side = modelQ >= 0.5 ? 'B' : 'P';
    const conf = Math.max(modelQ, 1 - modelQ);
    const decision = L.decision({
      modelQ, math, proofN: liveStats.decided, modelVsMath: liveStats.modelVsMath,
      shoeComplete: !!(shoe && shoe.fromStart),
      roadSide: B.roadmapPick(S.history).side, roadN: liveStats.roadN, roadAccuracy: liveStats.roadAccuracy,
    });
    const road = B.roadmapPick(S.history);
    S.pending = {
      x, q: modelQ, modelQ, mathQ, mathSide,
      mathProbs: { B: math.B, P: math.P, T: math.T }, side, conf, math, road,
      decision,
      mathSure: mathConf >= S.settings.sure, mathConf,
      sure: conf >= S.settings.sure, probs: { B: math.B, P: math.P, T: math.T },
      ev: { B: math.B * 0.95 - math.P, P: math.P - math.B, T: math.T * 8 - (1 - math.T) },
    };
  }

  // ------------------------------------------------------------------ cards
  function zonePx() {
    const z = site().cards && site().cards.zone;
    if (!z || !S.frame) return null;
    if (Number.isFinite(z.fx) && Number.isFinite(z.fy) && Number.isFinite(z.fw) && Number.isFinite(z.fh))
      return { x: z.fx * S.frame.width, y: z.fy * S.frame.height, width: z.fw * S.frame.width, height: z.fh * S.frame.height };
    const kx = z.imgW ? S.frame.width / z.imgW : 1, ky = z.imgH ? S.frame.height / z.imgH : 1;
    return { x: z.x * kx, y: z.y * ky, width: z.width * kx, height: z.height * ky };
  }

  function cardsProgress() {
    const sh = S.shoe;
    return sh ? ` Cards recorded this shoe: ${sh.cardsSeen} cards across ${sh.handsWithCards} hands.` : '';
  }

  // Read all cards. If the best reading breaks the drawing rules, try each card's next-closest ranks
  // and keep the closest legal hand for every possible winner (the roadmap then picks the right one).
  function readHand(img, found) {
    const tpl = templates();
    const left = found.left.map(b => V.readCard(img, b, tpl)), right = found.right.map(b => V.readCard(img, b, tpl));
    S.cards.readFailures = left.concat(right).map((c, i) => c ? null : { i, box: found.left.concat(found.right)[i] }).filter(Boolean);
    if (S.cards.readFailures.length) return null;
    const swap = site().cards && site().cards.swap;
    const P = swap ? right : left, Bk = swap ? left : right;
    const cards = P.concat(Bk), nP = P.length;
    const options = cards.map(c => c.alts.filter(a => a.dist <= c.dist + 0.02));
    const byResult = {};
    let combos = 0;
    const pick = new Array(cards.length);
    (function walk(i, cost) {
      if (combos > 4000) return;
      if (i === cards.length) {
        combos++;
        const pR = pick.slice(0, nP).map(a => a.rank), bR = pick.slice(nP).map(a => a.rank);
        const res = B.validateHand(pR.map(B.rankValue), bR.map(B.rankValue));
        if (res && cost <= 0.04 && (!byResult[res] || cost < byResult[res].cost)) byResult[res] = { pRanks: pR, bRanks: bR, cost };
        return;
      }
      for (const a of options[i]) { pick[i] = a; walk(i + 1, cost + a.dist - cards[i].dist); }
    })(0, 0);
    const best = Object.entries(byResult).sort((a, b) => a[1].cost - b[1].cost)[0];
    const pRanks = best ? best[1].pRanks : P.map(c => c.rank), bRanks = best ? best[1].bRanks : Bk.map(c => c.rank);
    const result = best ? best[0] : null;
    // The hand is identified by what would be recorded, not by each card's first guess. Two near-tied
    // guesses on one card flip back and forth between scans; the hand they both correct to does not,
    // and holding that still is what lets a hand be confirmed by a second look.
    const key = 'P:' + pRanks.slice().sort().join(',') + '|B:' + bRanks.slice().sort().join(',') + '#' + cards.length;
    const readable = cards.every(c => c.dist <= 0.2 && c.margin >= 0.02);
    // Confident = every card is a clear match that stood on its own, and the hand needed no correction
    // to obey the drawing rules. Such a hand is taken from a single scan, which is all a fast table
    // gives before the cards are swept; anything less has to be read the same way twice.
    const confident = !!best && best[1].cost === 0 && cards.every(c => c.dist <= 0.12 && c.margin >= 0.05);
    return { pRanks, bRanks, result, valid: !!result, readable, confident, key, reads: cards, byResult, corrected: best ? best[1].cost > 0 : false, found };
  }

  // Pick the legal reading that agrees with the roadmap winner.
  function resolveFor(st, r) {
    if (!st.byResult || !st.byResult[r]) return st.result === r ? st : null;
    const alt = st.byResult[r];
    return { ...st, pRanks: alt.pRanks, bRanks: alt.bRanks, result: r, corrected: alt.cost > 0 };
  }

  function processCards(img) {
    const zone = zonePx();
    const found = V.findCards(img, zone);
    S.cards.box = zone || (found ? found.bounds : null);
    if (!found) {
      S.cards.present = false; S.cards.lastKey = null; S.cards.streak = 0; S.cards.attachedKey = null; S.cards.calibStreak = 0;
      if (!S.cards.calibOpen && !adj && Date.now() >= S.cards.snoozeUntil) {
        setStep('Cards', 'busy', (zone ? 'No card faces detected in the green box. Adjust it to cover all dealt card faces.'
          : 'No card faces detected; searching across the game view.') + cardsProgress());
      }
      drawFrames();
      return;
    }
    // Cards appearing after an empty table start a new deal.
    if (!S.cards.present) { S.cards.present = true; S.cards.epoch++; S.cards.epochAt = Date.now(); }

    if (!cardsReady()) {
      if (S.cards.calibOpen || adj || Date.now() < S.cards.snoozeUntil) return; // never on top of adjust mode
      // Ask as soon as the cards form a complete legal hand (or after two frames with cards, so the user can fix misreads).
      const h = readHand(img, found);
      if (++S.cards.calibStreak >= 2 || (h && h.valid)) openCalibration(img, found);
      else setStep('Cards', 'busy', 'Cards spotted. Waiting for the deal to finish…');
      return;
    }
    const hand = readHand(img, found);
    S.debug.push({ t: Date.now(), epoch: S.cards.epoch, hist: S.history.length, n: found.left.length + found.right.length, hand: hand && {
      p: hand.reads.slice(0, found.left.length).map(c => c.rank + ':' + c.dist.toFixed(3) + ':' + c.margin.toFixed(3)),
      b: hand.reads.slice(found.left.length).map(c => c.rank + ':' + c.dist.toFixed(3) + ':' + c.margin.toFixed(3)),
      valid: hand.valid, readable: hand.readable, res: hand.result,
    }, failed: hand ? [] : (S.cards.readFailures || []) });
    if (S.debug.length > 300) S.debug.shift();
    if (!hand) {
      setStep('Cards', 'busy', 'Card faces found, but one or more ranks are unclear. This hand is not counted.' + cardsProgress());
      return;
    }
    if (!hand.readable) {
      S.cards.last = hand;
      setStep('Cards', 'busy', 'Unclear card rank; this hand is not counted. Adjust the green box or redo card setup.' + cardsProgress());
      return;
    }
    if (hand.key === S.cards.lastKey) S.cards.streak++; else { S.cards.lastKey = hand.key; S.cards.streak = 1; }
    S.cards.last = hand;
    // A hand that passes the drawing rules is complete (no more cards can come). One confident read is enough;
    // a less certain read must be seen the same way twice.
    if (hand.valid && (hand.confident || S.cards.streak >= 2) && S.cards.epoch !== S.cards.staleEpoch) {
      if (!S.cards.stable || S.cards.stable.key !== hand.key || S.cards.stable.epoch !== S.cards.epoch ||
          S.cards.stable.shoe !== S.shoe.id || S.cards.stable.hist !== S.history.length || S.cards.stable.used)
        S.cards.stable = { ...hand, seenAt: Date.now(), used: false, epoch: S.cards.epoch, epochAt: S.cards.epochAt, shoe: S.shoe && S.shoe.id, hist: S.history.length };
      const e = S.cards.openEntry;
      const canAttach = e && !e.cards && e.shoe === S.shoe.id && e.hand === S.history.length && cardsBelong(S.cards.stable, e);
      if (!canAttach && cardStamp(S.cards.stable) !== S.cards.attachedKey)
        setStep('Cards', 'busy', `Read Player ${hand.pRanks.join(' ')} · Banker ${hand.bRanks.join(' ')}; waiting for the matching roadmap result.` + cardsProgress());
      tryAttachLatest();
    } else {
      // Say which of the two it is actually waiting for, so a hand that sits here is not a mystery.
      const why = hand.valid ? 'checking the same reading once more' : 'waiting for the deal to finish';
      setStep('Cards', 'busy', `Cards visible: Player ${hand.pRanks.join(' ')} · Banker ${hand.bRanks.join(' ')}; ${why}.` + cardsProgress());
    }
  }

  // The roadmap may update before the cards are confirmed: attach to the latest hand if it matches.
  function tryAttachLatest() {
    const st = S.cards.stable;
    if (!st || st.used || S.cards.attachedKey === st.key) return;
    const e = S.cards.openEntry;
    if (e && !e.cards && S.shoe && e.shoe === S.shoe.id && e.hand === S.history.length && cardsBelong(st, e)) {
      const fit = resolveFor(st, e.result);
      if (fit) attachCards(e, fit, st);
    }
  }

  // ------------------------------------------------------------------ one-time card setup
  let calib = null;
  function openCalibration(img, found) {
    S.cards.calibOpen = true;
    const tpl = templates();
    const reads = found.left.concat(found.right).map(b => V.readCard(img, b, tpl));
    calib = { img, found, reads, swap: false, ranks: reads.map(r => (r ? r.rank : 'A')), t: Date.now(), epoch: S.cards.epoch, shoe: S.shoe && S.shoe.id, hist: S.history.length };
    // Snapshot of the card area
    const pad = found.cardShort * 0.6, bx = Math.max(0, Math.floor(found.bounds.x - pad)), by = Math.max(0, Math.floor(found.bounds.y - pad));
    const bw = Math.min(img.width - bx, found.bounds.width + 2 * pad), bh = Math.min(img.height - by, found.bounds.height + 2 * pad);
    const cv = $('calibCanvas'), k = Math.min(640 / bw, 220 / bh);
    cv.width = Math.round(bw * k); cv.height = Math.round(bh * k);
    const tmp = document.createElement('canvas'); tmp.width = img.width; tmp.height = img.height;
    tmp.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length), img.width, img.height), 0, 0);
    const ctx = cv.getContext('2d');
    ctx.drawImage(tmp, bx, by, bw, bh, 0, 0, cv.width, cv.height);
    const all = found.left.concat(found.right);
    ctx.font = 'bold 13px sans-serif';
    all.forEach((b, i) => {
      ctx.strokeStyle = i < found.left.length ? '#3e7bfa' : '#e5484d'; ctx.lineWidth = 2;
      ctx.strokeRect((b.x - bx) * k, (b.y - by) * k, b.width * k, b.height * k);
    });
    renderCalib();
    $('calib').hidden = false;
    setStep('Cards', 'busy', 'Please confirm the cards on screen');
  }

  function renderCalib() {
    const n = calib.found.left.length;
    const mk = idx => `<select data-i="${idx}">${B.RANKS.map(r => `<option ${r === calib.ranks[idx] ? 'selected' : ''}>${r}</option>`).join('')}</select>`;
    const leftIdx = [...Array(n).keys()], rightIdx = [...Array(calib.found.right.length).keys()].map(i => i + n);
    const pIdx = calib.swap ? rightIdx : leftIdx, bIdx = calib.swap ? leftIdx : rightIdx;
    $('calibP').innerHTML = pIdx.map(mk).join('');
    $('calibB').innerHTML = bIdx.map(mk).join('');
    document.querySelectorAll('#calib select').forEach(s => (s.onchange = () => { calib.ranks[+s.dataset.i] = s.value; checkCalib(); }));
    checkCalib();
  }
  function calibHand() {
    const n = calib.found.left.length;
    const L_ = calib.ranks.slice(0, n), R_ = calib.ranks.slice(n);
    const P = calib.swap ? R_ : L_, Bk = calib.swap ? L_ : R_;
    return { P, Bk, result: B.validateHand(P.map(B.rankValue), Bk.map(B.rankValue)) };
  }
  function checkCalib() {
    const h = calibHand();
    const tot = a => a.reduce((s, r) => s + B.rankValue(r), 0) % 10;
    $('calibCheck').innerHTML = h.result
      ? `<span class="pos">Valid hand.</span> Player ${tot(h.P)}, Banker ${tot(h.Bk)}: <b>${h.result === 'T' ? 'Tie' : NAMES[h.result] + ' wins'}</b>.`
      : '<span class="neg">These cards break the drawing rules. A card is misread, or the hand is not finished yet.</span>';
    $('calibOk').disabled = !h.result;
  }
  $('calibSwap').onclick = () => { calib.swap = !calib.swap; renderCalib(); };
  $('calibLater').onclick = () => { closeCalib(); S.cards.snoozeUntil = Date.now() + 45000; setStep('Cards', '', 'Will ask again after a later hand'); };
  $('calibOk').onclick = () => {
    const h = calibHand();
    const tpls = [];
    calib.reads.forEach((r, i) => {
      if (r && r.feat && r.feat.f && r.feat.f.every(Number.isFinite) &&
          Number.isFinite(r.feat.aspect) && r.feat.aspect > 0.2 && r.feat.aspect < 3)
        tpls.push({ f: r.feat.f, aspect: r.feat.aspect, parts: r.feat.parts, rank: calib.ranks[i] });
    });
    const pad = calib.found.cardShort * 1.6, b = calib.found.bounds;
    const previousZone = site().cards && site().cards.zone;
    site().cards = {
      ready: true, templateVersion: CARD_TEMPLATE_VERSION, swap: calib.swap, templates: tpls,
      zone: previousZone || { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad, imgW: S.frame.width, imgH: S.frame.height },
      setupAt: Date.now(),
    };
    // Use this confirmed hand straight away.
    const n = calib.found.left.length;
    const reads = calib.reads.map((r, i) => ({ ...(r || {}), rank: calib.ranks[i], dist: 0 }));
    const P = calib.swap ? reads.slice(n) : reads.slice(0, n), Bk = calib.swap ? reads.slice(0, n) : reads.slice(n);
    S.cards.stable = { pRanks: h.P, bRanks: h.Bk, result: h.result, valid: true, reads: P.concat(Bk),
      key: 'P:' + h.P.slice().sort().join(',') + '|B:' + h.Bk.slice().sort().join(','), seenAt: calib.t, used: false, epoch: calib.epoch, epochAt: S.cards.epochAt, shoe: calib.shoe, hist: calib.hist };
    closeCalib();
    tryAttachLatest();
    if (!S.cards.stable.used) setStep('Cards', 'busy', 'Card setup saved. Waiting for the next hand to be read and matched.' + cardsProgress());
    scheduleSave();
    toast('Cards learned. The app is now fully automatic.');
  };
  function closeCalib() { $('calib').hidden = true; S.cards.calibOpen = false; S.cards.calibStreak = 0; calib = null; }

  // ------------------------------------------------------------------ manual roadmap box (fallback)
  const overlay = $('selectOverlay'), selBox = $('selectBox');
  let dragStart = null;
  $('btnManual').onclick = () => openAdjust();

  // ---- Adjust mode: drag and resize the yellow roadmap box; the app reads only inside it.
  let adj = null;
  let adjustGeneration = 0;
  function openAdjust(mode = 'roadmap') {
    if (!S.frame) return toast('Open the game first.');
    const fromCompact = document.body.classList.contains('compact');
    if (fromCompact) setCompact(false);
    const generation = ++adjustGeneration;
    adj = { css: null, fromCompact, holder: { sig: null }, mode };
    $('adjust').classList.toggle('adjust-cards', mode === 'cards');
    $('adjust').style.zIndex = '20';
    $('adjust').querySelector('.adjust-title').textContent = mode === 'cards' ? 'Put the green box over the dealt cards'
      : 'Put the yellow box over one roadmap';
    $('adjust').querySelector('.adjust-bar .muted').textContent = mode === 'cards'
      ? 'Include the Player and Banker card faces. Drag to move; pull a corner to resize. The preview shows detected cards.'
      : 'Drag it to move. Pull a corner to resize. The Big Road shows the whole shoe; the Bead Plate often shows only the latest hands.';
    $('adjustBox').querySelector('span').textContent = mode === 'cards' ? 'Cards' : 'Roadmap';
    $('adjustAuto').textContent = mode === 'cards' ? 'Auto-find cards' : 'Let the app find it';
    $('adjustRead').textContent = mode === 'cards' ? 'Green card box is being shown…' : '';
    $('adjust').hidden = false;
    $('adjustBox').style.zIndex = '3';
    const initialize = () => {
      if (!adj || generation !== adjustGeneration) return;
      const area = $('gameArea').getBoundingClientRect();
      if (area.width < 100 || area.height < 100) {
        toast('The game view is too small to show the adjustment box. Restore the full view and try again.');
        return;
      }
      let css;
      if (mode === 'cards' && site().cards && site().cards.zone) css = imgToCss(zonePx());
      else if (mode === 'roadmap' && site().roadBox) css = imgToCss(boxToImg(site().roadBox, S.frame));
      else if (mode === 'cards' && S.cards.box) {
        const b = imgToCss(S.cards.box), pad = Math.max(24, Math.min(b.width, b.height) * 0.7);
        css = { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad };
      } else if (mode === 'roadmap' && S.roadBox) {
        const b = imgToCss(S.roadBox);
        css = { x: b.x - 6, y: b.y - 6, width: b.width + 12, height: b.height + 12 };
      } else if (mode === 'cards') {
        css = { x: area.width * 0.28, y: area.height * 0.38, width: area.width * 0.44, height: area.height * 0.42 };
      } else css = { x: area.width / 2 - 160, y: area.height - 160, width: 320, height: 110 };
      adj.css = css;
      placeAdjust();
    };
    if (fromCompact) requestAnimationFrame(() => requestAnimationFrame(initialize));
    else initialize();
  }
  function placeAdjust() {
    if (!adj || !adj.css) return;
    const area = $('gameArea').getBoundingClientRect(), b = adj.css;
    if (area.width < 30 || area.height < 20) return;
    b.width = Math.max(30, Math.min(b.width, area.width)); b.height = Math.max(20, Math.min(b.height, area.height));
    b.x = Math.max(0, Math.min(b.x, area.width - b.width)); b.y = Math.max(0, Math.min(b.y, area.height - b.height));
    place($('adjustBox'), b);
    previewAdjust();
  }
  let previewQueued = false;
  function previewAdjust() {
    if (previewQueued) return;
    previewQueued = true;
    requestAnimationFrame(() => {
      previewQueued = false;
      if (!adj || !S.frame) return;
      if (adj.mode === 'cards') {
        const found = V.findCards(S.frame, cssToImg(adj.css));
        $('adjustRead').innerHTML = found
          ? `Found <b>${found.left.length + found.right.length} cards</b>. Blue boxes are Player (${found.left.length}); red boxes are Banker (${found.right.length}).`
          : '<span class="neg">No complete card groups found. Make the box include all 4–6 card faces.</span>';
        return;
      }
      const res = readBoxed(S.frame, cssToImg(adj.css), { sig: null });
      const c = { B: 0, P: 0, T: 0 }; res.seq.forEach(x => c[x]++);
      $('adjustRead').innerHTML = res.seq.length
        ? `Reading the <b>${res.sig.kind}</b>: <b>${res.seq.length}</b> results (Banker ${c.B}, Player ${c.P}, Tie ${c.T}). Last ones: <b>${res.seq.slice(-12).join(' ')}</b>`
        : '<span class="neg">No roadmap marks inside the box yet.</span>';
    });
  }
  (function () {
    const box = $('adjustBox');
    let drag = null;
    box.addEventListener('pointerdown', e => {
      e.preventDefault(); box.setPointerCapture(e.pointerId);
      drag = { h: e.target.dataset.h || 'move', sx: e.clientX, sy: e.clientY, start: { ...adj.css } };
    });
    box.addEventListener('pointermove', e => {
      if (!drag) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy, s = drag.start, b = adj.css;
      if (drag.h === 'move') { b.x = s.x + dx; b.y = s.y + dy; }
      else {
        if (drag.h.includes('w')) { b.x = Math.min(s.x + dx, s.x + s.width - 30); b.width = s.width - (b.x - s.x); }
        if (drag.h.includes('e')) b.width = Math.max(30, s.width + dx);
        if (drag.h.includes('n')) { b.y = Math.min(s.y + dy, s.y + s.height - 20); b.height = s.height - (b.y - s.y); }
        if (drag.h.includes('s')) b.height = Math.max(20, s.height + dy);
      }
      placeAdjust();
    });
    const end = () => { drag = null; };
    box.addEventListener('pointerup', end); box.addEventListener('pointercancel', end);
  })();
  function closeAdjust() {
    adjustGeneration++;
    $('adjust').hidden = true;
    if (adj && adj.fromCompact) setCompact(true);
    adj = null;
  }
  $('adjustDone').onclick = () => {
    const r = cssToImg(adj.css), f = S.frame;
    if (adj.mode === 'cards') {
      site().cards = site().cards || {};
      site().cards.zone = { x: r.x, y: r.y, width: r.width, height: r.height, imgW: f.width, imgH: f.height,
        fx: r.x / f.width, fy: r.y / f.height, fw: r.width / f.width, fh: r.height / f.height };
      S.cards.lastKey = null; S.cards.streak = 0; S.cards.present = false; S.cards.stable = null; S.cards.attachedKey = null;
      closeAdjust(); scheduleSave(); processCards(S.frame); drawFrames();
      toast('Card detection box saved. Keep it over both hands; card setup will start when a hand is visible.');
      return;
    }
    site().roadBox = { fx: r.x / f.width, fy: r.y / f.height, fw: r.width / f.width, fh: r.height / f.height };
    S.boxHolder = { sig: null }; S.boxFrame = S.frame.width + 'x' + S.frame.height; S.pendingRoadKey = null;
    const res = readBoxed(S.frame, boxToImg(site().roadBox, S.frame), S.boxHolder);
    S.lastRead = res; S.sig = res.sig; S.sig2 = null;
    closeAdjust(); scheduleSave(); renderBoxStatus();
    if (res.seq.length) {
      applyBoxReading(res.seq);
      toast(`Roadmap box saved. Loaded ${res.seq.length} results from it into the shoe.`);
    } else toast('Roadmap box saved, but nothing is read inside it yet. Make it cover the circles of one road.');
  };
  $('adjustCancel').onclick = closeAdjust;
  // What the box reads becomes the shoe: start it, or replace an earlier (wrong) reading of this shoe.
  function applyBoxReading(seq) {
    if (!S.joined) { joinShoe(seq); return; }
    const h = S.history;
    if (same(seq, h)) return;
    if (seq.length > h.length && same(seq.slice(0, h.length), h)) { seq.slice(h.length).forEach(r => addResult(r, false)); return; }
    let c = 0; while (c < h.length && c < seq.length && h[c] === seq[c]) c++;
    S.events.push({ t: Date.now(), type: 'box reading', from: h.join(''), to: seq.join('') });
    S.log = S.log.filter(e => !(S.shoe && e.shoe === S.shoe.id && e.hand > c));
    S.history = seq.slice();
    S.maxVisible = Math.max(S.maxVisible, seq.length);
    computePrediction(); renderAll(); scheduleSave();
  }
  $('adjustAuto').onclick = () => {
    if (adj && adj.mode === 'cards') {
      if (site().cards) delete site().cards.zone;
      S.cards.lastKey = null; S.cards.present = false; S.cards.stable = null;
      closeAdjust(); scheduleSave(); processCards(S.frame);
      toast('Card detection will search the full screen again.');
    } else {
      delete site().roadBox; S.sig = null; S.sig2 = null; S.boxHolder = null; S.pendingRoadKey = null;
      closeAdjust(); scheduleSave();
      toast('The app will find the roadmap by itself.');
    }
  };
  $('btnAdjust').onclick = () => openAdjust();
  $('roadFrameLabel').onclick = () => openAdjust(); // click the yellow label to move or resize the box
  $('btnAdjustCards').onclick = () => openAdjust('cards');
  $('cardFrameLabel').onclick = () => openAdjust('cards');
  window.addEventListener('resize', () => { if (adj) placeAdjust(); });
  overlay.addEventListener('mousedown', e => {
    const r = overlay.getBoundingClientRect();
    dragStart = { x: e.clientX - r.left, y: e.clientY - r.top };
    selBox.hidden = false; place(selBox, { x: dragStart.x, y: dragStart.y, width: 0, height: 0 });
  });
  overlay.addEventListener('mousemove', e => {
    if (!dragStart) return;
    const r = overlay.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    place(selBox, { x: Math.min(x, dragStart.x), y: Math.min(y, dragStart.y), width: Math.abs(x - dragStart.x), height: Math.abs(y - dragStart.y) });
  });
  overlay.addEventListener('mouseup', e => {
    if (!dragStart) return;
    const r = overlay.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
    const rect = { x: Math.min(x, dragStart.x), y: Math.min(y, dragStart.y), width: Math.abs(x - dragStart.x), height: Math.abs(y - dragStart.y) };
    dragStart = null; overlay.hidden = true;
    const img = S.frame, ir = cssToImg(rect);
    const x0 = Math.max(0, Math.round(ir.x)), y0 = Math.max(0, Math.round(ir.y));
    const w = Math.min(img.width - x0, Math.round(ir.width)), h = Math.min(img.height - y0, Math.round(ir.height));
    if (w < 20 || h < 10) return toast('That box was too small.');
    const crop = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
    for (let yy = 0; yy < h; yy++) crop.data.set(img.data.subarray(((y0 + yy) * img.width + x0) * 4, ((y0 + yy) * img.width + x0 + w) * 4), yy * w * 4);
    const sig = V.findRoad(crop);
    if (!sig) return toast('No roadmap marks found in that box.');
    sig.x0 += x0; sig.x1 += x0; sig.y0 += y0; sig.y1 += y0; sig.imgW = img.width; sig.imgH = img.height;
    S.sig = sig; S.sig2 = null; toast(`Using the ${sig.kind} you selected.`);
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { overlay.hidden = true; dragStart = null; } });

  // ------------------------------------------------------------------ rendering
  function place(el, r) { Object.assign(el.style, { left: r.x + 'px', top: r.y + 'px', width: r.width + 'px', height: r.height + 'px' }); }
  function drawFrames() {
    const show = S.settings.frames;
    const toCss = imgToCss;
    const rf = $('roadFrame'), cf = $('cardFrame');
    rf.hidden = !(show && S.roadBox); if (!rf.hidden) place(rf, toCss(S.roadBox));
    cf.hidden = !(S.cards.box && (show || !!(site().cards && site().cards.zone)));
    if (!cf.hidden) place(cf, toCss(S.cards.box));
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 4000);
  }
  function flash(id) { const el = $(id); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }

  const stepState = { Link: ['', 'Waiting for the link'], Road: ['', 'Not found yet'], Cards: ['', 'Waiting for a hand to finish'] };
  function setStep(name, cls, text) { stepState[name] = [cls, text]; renderSteps(); }
  function renderSteps() {
    for (const k of Object.keys(stepState)) {
      const el = $('step' + k);
      el.className = 'step ' + stepState[k][0];
      el.querySelector('span').textContent = stepState[k][1];
    }
  }
  function renderPrediction() {
    const p = S.pending, el = $('prediction'), badge = $('predBadge');
    if (!S.joined || !p) {
      el.innerHTML = '<div class="big"><div class="side-chip none">?</div><div><div class="title">Waiting</div><div class="muted small">The prediction appears once the roadmap is read.</div></div></div>';
      badge.textContent = 'Waiting'; badge.className = 'pill';
      return;
    }
    // Use the learned card-and-roadmap model as the experimental forecast; show exact shoe odds separately.
    const side = p.decision.side, modelSide = p.side, conf = p.conf, probs = p.mathProbs;
    const road = p.road && p.road.side ? p.road : null;
    const liveStats = L.stats(S.log.filter(e => !e.replay));
    badge.textContent = 'Experimental model'; badge.className = 'pill';
    const usingCards = S.shoe && S.shoe.cardsSeen > 0;
    const cardSource = !usingCards ? 'the standard 8-deck shoe'
      : S.shoe.fromStart ? 'the tracked cards remaining in this shoe'
        : 'cards tracked since joining; earlier dealt cards are unknown';
    const evCell = s => `<div><span>${NAMES[s]}</span><b class="${p.ev[s] > 0 ? 'pos' : 'neg'}">${signPct(p.ev[s])}</b></div>`;
    const plusEv = ['B', 'P', 'T'].filter(s => p.ev[s] > 0);
    el.innerHTML = `
      <div class="big">
        <div class="side-chip ${side || 'none'}">${side || '–'}</div>
        <div>
          <div class="title">${side ? `Reliable next hand: ${NAMES[side]}` : 'No bet worth making on this hand'}</div>
          <div class="muted small">${side
            ? `${p.decision.reason}. This is still an estimate, not a guarantee.`
            : `${p.decision.reason}. The model leans ${NAMES[modelSide]} at ${pct(conf)} conditional on no tie, which is not a reason to bet.`}</div>
        </div>
      </div>
      ${road ? `<div class="note">Roadmap pattern view: <b>${NAMES[road.side]}</b> — ${road.reason}. Historical pattern accuracy: ${liveStats.roadAccuracy == null ? '–' : pct(liveStats.roadAccuracy)} of ${liveStats.roadN} settled picks; this is not proof of an edge.</div>` : ''}
      <div class="note">Model view: <b>${NAMES[modelSide]}</b> (${pct(conf)} conditional estimate). It is experimental and is not reliable unless the evidence gate passes.</div>
      <div class="bars">
        ${['B', 'P', 'T'].map(s => `<div class="bar"><span>${NAMES[s]}</span>
          <div class="track"><div class="fill" style="width:${(probs[s] * 100 / 0.6).toFixed(1)}%;background:${COLORS[s]}"></div></div>
          <span class="num">${pct(probs[s])}</span></div>`).join('')}
      </div>
      <div class="note">Exact shoe odds alone favor <b>${NAMES[p.mathSide]}</b>: Banker ${pct(p.mathQ)} vs Player ${pct(1 - p.mathQ)} conditional on no tie. The model can disagree based on patterns, but those patterns are not proven to predict outcomes.</div>
      <div class="road-pick">
        <div><b>Evidence and disagreement</b>
          <ul class="muted small">${p.decision.votes.map(v => `<li><b>${v.name}:</b> ${v.detail}</li>`).join('')}</ul>
          ${p.decision.ev == null ? '' : `<div class="muted small">Experimental estimated return: ${signPct(p.decision.ev)} per unit. Not a proven betting edge.</div>`}
        </div>
      </div>
      <div class="note">Expected return per bet, from the ${usingCards ? 'cards left in this shoe' : 'standard 8-deck odds'}:</div>
      <div class="ev">${evCell('B')}${evCell('P')}${evCell('T')}</div>
      <div class="note">${plusEv.length ? `<b class="pos">Rare spot: ${plusEv.map(s => NAMES[s]).join(' and ')} has a positive edge right now.</b>`
        : 'No bet has a positive edge this hand. Banker loses the least.'}
        Card math alone says Banker ${pct(p.mathQ)} vs Player ${pct(1 - p.mathQ)}.</div>
      <div class="note">${S.shoe && !S.shoe.fromStart ? 'Mid-shoe note: cards dealt before joining are unknown, so the shoe-odds comparison uses only cards tracked since joining.' : `Odds shown are calculated from ${cardSource}.`}
        The system requires two independent sources to support the same positive-return side; it can abstain and cannot guarantee a win.</div>`;
  }

  // Roadmap read: the patterns on screen now, with how often each one really continues.
  let runTable = null;
  function renderRoadRead() {
    const el = $('roadRead');
    const r = B.runsNow(S.history);
    if (!S.joined || !r.side) { el.innerHTML = ''; return; }
    const t = runTable;
    const chance = (arr, k) => (t && arr[Math.min(k, 12)] != null ? pct(arr[Math.min(k, 12)]) : '…');
    const streakLine = `<div class="rr-row"><span>${NAMES[r.side]} streak of ${r.run}. A streak this long continued</span><b>${chance(t ? t.streakContinue : [], r.run)}</b></div>`;
    const chopLine = r.alt >= 2 ? `<div class="rr-row"><span>Ping-pong of ${r.alt}. A ping-pong this long continued</span><b>${chance(t ? t.chopContinue : [], r.alt)}</b></div>` : '';
    el.innerHTML = `<h4>Roadmap read</h4>${streakLine}${chopLine}
      <div class="rr-row"><span>This shoe so far: longest streak</span><b>${r.maxRun} ${r.maxRunSide ? NAMES[r.maxRunSide] : ''}</b></div>
      <div class="rr-row"><span>Longest ping-pong</span><b>${r.maxAlt}</b></div>
      <div class="note">${t ? `In ${t.shoes.toLocaleString()} simulated shoes, ${pct(t.share.streak6, 0)} had a streak of 6 or more and ${pct(t.share.chop10, 0)} had a ping-pong of 10 or more.
        Long runs are normal, but a run of any length continued about half the time. These patterns describe past results; the next-hand forecast uses shoe odds only.` : 'Measuring how runs behave in simulated shoes…'}</div>`;
  }

  function renderBoxStatus() {
    const bs = $('boxStatus');
    if (bs) {
      if (site().roadBox) {
        const n = S.lastRead ? S.lastRead.seq.length : 0;
        bs.innerHTML = n ? `Reading your roadmap box (${S.sig ? S.sig.kind : 'road'}): <b>${n}</b> results on screen.`
          : '<span class="neg">Nothing read inside your roadmap box. Click the yellow Roadmap label and make the box cover the circles of one road.</span>';
      } else bs.textContent = S.sig ? `Finding the roadmap by itself (${S.sig.kind}). Click the yellow Roadmap label to set the box yourself.` : '';
    }
  }

  function renderShoe(msg) {
    const sh = S.shoe;
    renderBoxStatus();
    $('shoeTitle').textContent = sh ? `Shoe ${sh.id} · hand ${S.history.length + 1} next` : 'Shoe';
    const badge = $('countBadge');
    if (!sh) { badge.textContent = 'No shoe yet'; badge.className = 'pill'; $('shoeInfo').textContent = ''; }
    else {
      badge.textContent = sh.fromStart ? 'Counting from the shuffle' : 'Joined mid-shoe';
      badge.className = 'pill ' + (sh.fromStart ? 'ok' : 'warn');
      const left = sh.counts.reduce((a, b) => a + b, 0);
      const last = S.log.length && S.log[S.log.length - 1].cards;
      $('shoeInfo').innerHTML = (msg ? `<b>${msg}</b><br>` : '') +
        `Cards seen ${sh.cardsSeen} in ${sh.handsWithCards} of ${S.history.length} hands · about ${left} cards left.` +
        (sh.fromStart ? '' : ' Cards dealt before you joined are unknown, so the count is partial until the next shuffle.') +
        (last ? `<br>Last hand: Player ${last.P.join(' ')} · Banker ${last.B.join(' ')}` : '');
    }
    drawBead(); drawBig();
    drawDerived('bebCanvas', 1, 'hollow'); drawDerived('srCanvas', 2, 'filled'); drawDerived('cpCanvas', 3, 'slash');
    renderAsk();
  }

  function renderLearning() {
    const st = L.stats(S.log.filter(e => !e.replay));
    $('learnBadge').textContent = `${st.decided} forecasts scored`;
    const fmt = v => (v == null ? '–' : pct(v));
    const mvm = st.modelVsMath;
    const mvmText = st.decided < 30 ? 'Learning vs card math (needs 30+ hands)'
      : Math.abs(mvm) < 0.0005 ? 'Same as the card math' : mvm > 0 ? 'Learning beats the card math' : 'Learning trails the card math';
    const w = S.model.w;
    $('learning').innerHTML = `
      <div class="stats">
        <div class="stat"><b>${fmt(st.accuracy)}</b><span>Forecasts right (${st.decided})</span></div>
        <div class="stat"><b>${fmt(st.sureAccuracy)}</b><span>Strong model estimates right (${st.sureN})</span></div>
        <div class="stat"><b>${fmt(st.recent)}</b><span>Last ${st.recentN} predictions</span></div>
        <div class="stat"><b class="${mvm > 0.0005 ? 'pos' : mvm < -0.0005 ? 'neg' : ''}">${st.decided < 30 ? '–' : (mvm >= 0 ? '+' : '−') + Math.abs(mvm * 1000).toFixed(1)}</b><span>${mvmText}</span></div>
      </div>
      <div class="note">The experimental model above uses these learned signal weights to adjust the shoe-odds estimate. A model adjustment is not evidence of a real edge.</div>
      <div class="weights">${L.FEATURES.map((f, i) => {
        const v = w[i] - L.PRIOR[i], sc = Math.max(-1, Math.min(1, v / 0.5));
        const left = sc >= 0 ? 50 : 50 + sc * 50, width = Math.abs(sc) * 50;
        return `<div class="w-row"><span>${f.name}${i === 1 ? ' (change)' : ''}</span>
          <div class="w-track"><div class="mid"></div><div class="val" style="left:${left}%;width:${width}%;background:${v >= 0 ? COLORS.B : COLORS.P}"></div></div>
          <span class="num">${v >= 0 ? '+' : ''}${v.toFixed(3)}</span></div>`;
      }).join('')}</div>
      <table><tr><th>Forecast claimed</th><th>Hands</th><th>Average chance</th><th>Actually right</th></tr>
        ${st.buckets.map(b => `<tr><td>${pct(b.lo, 0)}–${b.hi > 1 ? '100%' : pct(b.hi, 0)}</td><td>${b.n}</td><td>${b.said == null ? '–' : pct(b.said)}</td><td>${b.hit == null ? '–' : pct(b.hit)}</td></tr>`).join('')}
      </table>
      <div class="note">Chance buckets compare the saved forecast probabilities with observed live results. Joined and replayed hands are excluded.</div>`;
  }

  // Hand log: live forecasts and outcomes, with unscored hands kept for context.
  function renderLog() {
    const range = $('logRange').value;
    let rows = range === 'all' ? S.log : range === 'shoe' ? S.log.filter(e => S.shoe && e.shoe === S.shoe.id) : S.log.slice(-20);
    rows = rows.slice().reverse();
    if (!rows.length) {
      $('logView').innerHTML = `<p class="muted small">${S.joined ? 'No hands yet in this view.'
        : 'Nothing logged yet. Open the game (or Watch a window) to see exact shoe-odds forecasts for upcoming hands.'}</p>`;
      return;
    }
    // Summary of the rows shown: won / lost / push / no pick for each pick.
    const tally = get => {
      const t = { won: 0, lost: 0, push: 0, none: 0 };
      for (const e of rows) {
        const side = !e.joined && !e.replay ? get(e) : null;
        if (!side) t.none++; else if (e.result === 'T') t.push++; else if (side === e.result) t.won++; else t.lost++;
      }
      return t;
    };
    const tm = tally(e => e.pred && e.pred.side);
    const line = (name, t) => `<tr><td>${name}</td><td class="pos">${t.won}</td><td class="neg">${t.lost}</td><td>${t.push}</td><td>${t.none}</td>
      <td><b>${t.won + t.lost ? pct(t.won / (t.won + t.lost), 0) : '–'}</b></td></tr>`;
    const summary = `<table class="log-sum"><tr><th>Out of ${rows.length} hands</th><th>Won</th><th>Lost</th><th>Push</th><th>No pick</th><th>Win rate</th></tr>
      ${line('Forecast', tm)}</table>
      <p class="note">Joined and replayed hands are not scored. Push = Tie (bet returned). Win rate = won ÷ (won + lost).</p>`;
    const verdict = (side, result) => !side ? '' : result === 'T' ? '<span class="muted">push</span>'
      : side === result ? '<span class="mark-ok" title="won">✓</span>' : '<span class="mark-bad" title="lost">✗</span>';
    $('logView').innerHTML = summary + `<table><tr><th>Shoe · hand</th><th>Result</th><th>Forecast</th><th>Cards P | B</th></tr>
      ${rows.map(e => `<tr>
        <td>${e.shoe} · ${e.hand}${e.joined ? ' <small class="muted" title="Already on the roadmap when the app started watching">before you joined</small>'
          : e.replay ? ' <small class="muted" title="Already visible when detected, re-read, or corrected: not scored">unscored</small>' : ''}</td>
        <td><span class="res ${e.result}">${e.result}</span></td>
        <td>${!e.joined && !e.replay && e.pred ? `<span class="res ${e.pred.side}">${e.pred.side}</span> ${verdict(e.pred.side, e.result)} <small class="muted">${pct(e.pred.conf, 0)}${e.pred.sure ? ' ★' : ''}</small>` : '–'}</td>
        <td class="muted">${e.cards ? `${e.cards.P.join(' ')} | ${e.cards.B.join(' ')}`
          : e.noCards ? `<small class="muted" title="Why this hand's cards were not counted">${e.noCards}</small>` : '–'}</td></tr>`).join('')}
    </table>`;
  }
  $('logRange').onchange = renderLog;

  // Walk-forward model test over everything logged so far.
  $('btnEvaluate').onclick = () => {
    const view = $('evalView');
    view.innerHTML = 'Replaying every logged hand…';
    setTimeout(() => {
      const res = E.run(S.log);
      if (!res.handsScored) { view.innerHTML = '<span class="muted">No decided hands logged yet.</span>'; return; }
      const row = m => `<tr>
        <td>${m.name}</td><td>${pct(m.accuracy)}</td><td>${m.logLoss.toFixed(4)}</td><td>${m.brier.toFixed(4)}</td>
        <td class="${m.returnPerBet > 0 ? 'pos' : 'neg'}">${signPct(m.returnPerBet)}</td>
        <td>${m.vsBaseline ? `${m.vsBaseline.gain >= 0 ? '+' : '−'}${Math.abs(m.vsBaseline.gain).toFixed(4)} <small class="muted">(${m.vsBaseline.lo.toFixed(4)} to ${m.vsBaseline.hi.toFixed(4)})</small>` : '–'}</td></tr>`;
      const cal = res.models.map(m => `<div class="muted small">${m.name}: ${m.buckets.sort((a, b) => a.band.localeCompare(b.band))
        .map(b => `${b.band} claimed → ${pct(b.actual)} actual over ${b.n}`).join(' · ')}</div>`).join('');
      view.innerHTML = `<table><tr><th>Model</th><th>Accuracy</th><th>Log loss</th><th>Brier</th><th>Return/bet</th><th>Gain over card odds (95% range)</th></tr>
          ${res.models.map(row).join('')}</table>
        <div class="note"><b>${E.verdict(res)}</b></div>
        <div class="note">${res.handsScored} decided hands across ${res.shoes} shoes (${res.ties} ties excluded, ${res.withCards} hands had their cards read).
          Each hand was predicted before its result was used for training, so none of these scores include a hand the model had already seen.
          A gain whose range crosses zero is indistinguishable from luck.</div>
        ${cal}`;
    }, 20);
  };

  // Score only forecasts actually shown before a live hand.
  function scoreOf(entries, pick) {
    const d = entries.filter(e => pick(e) && e.result !== 'T');
    const won = d.filter(e => pick(e) === e.result).length;
    const last20 = d.slice(-20), w20 = last20.filter(e => pick(e) === e.result).length;
    let run = 0, runType = '';
    for (let i = d.length - 1; i >= 0; i--) {
      const ok = pick(d[i]) === d[i].result;
      if (!runType) runType = ok ? 'W' : 'L';
      if ((ok ? 'W' : 'L') !== runType) break;
      run++;
    }
    return { n: d.length, won, lost: d.length - won, rate: d.length ? won / d.length : null, last20: last20.length ? w20 / last20.length : null, run, runType };
  }
  function renderVersus() {
    const liveLog = S.log.filter(e => !e.replay && !e.joined);
    const m = scoreOf(liveLog, e => e.pred && e.pred.side);
    $('statsBadge').textContent = `${m.n} forecasts scored`;
    const row = (cls, name, s) => `<tr><td><span class="key ${cls}"></span>${name}</td><td>${s.n}</td><td>${s.won}</td><td>${s.lost}</td>
      <td><b>${s.rate == null ? '–' : pct(s.rate)}</b></td><td>${s.last20 == null ? '–' : pct(s.last20, 0)}</td><td>${s.run ? s.runType + s.run : '–'}</td></tr>`;
    $('versus').innerHTML = `
      <table class="vs-table"><tr><th>Pick</th><th>Picks</th><th>Won</th><th>Lost</th><th>Win rate</th><th>Last 20</th><th>Now</th></tr>
        ${row('model', 'Pattern-aware model', m)}</table>
      <div class="note">Only forecasts made before a live hand are scored. Joined mid-shoe hands, re-reads, and ties are excluded. Win rate is a record, not a guarantee of future results.</div>
      <div class="chart" id="vsChart"></div>
      <div class="chart-legend"><span><i class="key model"></i>Pattern-aware model</span><span>- - 50% reference</span></div>`;
    drawVersusChart();
  }
  function drawVersusChart() {
    const box = $('vsChart'); if (!box) return;
    const d = S.log.filter(e => !e.replay && !e.joined && e.result !== 'T' && e.pred);
    if (d.length < 2) { box.innerHTML = '<p class="muted small">The chart appears after a few decided hands.</p>'; return; }
    // running win rate after each decided hand
    let mw = 0, mn = 0;
    const pts = d.map((e, i) => {
      mn++; if (e.pred.side === e.result) mw++;
      return { i, m: mw / mn, e };
    });
    const W = box.clientWidth || 400, H = 150, pl = 34, pr = 96, pt = 10, pb = 20;
    const vals = pts.map(p => p.m);
    let lo = Math.min(0.4, ...vals), hi = Math.max(0.6, ...vals);
    lo = Math.floor(lo * 10) / 10; hi = Math.ceil(hi * 10) / 10;
    const x = i => pl + (pts.length === 1 ? 0 : i / (pts.length - 1)) * (W - pl - pr);
    const y = v => pt + (1 - (v - lo) / (hi - lo)) * (H - pt - pb);
    const path = key => pts.filter(p => p[key] != null).map((p, j) => `${j ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p[key]).toFixed(1)}`).join('');
    const ticks = []; for (let v = lo; v <= hi + 1e-9; v += 0.1) ticks.push(+v.toFixed(1));
    const last = pts[pts.length - 1];
    const ym = y(last.m);
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Running win rate of pattern-aware model forecasts">
      ${ticks.map(v => `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${pl - 6}" y="${y(v) + 3.5}" text-anchor="end">${Math.round(v * 100)}%</text>`).join('')}
      <line class="ref" x1="${pl}" x2="${W - pr}" y1="${y(0.5)}" y2="${y(0.5)}"/>
      <text class="axis" x="${pl}" y="${H - 4}">hand 1</text><text class="axis" x="${W - pr}" y="${H - 4}" text-anchor="end">${pts.length} decided hands</text>
      <path class="ln model" d="${path('m')}"/>
      <text class="lbl" x="${W - pr + 6}" y="${ym + 4}">Model ${pct(last.m, 0)}</text>
      <g id="vsHover" style="display:none"><line class="cross" y1="${pt}" y2="${H - pb}"/><circle class="dot model" r="4"/></g>
      <rect x="${pl}" y="0" width="${W - pl - pr}" height="${H}" fill="transparent" id="vsHit"/>
    </svg><div class="chart-tip" id="vsTip" hidden></div>`;
    const hit = $('vsHit'), g = $('vsHover'), tip = $('vsTip');
    hit.onmousemove = ev => {
      const r = hit.getBoundingClientRect();
      const fx = (ev.clientX - r.left) / r.width;
      const p = pts[Math.max(0, Math.min(pts.length - 1, Math.round(fx * (pts.length - 1))))];
      g.style.display = '';
      const cx = x(p.i);
      g.querySelector('line').setAttribute('x1', cx); g.querySelector('line').setAttribute('x2', cx);
      const dm = g.querySelector('circle');
      if (p.m != null) { dm.setAttribute('cx', cx); dm.setAttribute('cy', y(p.m)); dm.style.display = ''; } else dm.style.display = 'none';
      tip.hidden = false;
      const ty = p.m != null ? y(p.m) : H;
      tip.style.left = Math.max(80, Math.min(W - 80, cx)) + 'px';
      tip.style.top = (ty - 8) + 'px';
      tip.innerHTML = `Shoe ${p.e.shoe} · hand ${p.e.hand} · result ${NAMES[p.e.result]}<br>
        <i class="key model"></i> Model ${p.m == null ? '–' : pct(p.m)}`;
    };
    hit.onmouseleave = () => { g.style.display = 'none'; tip.hidden = true; };
  }

  // Road canvases
  function setupCanvas(c) {
    const dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
    c.width = Math.round(W * dpr); c.height = Math.round(H * dpr);
    const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);
    return { ctx, W, H };
  }
  function grid(ctx, W, H, cell) {
    ctx.strokeStyle = '#e3e5ea'; ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += cell) { ctx.beginPath(); ctx.moveTo(x + .5, 0); ctx.lineTo(x + .5, H); ctx.stroke(); }
    for (let y = 0; y <= H; y += cell) { ctx.beginPath(); ctx.moveTo(0, y + .5); ctx.lineTo(W, y + .5); ctx.stroke(); }
  }
  function drawBead() {
    const { ctx, W, H } = setupCanvas($('beadCanvas')), cell = H / 6, cols = Math.floor(W / cell);
    grid(ctx, W, H, cell);
    const h = S.history, startCol = Math.max(0, Math.ceil(h.length / 6) - cols);
    for (let i = startCol * 6; i < h.length; i++) {
      const c = Math.floor(i / 6) - startCol, r = i % 6, cx = c * cell + cell / 2, cy = r * cell + cell / 2;
      ctx.fillStyle = COLORS[h[i]]; ctx.beginPath(); ctx.arc(cx, cy, cell * 0.4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = `bold ${cell * 0.45}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(h[i], cx, cy + 1);
    }
  }
  // Lays out a sequence like the Big Road: same symbol goes down, a change starts a new column, long runs turn right.
  function bigRoadCells(h) {
    const cells = [], occ = new Set();
    let col = -1, row = 0, last = null, baseCol = -1, prev = null, turned = false, leadingTies = 0;
    for (const x of h) {
      // Ties are drawn as a green line through the previous circle (Ties before any result go on the first circle).
      if (x === 'T') { if (prev) prev.ties++; else leadingTies++; continue; }
      if (x !== last) {
        baseCol++; col = baseCol; row = 0; turned = false;
        while (occ.has(col + ',' + row)) { baseCol++; col = baseCol; }
      } else if (!turned && row < 5 && !occ.has(col + ',' + (row + 1))) row++;
      else { col++; turned = true; }
      occ.add(col + ',' + row);
      prev = { side: x, col, row, ties: cells.length ? 0 : leadingTies }; cells.push(prev); last = x;
    }
    return cells;
  }
  function drawBig() {
    const { ctx, W, H } = setupCanvas($('bigCanvas')), cell = H / 6, cols = Math.floor(W / cell);
    grid(ctx, W, H, cell);
    const cells = bigRoadCells(S.history), maxCol = cells.reduce((m, c) => Math.max(m, c.col), -1), start = Math.max(0, maxCol + 1 - cols);
    for (const c of cells) {
      if (c.col < start) continue;
      const cx = (c.col - start) * cell + cell / 2, cy = c.row * cell + cell / 2;
      ctx.strokeStyle = COLORS[c.side]; ctx.lineWidth = Math.max(1.5, cell * 0.14);
      ctx.beginPath(); ctx.arc(cx, cy, cell * 0.34, 0, Math.PI * 2); ctx.stroke();
      if (c.ties) {
        ctx.strokeStyle = COLORS.T; ctx.lineWidth = Math.max(2, cell * 0.16); ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(cx - cell * .36, cy + cell * .36); ctx.lineTo(cx + cell * .36, cy - cell * .36); ctx.stroke();
        if (c.ties > 1) { ctx.fillStyle = COLORS.T; ctx.font = `bold ${Math.round(cell * 0.45)}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(c.ties, cx + cell * 0.3, cy + cell * 0.3); }
      }
    }
  }

  // Derived roads: red = the Big Road pattern repeats, blue = it breaks.
  const DCOL = { R: '#e5484d', B: '#3e7bfa' };
  function drawDerived(id, k, style) {
    const { ctx, W, H } = setupCanvas($(id)), cell = H / 6, cols = Math.floor(W / cell);
    grid(ctx, W, H, cell);
    const cells = bigRoadCells(B.derivedRoad(S.history, k));
    const maxCol = cells.reduce((m, c) => Math.max(m, c.col), -1), start = Math.max(0, maxCol + 1 - cols);
    for (const c of cells) {
      if (c.col < start) continue;
      const cx = (c.col - start) * cell + cell / 2, cy = c.row * cell + cell / 2, r = cell * 0.36;
      ctx.strokeStyle = ctx.fillStyle = DCOL[c.side];
      ctx.lineWidth = Math.max(1.2, cell * 0.16);
      ctx.beginPath();
      if (style === 'hollow') { ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); }
      else if (style === 'filled') { ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill(); }
      else { ctx.lineWidth = Math.max(1.5, cell * 0.2); ctx.moveTo(cx - r, cy + r); ctx.lineTo(cx + r, cy - r); ctx.stroke(); }
    }
  }
  function renderAsk() {
    const n = B.noTies(S.history).length;
    if (!n) { $('askView').innerHTML = ''; return; }
    const mark = (v, style) => !v ? '<span class="muted">–</span>'
      : style === 'slash' ? `<span class="slash" style="background:${DCOL[v]}"></span>`
      : `<span class="dot ${style === 'hollow' ? 'hollow' : ''}" style="${style === 'hollow' ? 'border-color' : 'background'}:${DCOL[v]}"></span>`;
    const row = x => { const a = B.derivedAsk(S.history, x); return `${mark(a[0], 'hollow')} ${mark(a[1], 'filled')} ${mark(a[2], 'slash')}`; };
    $('askView').innerHTML = `<div><b style="color:#ff8a8d">Banker ask</b> ${row('B')}</div><div><b style="color:#8db0ff">Player ask</b> ${row('P')}</div>`;
  }

  function renderRoadInfo() {
    const el = $('roadInfo'); if (!el) return;
    if (!S.sig) { el.textContent = 'Not reading a roadmap yet.'; return; }
    const now = S.lastRead ? S.lastRead.seq.join('') : '';
    el.innerHTML = `Reading the <b>${S.sig.kind}</b> (cell ${S.sig.pitch.toFixed(0)} px). On screen now: <b>${now || 'empty'}</b>.
      If this does not match the table, try <b>Switch road</b>, or type the true results below and press <b>Fix results</b>.`;
    if (document.activeElement !== $('fixText')) $('fixText').value = S.history.join('');
  }

  function renderAll() { renderRoadInfo(); renderSteps(); renderPrediction(); renderRoadRead(); renderVersus(); renderShoe(); renderLearning(); renderLog(); }
  window.addEventListener('resize', () => { S.sig = null; renderShoe(); });

  // ------------------------------------------------------------------ settings
  $('sureRange').oninput = e => {
    S.settings.sure = +e.target.value; $('sureVal').textContent = pct(S.settings.sure, 0);
    if (S.pending) { computePrediction(); renderPrediction(); }
    scheduleSave();
  };
  $('scanSpeed').onchange = e => { S.settings.interval = +e.target.value; if (S.timer) startLoop(); scheduleSave(); };
  $('showFrames').onchange = e => { S.settings.frames = e.target.checked; drawFrames(); scheduleSave(); };
  $('btnRefind').onclick = () => { delete site().roadBox; S.sig = null; S.roadChoice = 0; scheduleSave(); toast('Looking for the roadmap again…'); };
  // Cycle through the roads found on screen (Bead Plate, Big Road, ...).
  $('btnSwitch').onclick = () => {
    if (!S.frame) return toast('Open the game first.');
    const all = V.findRoad(S.frame, null, true) || [];
    if (!all.length) return toast('No roadmap found on screen.');
    S.roadChoice = ((S.roadChoice || 0) + 1) % all.length;
    delete site().roadBox; S.sig = all[S.roadChoice]; S.sig2 = null;
    toast(`Now reading road ${S.roadChoice + 1} of ${all.length}: the ${S.sig.kind}.`);
  };
  // Type the true results of this shoe when the screen was misread.
  $('btnFix').onclick = () => {
    const seq = $('fixText').value.toUpperCase().replace(/[^BPT]/g, '').split('');
    if (!seq.length) return toast('Type the results, for example BBPBTP.');
    if (!S.joined) { joinShoe(seq); return; }
    const h = S.history;
    let c = 0; while (c < h.length && c < seq.length && h[c] === seq[c]) c++;
    S.events.push({ t: Date.now(), type: 'manual fix', from: h.join(''), to: seq.join('') });
    S.log = S.log.filter(e => !(S.shoe && e.shoe === S.shoe.id && e.hand > c));
    S.history = seq.slice();
    S.maxVisible = Math.max(S.maxVisible, seq.length);
    computePrediction(); renderAll(); scheduleSave();
    toast('Results updated.');
  };
  // Save the full screen, the reader's view with every mark it read, and the details.
  $('btnSnap').onclick = async () => {
    if (!S.frame) return toast('Open the game first.');
    const img = S.frame;
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const ctx = c.getContext('2d');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length), img.width, img.height), 0, 0);
    const png = c.toDataURL('image/png');
    const res = S.sig ? V.readRoadLive(img, S.sig) : null;
    ctx.lineWidth = 2; ctx.font = 'bold 12px sans-serif';
    if (res) {
      if (res.box) { ctx.strokeStyle = '#f5c542'; ctx.strokeRect(res.box.x, res.box.y, res.box.width, res.box.height); }
      res.marks.forEach((m, i) => {
        ctx.strokeStyle = m.side === 'B' ? '#ff00ff' : m.side === 'P' ? '#00ffff' : '#00ff00';
        ctx.strokeRect(m.minX - 1, m.minY - 1, m.w + 2, m.h + 2);
        ctx.fillStyle = '#000'; ctx.fillText(String(i + 1), m.minX, m.minY - 2);
      });
    }
    if (S.cards.box) { ctx.strokeStyle = '#5fd49a'; ctx.strokeRect(S.cards.box.x, S.cards.box.y, S.cards.box.width, S.cards.box.height); }
    const info = { time: new Date().toISOString(), mode: S.mode, site: S.host, source: S.sourceName || null,
      road: S.sig ? { kind: S.sig.kind, x: S.sig.x0, y: S.sig.y0, cell: S.sig.pitch, mark: S.sig.d } : null,
      readNow: res ? res.seq.join('') : null, history: S.history.join(''), frame: `${img.width}x${img.height}`,
      events: S.events.slice(-20) };
    const dir = await bridge.saveSnapshot({ png, overlay: c.toDataURL('image/png'), info });
    toast('Snapshot saved. Opening the folder…');
    bridge.openPath(dir);
  };
  $('btnRecal').onclick = () => { if (site().cards) site().cards.ready = false; S.cards.snoozeUntil = 0; setStep('Cards', '', 'Waiting for a hand to finish'); scheduleSave(); };
  $('btnResetModel').onclick = () => {
    if (!confirm('Reset what the model has learned? The hand log is kept.')) return;
    S.model = L.createModel(null);
    computePrediction(); renderAll(); scheduleSave();
  };
  // ---- move the learning to another computer (through the project folder / GitHub)
  $('btnLearnExport').onclick = async () => {
    const file = await bridge.exportLearning({ version: 2, exportedAt: new Date().toISOString(),
      log: S.log, model: S.model, sites: S.sites, settings: { sure: S.settings.sure, lastSource: S.settings.lastSource } });
    toast(`Exported ${S.log.length} hands and the learned model. Now push the project to GitHub.`);
    console.log('learning exported to', file);
  };
  $('btnLearnImport').onclick = async () => {
    const { file, data } = await bridge.importLearning();
    if (!data || !Array.isArray(data.log)) return toast('No learning data found. Export it on the other computer, push, then pull here.');
    if (!confirm(`Import ${data.log.length} hands and the learned model (${data.model ? data.model.n : 0} live hands learned)?`)) return;
    // Merge hands (no duplicates); keep whichever model has learned from more live hands.
    const key = e => `${e.t}|${e.shoe}|${e.hand}|${e.result}`;
    const have = new Set(S.log.map(key));
    const added = data.log.filter(e => !have.has(key(e)));
    S.log = S.log.concat(added).sort((a, b) => a.t - b.t);
    if (data.model && (data.model.n || 0) >= (S.model.n || 0)) S.model = L.createModel(data.model);
    for (const [host, cfg] of Object.entries(data.sites || {})) if (!S.sites[host]) S.sites[host] = cfg;
    if (data.settings && data.settings.lastSource && !S.settings.lastSource) S.settings.lastSource = data.settings.lastSource;
    computePrediction(); renderAll(); await saveNow();
    toast(`Imported ${added.length} new hands and the learned model.`);
  };

  $('btnExport').onclick = () => {
    const head = 'time,site,shoe,hand,forecast,confidence,strong_lean,shoe_math_banker,result,outcome,player_cards,banker_cards';
    const rows = S.log.map(e => [new Date(e.t).toISOString(), e.site, e.shoe, e.hand, e.pred && !e.joined && !e.replay ? e.pred.side : '', e.pred && !e.joined && !e.replay ? e.pred.conf : '',
      e.pred && !e.joined && !e.replay ? e.pred.sure : '', e.pred && !e.joined && !e.replay ? e.pred.mathQ : '', e.result, e.result === 'T' || !e.pred || e.joined || e.replay ? 'push' : e.correct ? 'won' : 'lost',
      e.cards ? e.cards.P.join(' ') : '', e.cards ? e.cards.B.join(' ') : ''].join(','));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([head + '\n' + rows.join('\n')], { type: 'text/csv' }));
    a.download = 'baccarat-log.csv'; a.click();
  };

  // Simulation (shows that roadmap patterns do not beat the house edge)
  let simRunning = false;
  $('btnSim').onclick = () => {
    if (simRunning) return;
    const shoes = Math.max(100, Math.min(50000, +$('simShoes').value || 2000));
    simRunning = true; $('btnSim').disabled = true;
    const prog = $('simProgress'); prog.hidden = false;
    const rng = B.mulberry32((Date.now() & 0xffffffff) >>> 0);
    const keys = Object.keys(B.STRATEGIES);
    const agg = {}; keys.forEach(k => (agg[k] = { bets: 0, wins: 0, losses: 0, net: 0, profitShoes: 0 }));
    let done = 0;
    const step = () => {
      const until = Math.min(shoes, done + 100);
      for (; done < until; done++) {
        const seq = B.dealShoe(rng);
        for (const k of keys) {
          const r = B.backtest(k, seq), a = agg[k];
          a.bets += r.bets; a.wins += r.wins; a.losses += r.losses; a.net += r.net; if (r.net > 0) a.profitShoes++;
        }
      }
      prog.firstElementChild.style.width = (done / shoes * 100) + '%';
      if (done < shoes) return setTimeout(step, 0);
      simRunning = false; $('btnSim').disabled = false; prog.hidden = true;
      $('simResult').innerHTML = `<table><tr><th>Method</th><th>Win rate</th><th>Return</th><th>Shoes won</th></tr>
        ${keys.map(k => { const a = agg[k]; return `<tr><td>${B.STRATEGIES[k].name}</td><td>${pct(a.wins / (a.wins + a.losses))}</td>
          <td class="${a.net > 0 ? 'pos' : 'neg'}">${(a.net / a.bets * 100).toFixed(2)}%</td><td>${pct(a.profitShoes / shoes, 0)}</td></tr>`; }).join('')}
        </table><p class="note">${shoes.toLocaleString()} shoes. Every method settles near the house edge. Gaps between them are luck.</p>`;
    };
    step();
  };

  // ------------------------------------------------------------------ start
  (async function init() {
    if (!bridge) {
      document.body.innerHTML = '<p style="padding:24px">Run this app with <b>npm start</b> (or start.bat). It needs the desktop app to open the game.</p>';
      return;
    }
    await loadAll();
    S.seeds = makeSeeds();
    $('sureRange').value = S.settings.sure; $('sureVal').textContent = pct(S.settings.sure, 0);
    $('scanSpeed').value = String(S.settings.interval);
    $('showFrames').checked = S.settings.frames;
    if (S.lastUrl) $('startInput').value = S.lastUrl;
    if (S.settings.lastSource) {
      $('startWatchAgain').hidden = false;
      $('startWatchAgainName').textContent = S.settings.lastSource;
    }
    renderAll();
    $('startInput').focus();
    window.__bp.ready = true;
    if (S.cleanedUp) toast('Your old log had misread hands, so it was backed up and learning starts fresh.');
    // Measure streak and ping-pong behaviour once, in the background.
    setTimeout(() => { runTable = B.runStats(6000, 2024); renderRoadRead(); }, 300);
  })();

  // Exposed for the automated self-test
  window.__bp = { S, computePrediction, onRoadRead, openUrl, cardsReady, openPicker, startWindowMode, openAdjust, readBoxed, site, setAdjust: r => { adj.css = r; placeAdjust(); }, get calib() { return calib; } };
})();
