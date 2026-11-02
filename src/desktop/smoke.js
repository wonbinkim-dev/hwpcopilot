import assert from 'node:assert/strict';
import { BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DocumentService } from '../document-service.js';

export function createSmokeDependencies(onWindow) {
  const snapshot = { documentId: 'smoke', path: '', text: '테스트 문서 본문', selection: '', position: [0, 0, 0] };
  const bridge = { async call(command) {
    if (command === 'diagnostics') return { registrations: [{ progId: 'HWPFrame.HwpObject', version: 'SMOKE', executable: 'test-only' }], architecture: 'x64', powershell: 'test' };
    if (command === 'connect') return { connected: true, editingSupported: true, version: 'SMOKE' };
    if (command === 'open') { snapshot.path = 'C:\\reports\\선택한 보고서.hwp'; return { ...snapshot }; }
    if (command === 'read') return { ...snapshot };
    return { applied: true, saved: true };
  }, stop() {} };
  const histories = [];
  const service = new DocumentService({ bridge, onWindow, generateText: async (_config, _instruction, _context, _fetcher, history) => {
    histories.push(history);
    return { text: '보고서 초안 테스트입니다.', usage: { tokens: { input: 120, output: 80, total: 200 }, limits: [{ label: '토큰', limit: 1000, remaining: 800, usedPercent: 20 }], observedAt: Date.now() } };
  }, listAvailableModels: async () => ({ models: [{ id: 'test-model', label: 'Test model' }, { id: 'second-model', label: 'Second model' }] }) });
  service.smokeHistories = histories;
  return { bridge, service };
}

async function until(predicate, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`${label} timed out`);
    await new Promise(resolve => setTimeout(resolve, 60));
  }
}

export async function runSmoke({ win, service, artifactDir }) {
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  // Exercise the sandboxed preload, rendered UI and the same service used by the app.
  const result = await win.webContents.executeJavaScript(`(async () => {
    await new Promise((resolve, reject) => {
      const deadline = Date.now() + 15000;
      const check = () => { if (document.body.dataset.ready === 'true') resolve(); else if (Date.now() > deadline) reject(new Error('UI initialization timeout')); else setTimeout(check, 50); }; check();
    });
    const api = async (route, args) => { const r = await window.hwpDesktop.request(route, args); if (!r.ok) throw new Error(r.error); return r.data; };
    const session = await api('session');
    await api('profiles-save', {profiles:[{name:'smoke-profile',provider:'compatible',baseUrl:'http://127.0.0.1:11434/v1',model:'test-model',apiKey:'MUST_NOT_PERSIST'}]});
    const savedProfiles = await api('profiles-load');
    if (JSON.stringify(savedProfiles).includes('MUST_NOT_PERSIST')) throw new Error('API key was persisted');
    const connected = await api('connect');
    const read = await api('read');
    const draft = await api('generate', {revision: read.revision, instruction:'결론 작성', scope:'document', mode:'insert', config:{}});
    document.getElementById('draft').value = draft.text;
    document.getElementById('aiSettings').open = false;
    document.getElementById('draft').dispatchEvent(new Event('input'));
    await api('apply', {revision: read.revision, text: draft.text, mode:'insert'});
    await api('save');
    return { isolated: typeof window.require === 'undefined', desktop: document.body.classList.contains('desktop'), providers: Object.keys(session.providers).length, text: draft.text, connected: connected.connected, title: document.title, profileSaved: savedProfiles[0].name === 'smoke-profile' };
  })()`);
  assert.equal(result.isolated, true);
  assert.equal(result.desktop, true);
  assert.equal(result.providers, 4);
  assert.equal(result.connected, true);
  assert.equal(result.profileSaved, true);
  assert.match(result.text, /초안/);
  // Use the actual renderer button handlers as well as the IPC contract above.
  await win.webContents.executeJavaScript(`document.getElementById('openSettings').click(); document.getElementById('connect').click()`);
  await until(() => win.webContents.executeJavaScript(`!document.getElementById('read').disabled`), 'UI connect');
  await win.webContents.executeJavaScript(`document.getElementById('read').click()`);
  await until(() => win.webContents.executeJavaScript(`document.getElementById('documentInfo').textContent.includes('본문') && !document.getElementById('read').disabled`), 'UI read');
  await win.webContents.executeJavaScript(`document.getElementById('openDocument').click()`);
  await until(() => win.webContents.executeJavaScript(`document.getElementById('documentInfo').textContent.includes('선택한 보고서.hwp') && !document.getElementById('read').disabled`), 'UI open existing file');
  assert.equal(await win.webContents.executeJavaScript(`document.getElementById('connection').textContent === '선택한 보고서.hwp' && !document.getElementById('settingsDialog').open`), true);
  await win.webContents.executeJavaScript(`document.getElementById('openSettings').click()`);
  await win.webContents.executeJavaScript(`document.getElementById('apiKey').value='test-only-key'; document.getElementById('apiKey').dispatchEvent(new Event('input')); document.getElementById('apiKey').dispatchEvent(new Event('change'));`);
  await until(() => win.webContents.executeJavaScript(`!document.getElementById('model').disabled && document.getElementById('model').options.length === 3`), 'UI load models after key');
  await win.webContents.executeJavaScript(`document.getElementById('instruction').value='보고서 결론 작성'; document.getElementById('instruction').dispatchEvent(new Event('input'));`);
  const modelSelection = await win.webContents.executeJavaScript(`(() => { const model=document.getElementById('model'); const before=document.getElementById('generate').disabled; model.value='test-model'; model.dispatchEvent(new Event('change')); return {tag:model.tagName, before, enabled:!document.getElementById('generate').disabled, primary:getComputedStyle(document.getElementById('generate')).backgroundColor}; })()`);
  assert.equal(modelSelection.tag, 'SELECT');
  assert.equal(modelSelection.before, true);
  assert.equal(modelSelection.enabled, true);
  assert.equal(modelSelection.primary, 'rgb(117, 205, 244)');
  await win.webContents.executeJavaScript(`document.getElementById('closeSettings').click(); document.getElementById('generate').click()`);
  await until(() => win.webContents.executeJavaScript(`document.getElementById('draft').value.includes('초안') && !document.getElementById('apply').disabled`), 'UI generate');
  await win.webContents.executeJavaScript(`document.getElementById('apply').click()`);
  await until(() => win.webContents.executeJavaScript(`document.getElementById('status').textContent.includes('반영했습니다')`), 'UI apply');
  assert.equal(await win.webContents.executeJavaScript(`document.getElementById('usageValue').textContent.includes('20%') && document.getElementById('usageDetail').textContent.includes('200')`), true);
  await win.webContents.executeJavaScript(`document.getElementById('instruction').value='더 짧게 써 줘'; document.getElementById('instruction').dispatchEvent(new Event('input')); document.getElementById('generate').click()`);
  await until(() => win.webContents.executeJavaScript(`document.querySelectorAll('.message.user').length === 2 && document.getElementById('usageDetail').textContent.includes('400')`), 'Follow-up chat with usage');
  assert.equal(service.smokeHistories.at(-1).length, 2);
  // Older messages can scroll while the meter and composer retain their positions.
  const layout = await win.webContents.executeJavaScript(`(() => {
    const log=document.getElementById('conversation');
    for(let i=0;i<30;i++){const item=document.createElement('article');item.className='message assistant';const body=document.createElement('div');body.className='message-body';body.textContent='이전 대화 '+i+' · '+ '보고서 내용을 검토합니다. '.repeat(6);item.append(body);log.prepend(item);}
    const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {top:r.top,bottom:r.bottom};};
    const before={meter:rect('usagePanel'),composer:rect('composer')};log.scrollTop=0;
    return {before,after:{meter:rect('usagePanel'),composer:rect('composer')},input:rect('instruction'),overflow:log.scrollHeight>log.clientHeight,viewport:innerHeight,pageHeight:document.documentElement.scrollHeight};
  })()`);
  assert.deepEqual(layout.before, layout.after);
  assert.equal(layout.overflow, true);
  assert.ok(layout.after.composer.bottom <= layout.viewport + 1);
  assert.ok(layout.after.meter.bottom <= layout.input.top);
  assert.ok(layout.pageHeight <= layout.viewport + 1, JSON.stringify(layout));
  const generator = service.generateText;
  let releaseReply;
  service.generateText = (...args) => new Promise(resolve => { releaseReply = async () => resolve(await generator(...args)); });
  try {
    await win.webContents.executeJavaScript(`document.getElementById('instruction').value='스크롤 고정 테스트'; document.getElementById('instruction').dispatchEvent(new Event('input')); document.getElementById('instruction').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.message.user').length`), 2);
    await win.webContents.executeJavaScript(`document.getElementById('instruction').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));`);
    await until(() => Boolean(releaseReply), 'Delayed reply started');
    await win.webContents.executeJavaScript(`document.getElementById('conversation').scrollTop=0`);
    await releaseReply();
    await until(() => win.webContents.executeJavaScript(`!document.querySelector('.message.pending')`), 'Delayed reply complete');
    assert.equal(await win.webContents.executeJavaScript(`document.getElementById('conversation').scrollTop`), 0);
    assert.equal(service.smokeHistories.at(-1).length, 4);
  } finally { service.generateText = generator; }
  await win.webContents.executeJavaScript(`document.getElementById('apiKey').value='changed-test-key'; document.getElementById('apiKey').dispatchEvent(new Event('input'));`);
  assert.equal(await win.webContents.executeJavaScript(`document.getElementById('model').disabled && document.getElementById('model').value === ''`), true);
  await win.webContents.executeJavaScript(`document.getElementById('loadModels').click()`);
  await until(() => win.webContents.executeJavaScript(`document.getElementById('model').value === 'test-model' && !document.getElementById('model').disabled`), 'UI reload and restore verified model');
  await win.webContents.executeJavaScript(`document.getElementById('openSettings').click(); document.getElementById('newChat').click();`);
  assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.message.user').length`), 0);
  await win.webContents.executeJavaScript(`document.getElementById('instruction').value='새 질문'; document.getElementById('instruction').dispatchEvent(new Event('input')); document.getElementById('generate').click()`);
  await until(() => win.webContents.executeJavaScript(`document.querySelectorAll('.message.user').length === 1 && !document.querySelector('.message.pending')`), 'New chat');
  assert.equal(service.smokeHistories.at(-1).length, 0);
  const target = new BrowserWindow({ show: true, width: 800, height: 600, title: 'HWP Copilot native tracking test', webPreferences: { sandbox: true } });
  const hwnd = target.getNativeWindowHandle().readBigUInt64LE().toString();
  const originalBounds = target.getBounds();
  try {
    await service.onWindow({ hwnd, version: 'SMOKE' });
    await until(() => win.webContents.executeJavaScript(`window.hwpDesktop.request('panel-state').then(r=>r.data.tracking)`), 'Native docking');
    target.focus();
    target.setBounds({ ...originalBounds, x: originalBounds.x + 30, y: originalBounds.y + 30, width: 720, height: 480 });
    await until(() => Math.abs(win.getBounds().y - target.getBounds().y) < 16, 'Follow moved window');
    target.minimize();
    await until(() => !win.isVisible(), 'Hide with minimized target');
    target.restore(); target.focus();
    await until(() => win.isVisible(), 'Show with restored target');
    const response = await win.webContents.executeJavaScript(`window.hwpDesktop.request('panel-dock', {enabled:false})`);
    assert.equal(response.ok, true);
    await until(() => { const bounds = target.getBounds(); return bounds.width === originalBounds.width && bounds.height === originalBounds.height; }, 'Restore original target placement');
  } finally { target.destroy(); }
  await mkdir(artifactDir, { recursive: true });
  await writeFile(join(artifactDir, 'desktop-preview.png'), (await win.webContents.capturePage()).toPNG());
  await writeFile(join(artifactDir, 'desktop-smoke.json'), JSON.stringify({ ...result, errors }, null, 2));
  assert.equal(errors.length, 0);
}
