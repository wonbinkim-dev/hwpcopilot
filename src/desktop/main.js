import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, globalShortcut, dialog } from 'electron';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HwpBridge } from '../bridge.js';
import { DocumentService } from '../document-service.js';
import { panelBounds, shouldShowPanel } from './docking.js';
import { trackWindow } from './tracker.js';
import { loadProfiles, saveProfiles } from './profiles.js';

const smoke = process.argv.includes('--smoke-test');
const root = fileURLToPath(new URL('../', import.meta.url));
const smokeArtifacts = app.isPackaged ? join(app.getPath('temp'), 'HWP-Copilot-smoke') : join(root, '..', 'artifacts');
app.setName('HWP Copilot');
app.setPath('userData', join(app.getPath('appData'), 'HWP Copilot'));
if (smoke) app.setPath('userData', join(smokeArtifacts, 'smoke-profile'));
const nativeRoot = app.isPackaged ? join(process.resourcesPath, 'native') : join(root, 'native');
const pageUrl = pathToFileURL(join(root, 'public', 'index.html')).href;
let win, tray, tracker, target, service, bridge;
let docked = true, quitting = false, panelWidth = 400, manualRevealUntil = 0;
let transition = Promise.resolve();
let exitStatus = 0;
let panelState = { docked, tracking: false, connected: false, message: '한글 창을 연결하세요.' };

function emitState(patch = {}) {
  panelState = { ...panelState, docked, ...patch };
  if (win && !win.isDestroyed()) win.webContents.send('hwp:panel-state', panelState);
}
async function stopTracking() {
  const current = tracker;
  tracker = null;
  if (current) await current.stop();
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(false);
}
function reveal() {
  if (!win || win.isDestroyed()) return;
  manualRevealUntil = Date.now() + 2000;
  tracker?.send('focus');
  if (win.isMinimized()) win.restore();
  win.show(); win.focus();
}
function lostTarget(message) {
  target = null;
  service.invalidate();
  void stopTracking();
  emitState({ tracking: false, connected: false, message });
  if (win && !win.isDestroyed()) { win.showInactive(); win.setAlwaysOnTop(false); }
}
function beginTracking(info, arrange = true) {
  if (!docked || !info?.hwnd || !win || win.isDestroyed()) return;
  let needsArrange = arrange;
  const current = trackWindow(join(nativeRoot, 'window-tracker.ps1'), info.hwnd, frame => {
    if (tracker !== current || quitting || win.isDestroyed()) return;
    if (!frame.exists || frame.trackerError) { lostTarget('연결된 창이 닫혔거나 위치 추적이 중단되었습니다. 한글 창을 다시 연결하세요.'); return; }
    const rect = screen.screenToDipRect(win, frame.rect);
    const display = screen.getDisplayMatching(rect);
    if (needsArrange) { needsArrange = false; current.send('layout', { width: Math.round(panelWidth * display.scaleFactor) }); }
    const visible = shouldShowPanel(frame, win.isFocused()) || Date.now() < manualRevealUntil;
    if (visible) {
      const bounds = panelBounds(rect, display.workArea, panelWidth);
      const previous = win.getBounds();
      if (Object.keys(bounds).some(key => bounds[key] !== previous[key])) win.setBounds(bounds, false);
      win.setAlwaysOnTop(true, 'floating');
      if (!win.isVisible()) win.showInactive();
    } else {
      win.setAlwaysOnTop(false);
      if (win.isVisible()) win.hide();
    }
    if (!panelState.tracking) emitState({ tracking: true, connected: true, message: '한글 창 옆에 붙어 있습니다.' });
  }, () => {
    if (tracker === current && !quitting) lostTarget('창 위치 추적이 종료되었습니다. 독립 창으로 사용하거나 한글을 다시 연결하세요.');
  });
  tracker = current;
}
async function onWindow(info) {
  if (!info?.hwnd) return;
  if (target?.hwnd === info.hwnd && (tracker || !docked)) return;
  transition = transition.then(async () => {
    await stopTracking();
    target = info;
    emitState({ connected: true, tracking: false, version: info.version, message: docked ? '패널 위치를 맞추는 중…' : '독립 창 모드' });
    beginTracking(info);
  });
  await transition;
}
async function panelRequest(route, args) {
  if (route === 'profiles-load') return loadProfiles(app.getPath('userData'));
  if (route === 'profiles-save') return saveProfiles(app.getPath('userData'), args.profiles);
  if (route === 'panel-state') return panelState;
  if (route === 'panel-focus') { tracker?.send('focus'); return {}; }
  if (route === 'panel-layout') {
    if (!tracker) throw new Error('한글 창을 연결하고 창에 붙이기를 켜세요.');
    const display = screen.getDisplayMatching(win.getBounds());
    tracker.send('layout', { width: Math.round(panelWidth * display.scaleFactor) }); return {};
  }
  if (route === 'panel-dock') {
    docked = Boolean(args.enabled);
    await stopTracking();
    if (docked && target) beginTracking(target);
    if (!docked) { win.show(); win.setAlwaysOnTop(false); }
    emitState({ tracking: false, message: docked ? '한글 창을 따라갑니다.' : '독립 창 모드 · 자유롭게 옮기세요.' });
    return panelState;
  }
  return service.execute(route, args);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', reveal);
  app.whenReady().then(async () => {
    if (process.platform !== 'win32') { dialog.showErrorBox('HWP Copilot', 'Windows용 한글 데스크톱이 필요합니다.'); app.quit(); return; }
    Menu.setApplicationMenu(null);
    if (smoke) {
      const { createSmokeDependencies } = await import('./smoke.js');
      ({ bridge, service } = createSmokeDependencies(onWindow));
    } else {
      bridge = new HwpBridge({ scriptPath: join(nativeRoot, 'hwp-bridge.ps1') });
      service = new DocumentService({ bridge, onWindow });
    }
    win = new BrowserWindow({ width: panelWidth, height: 860, minWidth: 340, minHeight: 440, title: 'HWP Copilot', backgroundColor: '#f5f6f2', icon: join(root, 'public', 'app.ico'), autoHideMenuBar: true, webPreferences: { preload: join(root, 'desktop', 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event, url) => { if (url !== pageUrl) event.preventDefault(); });
    win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    win.on('resize', () => { if (!tracker) panelWidth = Math.min(600, Math.max(340, win.getSize()[0])); });
    const routes = new Set(['session', 'models', 'diagnostics', 'connect', 'open', 'read', 'generate', 'apply', 'save', 'panel-state', 'panel-dock', 'panel-layout', 'panel-focus', 'profiles-load', 'profiles-save']);
    ipcMain.handle('hwp:request', async (event, route, args = {}) => {
      try {
        if (event.sender !== win.webContents || event.senderFrame?.url !== pageUrl || !routes.has(route)) throw new Error('허용되지 않은 요청입니다.');
        return { ok: true, data: await panelRequest(route, args) };
      } catch (error) { return { ok: false, error: error.message, usage: error.usage || null }; }
    });
    tray = new Tray(nativeImage.createFromPath(join(root, 'public', 'app.ico')));
    tray.setToolTip('HWP Copilot · Ctrl+Shift+Space로 패널 열기');
    tray.setContextMenu(Menu.buildFromTemplate([{ label: '패널 열기', click: reveal }, { label: '한글로 이동', click: () => tracker?.send('focus') }, { type: 'separator' }, { label: '종료', click: () => app.quit() }]));
    tray.on('double-click', reveal);
    globalShortcut.register('CommandOrControl+Shift+Space', reveal);
    await win.loadURL(pageUrl);
    if (smoke) {
      const { runSmoke } = await import('./smoke.js');
      try { await runSmoke({ win, service, artifactDir: smokeArtifacts }); console.log('DESKTOP_SMOKE_OK'); }
      catch (error) { console.error('DESKTOP_SMOKE_FAILED', error); exitStatus = 1; }
      app.quit();
    }
  }).catch(error => { exitStatus = 1; dialog.showErrorBox('HWP Copilot', `실행 실패: ${error.message}`); app.quit(); });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (quitting) return;
  event.preventDefault(); quitting = true;
  globalShortcut.unregisterAll();
  void stopTracking().finally(() => { bridge?.stop(); tray?.destroy(); app.exit(exitStatus); });
});
