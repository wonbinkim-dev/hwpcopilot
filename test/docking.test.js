import test from 'node:test';
import assert from 'node:assert/strict';
import { panelBounds, shouldShowPanel } from '../src/desktop/docking.js';
import { DocumentService } from '../src/document-service.js';

test('오른쪽 여유 공간에 패널 배치', () => {
  const bounds = panelBounds({ x: 0, y: 0, width: 1000, height: 900 }, { x: 0, y: 0, width: 1920, height: 1040 });
  assert.deepEqual(bounds, { x: 1006, y: 0, width: 400, height: 900 });
});
test('오른쪽에 공간이 없으면 왼쪽, 양쪽이 없으면 화면 안으로 배치', () => {
  const work = { x: 0, y: 0, width: 1920, height: 1040 };
  assert.equal(panelBounds({ x: 800, y: 50, width: 1100, height: 900 }, work).x, 394);
  assert.equal(panelBounds({ x: 0, y: 0, width: 1920, height: 1080 }, work).x, 1520);
  assert.equal(panelBounds({ x: 0, y: 0, width: 1920, height: 1080 }, work).height, 1040);
});
test('음수 좌표 모니터와 작은 작업 영역에서도 화면 안에 배치', () => {
  const work = { x: -1280, y: -100, width: 1280, height: 720 };
  const bounds = panelBounds({ x: -1300, y: -300, width: 1200, height: 1000 }, work);
  assert.ok(bounds.x >= work.x);
  assert.ok(bounds.x + bounds.width <= work.x + work.width);
  assert.ok(bounds.y >= work.y);
  assert.ok(bounds.y + bounds.height <= work.y + work.height);
  assert.equal(panelBounds({ x: 0, y: 0, width: 200, height: 200 }, { x: 0, y: 0, width: 280, height: 300 }).width, 280);
});
test('한글 최소화·비활성 시 숨기고 패널 입력 중에는 유지', () => {
  const frame = { exists: true, visible: true, minimized: false, foreground: true };
  assert.equal(shouldShowPanel(frame, false), true);
  assert.equal(shouldShowPanel({ ...frame, foreground: false }, false), false);
  assert.equal(shouldShowPanel({ ...frame, foreground: false }, true), true);
  assert.equal(shouldShowPanel({ ...frame, minimized: true }, true), false);
  assert.equal(shouldShowPanel({ ...frame, exists: false }, true), false);
});
test('버전 선택 및 새 창 정보를 데스크톱에 전달하고 연결 종료 후 쓰기를 막음', async () => {
  const windows = [];
  const calls = [];
  const bridge = { async call(command, args) {
    calls.push({ command, args });
    if (command === 'connect') return { hwnd: '123', version: '10', editingSupported: true };
    if (command === 'read') return { hwnd: '456', text: '', selection: '' };
    return {};
  } };
  const service = new DocumentService({ bridge, onWindow: window => windows.push(window.hwnd) });
  await service.execute('connect', { progId: 'HWPFrame.HwpObject.2' });
  const snapshot = await service.execute('read');
  service.invalidate();
  await assert.rejects(service.execute('apply', { revision: snapshot.revision, text: 'x', mode: 'insert' }), /만료/);
  assert.deepEqual(windows, ['123', '456']);
  assert.equal(calls[0].args.progId, 'HWPFrame.HwpObject.2');
  assert.equal(calls.some(x => x.command === 'apply'), false);
});
test('AI 요청 도중에는 문서 쓰기나 저장을 직렬화', async () => {
  let finish;
  const service = new DocumentService({ bridge: { call: async () => ({ text: '본문', selection: '' }) }, generateText: () => new Promise(resolve => { finish = resolve; }) });
  const snapshot = await service.execute('read');
  const generation = service.execute('generate', { revision: snapshot.revision, instruction: '작성', mode: 'insert', scope: 'none' });
  await assert.rejects(service.execute('save'), error => error.status === 409);
  finish('완료');
  assert.equal((await generation).text, '완료');
});
