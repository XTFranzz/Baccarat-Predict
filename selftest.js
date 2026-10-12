// Automated end-to-end check against test/fake-table.html.
// Run with:  npm run selftest   (uses a throwaway data folder when BP_USERDATA is set)
const { app, webContents, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const wait = ms => new Promise(r => setTimeout(r, ms));

module.exports = async function selftest(win) {
  const out = process.env.BP_SELFTEST_OUT || path.join(__dirname, 'test');
  const log = (...a) => console.log('[selftest]', ...a);
  const js = code => win.webContents.executeJavaScript(code);
  const shot = async name => fs.writeFileSync(path.join(out, `selftest-${name}.png`), (await win.webContents.capturePage()).toPNG());
  const until = async (label, cond, ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (await cond()) return Date.now() - t0; await wait(500); }
    throw new Error('timed out waiting for ' + label);
  };
  win.webContents.on('console-message', e => { if (e.level === 'error' || e.level === 3) log('renderer error:', e.message); });

  try {
    await new Promise(r => win.webContents.once('did-finish-load', r));
    await until('app ready', () => js('!!(window.__bp && window.__bp.ready)'), 15000);
    if (process.env.BP_SYNCTEST) {
      await js('window.confirm = () => true; true');
      await js(`document.getElementById('${process.env.BP_SYNCTEST === 'export' ? 'btnLearnExport' : 'btnLearnImport'}').click(); true`);
      await wait(1500);
      log('sync', process.env.BP_SYNCTEST, await js('JSON.stringify({ log: window.__bp.S.log.length, modelN: window.__bp.S.model.n, toast: document.getElementById("toast").innerText })'));
      app.quit(); return;
    }
    if (process.env.BP_SHOTLOG) {
      await js(`document.getElementById('logView').scrollIntoView(); true`);
      await wait(500); await shot('logsummary'); app.quit(); return;
    }
    if (process.env.BP_CLOSETEST) {
      // Add a hand and close at once (before the normal delayed save could run).
      await js(`window.__bp.S.log.push({ t: Date.now(), shoe: 99, hand: 1, result: 'B', closeTest: true }); true`);
      win.close();
      return;
    }
    const interval = +(process.env.BP_INTERVAL || 1000);
    const params = 'start=20&hands=26&cycle=' + (process.env.BP_CYCLE || 4000) + '&shuffle=7000&seed=' + (process.env.BP_SEED || 77) + (process.env.BP_BEAD === '0' ? '&bead=0' : '') + (process.env.BP_ZOOM ? '&zoom=' + process.env.BP_ZOOM : '') + (process.env.BP_KEEPCARDS ? '&keepcards=1' : '');
    const url = pathToFileURL(path.join(__dirname, 'test', 'fake-table.html')).href + '?' + params;
    let guest;
    if (process.env.BP_SELFTEST_MODE === 'window') {
      // Simulates the user's own browser: the table runs in a separate window and the app watches it.
      const wa = require('electron').screen.getPrimaryDisplay().workArea;
      log('screen work area', JSON.stringify(wa));
      const fake = new BrowserWindow({ width: Math.min(1000, wa.width - 480), height: Math.min(820, wa.height), x: wa.x, y: wa.y, title: 'Fake Live Baccarat',
        webPreferences: { backgroundThrottling: false } });
      await fake.loadURL(url);
      guest = fake.webContents;
      await wait(800);
      const started = await js(`(async () => {
        window.__bp.S.settings.interval = ${interval};
        await window.__bp.openPicker();
        const s = window.__bp.S.sources.find(x => x.name.includes('Fake Live Baccarat'));
        if (!s) return 'window not found among: ' + window.__bp.S.sources.map(x => x.name).join(' | ');
        return await window.__bp.startWindowMode(s);
      })()`);
      log('watch-a-window started:', started);
      await wait(500); fake.focus(); // like clicking on the browser window after the app moves aside
      setTimeout(async () => log('after 20 s:', await js('JSON.stringify({ scans: window.__bp.S.scanCount, fresh: window.__bp.S.freshFrames, captureMs: window.__bp.S.captureMs, scanMs: window.__bp.S.scanMs })')), 20000);
      for (let i = 0; i < 4; i++) {
        await wait(1000);
        log('state', await js(`JSON.stringify({ mode: window.__bp.S.mode, vw: document.getElementById('shareVideo').videoWidth, vh: document.getElementById('shareVideo').videoHeight, start: document.getElementById('startScreen').hidden, frame: window.__bp.S.frame && window.__bp.S.frame.width, ready: window.__bp.ready })`));
      }
    } else {
      await js(`window.__bp.S.settings.interval = ${interval}; window.__bp.openUrl(${JSON.stringify(url)}); true`);
      await until('table loaded', async () => (guest = webContents.getAllWebContents().find(w => w.getType() === 'webview' && w.getURL().includes('fake-table'))), 15000);
    }
    const T = code => guest.executeJavaScript(code);

    if (process.env.BP_BOX_FIRST) {
      // The user places the box before anything is read; Done must fill the shoe right away.
      await until('first frame', () => js('!!window.__bp.S.frame'), 15000);
      const which = process.env.BP_BOX_FIRST; // 'bead' or 'big'
      const r = await T(`(() => { const r = document.getElementById('roads').getBoundingClientRect();
        return '${which}' === 'big' ? { x: r.x + 296, y: r.y - 4, width: 560, height: 152 } : { x: r.x - 4, y: r.y - 4, width: 296, height: 152 }; })()`);
      await js(`window.__bp.openAdjust(); window.__bp.setAdjust(${JSON.stringify(r)}); true`);
      await wait(600);
      log('box preview:', (await js("document.getElementById('adjustRead').innerText")).split(String.fromCharCode(10)).join(' '));
      await js("document.getElementById('adjustDone').click(); true");
      await wait(300);
      const hist = await js('window.__bp.S.history.join("")');
      const tr = await T('truth.shoes[0].hands.map(h => h.result).join("")');
      log('box first: shoe after Done', hist, tr.startsWith(hist) && hist.length ? 'OK (matches the table)' : 'MISMATCH vs ' + tr);
      log('box status:', await js("document.getElementById('boxStatus').innerText"));
      log('box saved under:', await js("JSON.stringify({ host: window.__bp.S.host, sites: Object.keys(window.__bp.S.sites), box: !!window.__bp.site().roadBox })"));
      log('box marks:', await js("JSON.stringify(window.__bp.S.lastRead && window.__bp.S.lastRead.marks.map(m => m.col + ',' + m.row + m.side))"));
      if (process.env.BP_QUICK) {
        await wait(6000);
        log('sim training:', await js("document.getElementById('simTrainInfo').textContent"));
        log('main card:', await js("document.querySelector('#prediction .title').textContent + ' | ' + document.querySelector('#prediction .big .muted').textContent"));
        await js(`document.getElementById('prediction').scrollIntoView(); true`); await wait(400); await shot('quick-prediction');
        app.quit(); return;
      }
    }

    // 1. Joined mid-shoe: roadmap found automatically and history read
    const tJoin = await until('roadmap read', () => js('window.__bp.S.joined'), 20000);
    const joinedHist = await js('window.__bp.S.history.join("")');
    const truthAtJoin = await T('truth.shoes[0].hands.map(h => h.result).join("")');
    log(`roadmap found in ${tJoin} ms as`, await js('window.__bp.S.sig.kind'));
    log('joined history', joinedHist, joinedHist === truthAtJoin.slice(0, joinedHist.length) ? 'OK' : 'MISMATCH vs ' + truthAtJoin);
    const joinScores = await js(`(() => {
      const joined = window.__bp.S.log.filter(e => e.joined);
      const stats = Learner.stats(window.__bp.S.log);
      return { count: joined.length, invalidPicks: joined.filter(e => e.pred || e.road).length, scored: stats.decided + stats.roadN };
    })()`);
    if (!joinScores.count || joinScores.invalidPicks || joinScores.scored) throw new Error('mid-shoe join hands were incorrectly predicted or scored: ' + JSON.stringify(joinScores));
    log('joined hands excluded from picks and scores', JSON.stringify(joinScores), 'OK');

    await js(`window.__bp.openAdjust('cards'); true`);
    await wait(100);
    const cardAdjust = await js(`(() => {
      const panel = document.getElementById('adjust'), box = document.getElementById('adjustBox'), r = box.getBoundingClientRect();
      return { hidden: panel.hidden, cardsMode: panel.classList.contains('adjust-cards'), width: r.width, height: r.height,
        visibility: getComputedStyle(box).visibility, display: getComputedStyle(box).display };
    })()`);
    if (cardAdjust.hidden || !cardAdjust.cardsMode || cardAdjust.width < 30 || cardAdjust.height < 20 ||
      cardAdjust.visibility === 'hidden' || cardAdjust.display === 'none')
      throw new Error('card adjustment box was not visible: ' + JSON.stringify(cardAdjust));
    log('card adjustment box forced visible', JSON.stringify(cardAdjust), 'OK');
    await js("document.getElementById('adjustCancel').click(); true");

    if (process.env.BP_BOX) {
      // Use the adjustable box: open adjust mode (starts around the detected road), screenshot, confirm.
      await js('window.__bp.openAdjust(); true');
      await wait(800);
      log('adjust preview:', await js("document.getElementById('adjustRead').innerText"));
      await shot('adjust');
      await js("document.getElementById('adjustDone').click(); true");
      log('box saved:', await js('JSON.stringify(window.__bp.site().roadBox)'));
    }

    // 2. One-time card setup appears by itself
    await until('card setup prompt', () => js('!!window.__bp.calib'), 40000);
    const c = JSON.parse(await js('JSON.stringify({ ranks: window.__bp.calib.ranks, t: window.__bp.calib.t, nLeft: window.__bp.calib.found.left.length })'));
    const shownNow = JSON.parse(await T(`JSON.stringify(truth.shown.filter(h => h.from <= ${c.t} && h.to + 1500 >= ${c.t}).slice(-1)[0] || null)`));
    log('setup read cards', JSON.stringify(c.ranks), 'on screen', JSON.stringify(shownNow));
    await shot('setup');
    if (shownNow) {
      const want = shownNow.P.concat(shownNow.B);
      const sorted = a => a.slice().sort().join(',');
      const readP = c.ranks.slice(0, c.nLeft), readB = c.ranks.slice(c.nLeft);
      const fine = sorted(readP) === sorted(shownNow.P) && sorted(readB) === sorted(shownNow.B);
      log('setup reading', fine ? 'correct' : 'wrong, correcting it like a user would');
      if (!fine && want.length === c.ranks.length) {
        // The dropdowns follow the card order on screen; fill Player then Banker with the true ranks.
        await js(`(() => { const sel = [...document.querySelectorAll('#calibP select'), ...document.querySelectorAll('#calibB select')];
          const want = ${JSON.stringify(want)}; sel.forEach((s, i) => { s.value = want[i]; s.dispatchEvent(new Event('change')); }); return true; })()`);
      }
    }
    const ok = await js(`!document.getElementById('calibOk').disabled`);
    if (!ok) log('setup hand failed the rules check');
    await js(`document.getElementById(${ok ? "'calibOk'" : "'calibLater'"}).click(); true`);
    const cardsStatus = await js("document.querySelector('#stepCards span').innerText");
    if (/tracking every card/i.test(cardsStatus)) throw new Error('card setup status falsely claims live tracking: ' + cardsStatus);
    log('card setup status reports live state, not setup alone:', cardsStatus);
    const trained = JSON.parse(await js(`JSON.stringify({
      ready: window.__bp.cardsReady(),
      version: window.__bp.site().cards.templateVersion,
      count: window.__bp.site().cards.templates.length,
      ranks: [...new Set(window.__bp.site().cards.templates.map(t => t.rank))]
    })`));
    // cardsReady() already holds the templates to the version the app reads today.
    if (!trained.ready || !trained.version || !trained.count)
      throw new Error('confirmed card ranks were not saved as current site templates: ' + JSON.stringify(trained));
    log('confirmed ranks saved as site templates:', JSON.stringify(trained));
    const setupDone = Date.now();

    // 3. Play through the shuffle into a new shoe
    await until('shuffle + 6 hands of new shoe', () => T('truth.shoes.length >= 2 && truth.shoes[1].hands.length >= 6'), 150000);
    await wait(4500); // the newest result needs two identical reads before it is accepted
    const S = JSON.parse(await js(`JSON.stringify({hist: window.__bp.S.history.join(''), shoe: window.__bp.S.shoe, log: window.__bp.S.log})`));
    log('shoe events now', await js('JSON.stringify(window.__bp.S.events.map(e => ({ type: e.type, seq: e.seq, from: e.from, to: e.to })))'));
    const truth2 = JSON.parse(await T('JSON.stringify(truth.shoes[1].hands)'));
    const truth1 = JSON.parse(await T('JSON.stringify(truth.shoes[0].hands)'));
    log('new shoe history', S.hist, 'truth', truth2.map(h => h.result).join(''), S.hist === truth2.map(h => h.result).join('') ? 'OK' : 'MISMATCH');
    log('shoe', S.shoe.id, 'counting from start:', S.shoe.fromStart, 'cards seen', S.shoe.cardsSeen, 'hands with cards', S.shoe.handsWithCards);

    // 4. Card reading accuracy over every logged hand
    const sort = a => a.slice().sort().join(',');
    let withCards = 0, right = 0, total = 0;
    const shoeIds = [...new Set(S.log.map(e => e.shoe))].sort((a, b) => a - b);
    for (const e of S.log) {
      const tr = (e.shoe === shoeIds[0] ? truth1 : truth2)[e.hand - 1];
      if (!tr) continue;
      total++;
      if (!e.cards) {
        const near = JSON.parse(await js(`JSON.stringify(window.__bp.S.debug.filter(d => Math.abs(d.t - ${e.t}) < 4000))`));
        log('  no cards on shoe', e.shoe, 'hand', e.hand, 'truth', JSON.stringify({ P: tr.P, B: tr.B }), 'scans:', 'entry epoch', e.epoch, near.map(d => `e${d.epoch} h${d.hist} ` + (d.hand ? `${d.n}c P[${d.hand.p}] B[${d.hand.b}] ${d.hand.readable ? 'readable' : 'unclear'} ${d.hand.valid ? d.hand.res : 'invalid'}` : `${d.n}c unread ${JSON.stringify(d.failed)}`)).join(' / '));
        continue;
      }
      withCards++;
      if (sort(e.cards.P) === sort(tr.P) && sort(e.cards.B) === sort(tr.B)) right++;
      else {
        const near = JSON.parse(await js(`JSON.stringify(window.__bp.S.debug.filter(d => Math.abs(d.t - ${e.t}) < 5000))`));
        log('  wrong cards on shoe', e.shoe, 'hand', e.hand, JSON.stringify(e.cards), 'truth', JSON.stringify({ P: tr.P, B: tr.B }), 'entry epoch', e.epoch,
          near.map(d => `e${d.epoch} h${d.hist} ` + (d.hand ? `${d.n}c P[${d.hand.p}] B[${d.hand.b}] ${d.hand.valid ? d.hand.res : 'invalid'}` : d.n + 'c none')).join(' / '));
      }
    }
    log(`logged hands ${S.log.length}, with cards ${withCards}/${total}, cards exactly right ${right}/${withCards}`);
    const after = S.log.filter(e => e.t > setupDone + 1500);
    log(`after setup: ${after.filter(e => e.cards).length}/${after.length} hands had cards recorded`);
    const why = {}; for (const e of after) { const k = e.cards ? (e.cards.roadConfirmed ? 'cards (confirmed by roadmap)' : 'cards') : (e.noCards || 'no reason'); why[k] = (why[k] || 0) + 1; }
    log('after setup by outcome:', JSON.stringify(why));
    log('marks debug:', await js(`(() => { const S = window.__bp.S; const r = RoadVision.readRoadLive(S.frame, S.sig);
      return JSON.stringify({ sig: { x0: S.sig.x0, y0: S.sig.y0, d: S.sig.d, pitch: +S.sig.pitch.toFixed(2), fill: +S.sig.fill.toFixed(2) }, seq: r.seq.join(''), marks: r.marks.map(m => m.col + ',' + m.row + m.side + '@' + Math.round(m.cx) + ',' + m.minY) }); })()`));
    log('timing:', await js("JSON.stringify({ sinceScanStart: Date.now() - window.__bp.S.scanStarted, scanning: window.__bp.S.scanning, sinceLastScan: Date.now() - (window.__bp.S.lastScanAt || 0), sinceRoad: Date.now() - (window.__bp.S.lastRoadAt || 0), captureMs: window.__bp.S.captureMs, scanMs: window.__bp.S.scanMs, simTraining: !!document.getElementById('btnSimTrain').disabled })"));
    log('scan errors:', await js("(window.__bp.S.errorCount || 0) + ' ' + (window.__bp.S.lastError || '')"));
    log('road debug:', await js(`JSON.stringify({ readNow: window.__bp.S.lastRead && window.__bp.S.lastRead.seq.join(''), history: window.__bp.S.history.join(''),
      pending: window.__bp.S.pendingRoadKey, kind: window.__bp.S.sig && window.__bp.S.sig.kind, check: window.__bp.S.sig2 && window.__bp.S.sig2.kind,
      disagree: window.__bp.S.roadDisagree, box: !!window.__bp.site().roadBox, road: document.querySelector('#stepRoad span').textContent })`));
    log('card status now:', await js("document.querySelector('#stepCards span').textContent"));
    log('shoe events', JSON.stringify(JSON.parse(await js('JSON.stringify(window.__bp.S.events)')).map(e => ({ ...e, t: undefined }))));
    const counted = S.log.filter(e => e.shoe === S.shoe.id && e.cards).reduce((n, e) => n + e.cards.P.length + e.cards.B.length, 0);
    log('count check: cards in log', counted, 'vs shoe counter', S.shoe.cardsSeen, counted === S.shoe.cardsSeen ? 'OK' : 'MISMATCH');
    log('captures', await js('JSON.stringify({ scans: window.__bp.S.scanCount, failed: window.__bp.S.captureFails || 0, fresh: window.__bp.S.freshFrames })'));
    log('scan processing time', await js('window.__bp.S.scanMs'), 'ms, frame', await js('window.__bp.S.frame.width + "x" + window.__bp.S.frame.height'));
    const forecastCheck = await js(`(() => {
      const forecasts = window.__bp.S.log.filter(e => e.pred && !e.joined && !e.replay);
      const headline = document.querySelector('#prediction .title')?.innerText || '';
      return { count: forecasts.length,
        badSides: forecasts.filter(e => e.pred.side !== (e.pred.modelQ >= 0.5 ? 'B' : 'P')).length,
        missingModelProbability: forecasts.filter(e => !Number.isFinite(e.pred.modelQ)).length,
        roadmapComparisons: forecasts.filter(e => e.road).length,
        headline: headline };
    })()`);
    // The headline always names a next-hand side once 4 results are on the roadmap (the evidence gate is
    // shown underneath as the edge check); before that it says how many hands it is still watching for.
    if (forecastCheck.badSides || forecastCheck.missingModelProbability || !forecastCheck.roadmapComparisons ||
        !/^(Next hand: (Banker|Player)|Watching the shoe: \d of \d hands)$/.test(forecastCheck.headline))
      throw new Error('logged forecast or displayed next-hand headline is invalid: ' + JSON.stringify(forecastCheck));
    log('pattern-aware model forecasts', JSON.stringify(forecastCheck), 'OK; model hands', await js('window.__bp.S.model.n'));

    await shot('window');
    for (const id of ['prediction', 'versus', 'logView']) {
      await js(`document.getElementById('${id}').scrollIntoView(); true`);
      await wait(300);
      await shot(id);
    }
    const files = fs.readdirSync(path.join(app.getPath('userData'), 'data'));
    log('saved data files', files.join(', '));
  } catch (e) {
    console.error('[selftest] FAILED', e);
    try {
      log('debug sig', await js('JSON.stringify(window.__bp.S.sig)'));
      log('debug road groups', await js('(() => { const d = []; RoadVision.findRoad(window.__bp.S.frame, d); return JSON.stringify(d); })()'));
      log('debug read', await js('window.__bp.S.sig ? JSON.stringify(RoadVision.readRoadLive(window.__bp.S.frame, window.__bp.S.sig).seq.join("")) : "no sig"'));
      log('debug history', await js('window.__bp.S.history.join("") + " joined=" + window.__bp.S.joined'));
    } catch (err) { log('debug failed', String(err)); }
    try { await shot('failed'); } catch { /* ignore */ }
  }
  app.quit();
};
