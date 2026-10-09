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
  app.quit();
});
