// Runs the card-reading benchmark:  npx electron test/bench-main.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, webPreferences: { contextIsolation: false } });
  await w.loadFile(path.join(__dirname, 'glyph-bench.html'));
  for (const [label, learn] of [['seeds only', null], ['after setup hand', ['5', '5', '10', 'J', '10', 'A']]]) {
    const r = await w.webContents.executeJavaScript(`runBench(${JSON.stringify(learn)})`);
    console.log('==', label);
    for (const [f, v] of Object.entries(r)) console.log(' ', f.padEnd(22), String(v.acc).padStart(5) + '%', v.wrong);
  }
  await w.loadFile(path.join(__dirname, 'live-cards-bench.html'));
  const live = await w.webContents.executeJavaScript('runLive()');
  console.log('== live-stream card faces (rank beside suit)');
  for (const [k, v] of Object.entries(live)) {
    if (!k.endsWith('.png')) continue;
    console.log(' ', k.padEnd(26), 'truth', v.truth.padEnd(14), 'read', v.read);
    console.log('   ', JSON.stringify(v.detail));
  }
  for (const [k, v] of Object.entries(live)) {
    if (k.endsWith('.png')) continue;
    console.log('  overlay', k.padEnd(8), String(v.acc).padStart(5) + '%', 'of', v.read,
      v.scenesNotFound ? `(${v.scenesNotFound} scenes not detected)` : '', v.wrong);
  }
  app.quit();
});
