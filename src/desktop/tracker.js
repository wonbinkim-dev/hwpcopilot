import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export function trackWindow(scriptPath, hwnd, onFrame, onExit) {
  if (!/^\d+$/.test(String(hwnd)) || Number(hwnd) <= 0) throw new Error('유효한 한글 창 핸들이 없습니다.');
  const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-TargetHandle', String(hwnd)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let stopped = false;
  let finished = false;
  child.stdin.on('error', () => {});
  child.stderr.resume();
  createInterface({ input: child.stdout }).on('line', line => {
    if (stopped) return;
    try { onFrame(JSON.parse(line.replace(/^\uFEFF/, ''))); } catch { /* ignore non-protocol output */ }
  });
  const exited = new Promise(resolve => {
    const done = () => { if (finished) return; finished = true; resolve(); if (!stopped) onExit(); };
    child.on('error', done); child.on('exit', done);
  });
  return {
    send(command, args = {}) { if (!stopped && !finished) child.stdin.write(JSON.stringify({ command, ...args }) + '\n'); },
    async stop() {
      if (finished) return;
      if (!stopped) { stopped = true; child.stdin.end('{"command":"stop"}\n'); }
      const timer = setTimeout(() => child.kill(), 2500);
      await exited;
      clearTimeout(timer);
    },
  };
}
