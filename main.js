// Electron main process: hosts the app window and captures the casino view on request.
const { app, BrowserWindow, ipcMain, webContents, session, desktopCapturer, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// Present as normal Chrome so casino sites don't block the embedded browser.
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/' + process.versions.chrome + ' Safari/537.36';

function createWindow() {
  const win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0f1115',
    title: 'Baccarat Predict',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile('index.html');
  return win;
}

if (process.env.BP_USERDATA) app.setPath('userData', process.env.BP_USERDATA);

// Make the built-in browser look less like an automated/embedded browser (helps some logins and captchas).
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');

app.whenReady().then(() => {
  // The casino lives in its own persistent session so logins survive restarts.
  const casino = session.fromPartition('persist:casino');
  casino.setUserAgent(CHROME_UA);
  // Keep the browser "client hints" consistent with the Chrome user agent.
  const major = process.versions.chrome.split('.')[0];
  casino.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders;
    for (const k of Object.keys(h)) if (k.toLowerCase() === 'sec-ch-ua') h[k] = `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not=A?Brand";v="99"`;
    cb({ requestHeaders: h });
  });
  // Allow media (video/audio) and fullscreen for live dealer streams.
  casino.setPermissionRequestHandler((wc, permission, cb) => {
    cb(['media', 'fullscreen', 'autoplay'].includes(permission));
  });

  // Popups (many casinos open the game table in a new window) are kept inside the webview.
  app.on('web-contents-created', (_e, wc) => {
    if (wc.getType() === 'webview') {
      wc.setWindowOpenHandler(({ url }) => {
        wc.loadURL(url);
        return { action: 'deny' };
      });
    }
  });

  // A capture must never hang the reading loop.
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('capture timed out')), ms))]);

  // Capture the casino view as raw RGBA pixels. If capturing the embedded view fails (this can happen
  // while the page is being composited), capture the app window and cut out the game area instead.
  ipcMain.handle('capture', async (e, { id, rect, hostRect }) => {
    const toRect = r => r && {
      x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)),
      width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)),
    };
    let img = null;
    const wc = webContents.fromId(id);
    try {
      if (wc && !wc.isDestroyed()) img = await withTimeout(wc.capturePage(toRect(rect)), 2500);
    } catch (err) { img = null; if (process.env.BP_SELFTEST) console.log('[capture] view failed:', err.message); }
    if ((!img || img.isEmpty()) && hostRect) {
      try { img = await withTimeout(e.sender.capturePage(toRect(hostRect)), 2500); } catch (err) { img = null; if (process.env.BP_SELFTEST) console.log('[capture] window failed:', err.message); }
    }
    if (!img || img.isEmpty()) { if (process.env.BP_SELFTEST) console.log('[capture] empty image', img ? JSON.stringify(img.getSize()) : 'null'); return null; }
    const { width, height } = img.getSize();
    const bgra = img.toBitmap();
    for (let i = 0; i < bgra.length; i += 4) { const t = bgra[i]; bgra[i] = bgra[i + 2]; bgra[i + 2] = t; }
    return { width, height, data: bgra };
  });

  // Simple JSON storage in the app's data folder (history log, learned model, per-site setup).
  const dataDir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const safe = name => String(name).replace(/[^a-z0-9_-]/gi, '_');
  ipcMain.handle('data:load', (_e, name) => {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, safe(name) + '.json'), 'utf8')); } catch { return null; }
  });
  ipcMain.handle('data:save', (_e, name, value) => {
    const file = path.join(dataDir, safe(name) + '.json');
    fs.writeFileSync(file + '.tmp', JSON.stringify(value));
    fs.renameSync(file + '.tmp', file);
    return true;
  });
  ipcMain.handle('data:dir', () => dataDir);
  // Final save while the window closes (synchronous, so it finishes before the app exits).
  ipcMain.on('data:saveAllSync', (e, all) => {
    try {
      for (const [name, value] of Object.entries(all)) {
        const file = path.join(dataDir, safe(name) + '.json');
        fs.writeFileSync(file + '.tmp', JSON.stringify(value));
        fs.renameSync(file + '.tmp', file);
      }
      e.returnValue = true;
    } catch { e.returnValue = false; }
  });

  // Snapshot of what the reader sees, so a misread can be checked (and sent to the developer).
  ipcMain.handle('snapshot:save', (_e, { png, overlay, info }) => {
    const dir = path.join(dataDir, 'snapshots');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const write = (name, dataUrl) => fs.writeFileSync(path.join(dir, `${stamp}-${name}.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
    write('screen', png);
    write('reader', overlay);
    fs.writeFileSync(path.join(dir, `${stamp}-info.json`), JSON.stringify(info, null, 2));
    return dir;
  });
  ipcMain.handle('shell:open', (_e, p) => shell.openPath(p));

  // Learning data shared through the project folder (so it can go to GitHub and onto another computer).
  const learningFile = path.join(__dirname, 'learning-data', 'baccarat-learning.json');
  ipcMain.handle('learning:export', (_e, data) => {
    fs.mkdirSync(path.dirname(learningFile), { recursive: true });
    fs.writeFileSync(learningFile, JSON.stringify(data, null, 1));
    return learningFile;
  });
  ipcMain.handle('learning:import', () => {
    try { return { file: learningFile, data: JSON.parse(fs.readFileSync(learningFile, 'utf8')) }; }
    catch { return { file: learningFile, data: null }; }
  });

  // ---- Watch-a-window mode: read the casino from the user's own browser window ----
  let chosenSource = null;
  ipcMain.handle('sources:list', async () => {
    const all = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 320, height: 200 } });
    return all.filter(s => !/^Baccarat Predict/.test(s.name))
      .map(s => ({ id: s.id, name: s.name, thumb: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(), screen: s.id.startsWith('screen') }));
  });
  ipcMain.handle('sources:choose', (_e, id) => { chosenSource = id; return true; });
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    const all = await desktopCapturer.getSources({ types: ['window', 'screen'] });
    const src = all.find(s => s.id === chosenSource);
    if (src) cb({ video: src }); else cb({});
  });

  // Compact mode: the app becomes a narrow panel on the right edge so the watched browser stays visible
  // (a fully covered browser window stops redrawing, which would freeze the picture the app reads).
  let fullBounds = null;
  ipcMain.handle('window:compact', (e, on) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return false;
    if (on) {
      if (!fullBounds) fullBounds = w.getBounds();
      const wa = screen.getDisplayMatching(w.getBounds()).workArea;
      w.setMinimumSize(380, 500);
      w.setBounds({ x: wa.x + wa.width - 470, y: wa.y, width: 470, height: wa.height });
      w.setAlwaysOnTop(true, 'floating');
    } else {
      w.setAlwaysOnTop(false);
      w.setMinimumSize(1100, 700);
      if (fullBounds) w.setBounds(fullBounds);
      fullBounds = null;
    }
    return true;
  });
  ipcMain.handle('screen:workArea', e => screen.getDisplayMatching(BrowserWindow.fromWebContents(e.sender).getBounds()).workArea);

  const win = createWindow();
  if (process.env.BP_SELFTEST) require('./selftest.js')(win);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
