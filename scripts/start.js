// Launches the desktop app. Clears ELECTRON_RUN_AS_NODE, which some editors set and which stops Electron opening a window.
//   node scripts/start.js             normal start
//   node scripts/start.js --selftest  end-to-end test against test/fake-table.html (uses a throwaway data folder)
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (process.argv.includes('--selftest')) {
  env.BP_SELFTEST = '1';
  const dir = path.join(os.tmpdir(), 'baccarat-predict-selftest');
  fs.rmSync(dir, { recursive: true, force: true });
  env.BP_USERDATA = dir;
  env.BP_SELFTEST_OUT = env.BP_SELFTEST_OUT || dir;
  fs.mkdirSync(dir, { recursive: true });
  console.log('Self-test data and screenshots:', dir);
}
const args = process.argv.includes('--bench') ? [path.join(__dirname, '..', 'test', 'bench-main.js')] : [path.join(__dirname, '..')];
const child = spawn(electron, args, { env, stdio: 'inherit' });
child.on('exit', code => process.exit(code || 0));
