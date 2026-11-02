const { spawn } = require('node:child_process');
const path = require('node:path');
const electron = require('electron');
const env = { ...process.env };
// IDE hosts may set this for their own Electron runtime. The panel needs GUI mode.
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [path.resolve(__dirname, '../..'), ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; });
process.on('SIGINT', () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
