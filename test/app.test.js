import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createApp } from '../src/hwpcopilot.js';
import { buildRequest, extractText, generate } from '../src/providers.js';
import { DocumentService } from '../src/document-service.js';

test('기존 파일 선택은 연결 후 읽은 문서를 반환하고 파일 변경·취소·실패 시 이전 적용 권한 만료', async () => {
  const calls = [], windows = [];
  let path = 'C:\\reports\\first.hwp', cancelled = false, fail = false;
  const service = new DocumentService({ bridge: { async call(command) {
    calls.push(command);
    if (command === 'connect') return { connected: true, editingSupported: true, hwnd: '1' };
    if (command === 'open') {
      if (fail) throw new Error('Open failed');
      return cancelled ? { cancelled: true } : { path, text: '기존 본문', selection: '', hwnd: '2' };
    }
    return { applied: true };
  } }, onWindow: info => windows.push(info.hwnd) });
  const first = await service.execute('open');
  assert.equal(first.path, path);
  assert.equal(first.text, '기존 본문');
  assert.ok(first.revision);
  assert.deepEqual(windows, ['1', '2']);
  path = 'C:\\reports\\second.hwpx';
  const second = await service.execute('open');
  assert.equal(second.path, path);
  assert.notEqual(first.revision, second.revision);
  await assert.rejects(service.execute('apply', { revision: first.revision, text: '수정', mode: 'insert' }), /만료/);
  cancelled = true;
  assert.equal((await service.execute('open')).cancelled, true);
  await assert.rejects(service.execute('apply', { revision: second.revision, text: '수정', mode: 'insert' }), /만료/);
  cancelled = false;
  const third = await service.execute('open');
  fail = true;
  await assert.rejects(service.execute('open'), /Open failed/);
  await assert.rejects(service.execute('apply', { revision: third.revision, text: '수정', mode: 'insert' }), /만료/);
  assert.deepEqual(calls, Array.from({ length: 5 }, () => ['connect', 'open']).flat());
});

test('네 API 형식별 URL, 인증, 본문과 응답 처리', () => {
  for (const provider of ['openai', 'anthropic', 'gemini', 'compatible']) {
    const request = buildRequest({ provider, model: 'test-model', apiKey: 'secret' }, '요약', '한글 문맥');
    assert.match(JSON.stringify(request.body), /한글 문맥/);
    if (provider === 'openai') { assert.match(request.url, /\/responses$/); assert.equal(request.body.store, false); }
    if (provider === 'anthropic') { assert.match(request.url, /\/messages$/); assert.equal(request.headers['x-api-key'], 'secret'); }
    if (provider === 'gemini') { assert.match(request.url, /\/models\/test-model:generateContent$/); assert.equal(request.headers['x-goog-api-key'], 'secret'); }
    if (provider === 'compatible') assert.match(request.url, /\/chat\/completions$/);
  }
  assert.equal(extractText('openai', { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '완료' }] }] }), '완료');
  assert.equal(extractText('anthropic', { content: [{ type: 'thinking', thinking: '비공개' }, { type: 'text', text: '완료' }] }), '완료');
  assert.equal(extractText('gemini', { candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: '비공개' }, { text: '완료' }] } }] }), '완료');
  assert.equal(extractText('compatible', { choices: [{ message: { content: '완료' } }] }), '완료');
});

test('유효하지 않은 설정, 잘린 응답, 빈 응답은 거절', () => {
  assert.throws(() => buildRequest({ provider: 'invalid', model: 'm' }, 'i', 'c'));
  assert.throws(() => buildRequest({ provider: 'openai', model: 'm' }, 'i', 'c'), /API 키/);
  assert.throws(() => buildRequest({ provider: 'compatible', model: 'm', baseUrl: 'http://example.com/v1' }, 'i', 'c'), /HTTPS/);
  assert.throws(() => buildRequest({ provider: 'compatible', model: 'm', baseUrl: 'https://user:pass@example.com' }, 'i', 'c'), /인증정보/);
  assert.throws(() => extractText('openai', { status: 'incomplete' }), /완료/);
  assert.throws(() => extractText('anthropic', { stop_reason: 'max_tokens' }), /중단/);
  assert.throws(() => extractText('gemini', { candidates: [{ finishReason: 'SAFETY' }] }), /차단/);
  assert.throws(() => extractText('compatible', { choices: [{ finish_reason: 'length' }] }), /중단/);
  assert.throws(() => extractText('openai', {}), /본문/);
});

test('API 호출 결과 처리와 오류 원문 비노출', async () => {
  const config = { provider: 'compatible', model: 'local' };
  const text = await generate(config, '지시', '', async (url, options) => {
    assert.equal(options.redirect, 'error');
    assert.equal(JSON.parse(options.body).model, 'local');
    return new Response(JSON.stringify({ choices: [{ message: { content: '응답' } }] }));
  });
  assert.equal(text, '응답');
  await assert.rejects(generate(config, '지시', '', async () => new Response('sensitive content', { status: 401 })), error => error.message.includes('401') && !error.message.includes('sensitive'));
});

async function setup(t, options = {}) {
  const calls = [];
  const source = { documentId: '1', path: 'C:\\test.hwpx', text: '전체 본문', selection: '', position: [0, 0, 0] };
  const sent = [];
  const bridge = { call: async (command, args) => { calls.push({ command, args }); if (command === 'read') return { ...source }; if (options.failApply && command === 'apply') throw new Error('Document changed'); return { connected: true, applied: true }; }, stop() {} };
  const server = createApp({ bridge, generateText: async (config, instruction, context) => { sent.push({ config, instruction, context }); return '새 본문'; } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { token } = await fetch(`${base}/api/session`).then(r => r.json());
  const post = async (route, body = {}, extraHeaders = {}) => {
    const response = await fetch(`${base}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': token, ...extraHeaders }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  return { post, calls, source, sent, base };
}

test('연결 → 읽기 → 생성 → 적용 → 저장, 재적용 방지', async t => {
  const { post, calls } = await setup(t);
  assert.equal((await post('connect')).status, 200);
  const { data: snapshot } = await post('read');
  const { data: draft } = await post('generate', { revision: snapshot.revision, config: {}, instruction: '문단 추가', mode: 'insert', scope: 'none' });
  assert.equal(draft.text, '새 본문');
  assert.equal((await post('apply', { revision: draft.revision, mode: 'insert', text: draft.text })).status, 200);
  assert.equal((await post('apply', { revision: draft.revision, mode: 'insert', text: draft.text })).status, 400);
  await post('save');
  assert.deepEqual(calls.map(c => c.command), ['connect', 'read', 'apply', 'save']);
});

test('전송 범위가 선택한 문맥만 포함', async t => {
  const { post, sent, source } = await setup(t);
  source.selection = '선택한 문장';
  const { data: snapshot } = await post('read');
  for (const scope of ['none', 'selection', 'document']) {
    assert.equal((await post('generate', { revision: snapshot.revision, instruction: '수정', mode: 'replace', scope })).status, 200);
  }
  assert.deepEqual(sent.map(s => s.context), ['', '선택한 문장', '전체 본문']);
});

test('선택 상태는 대화를 막지 않고 실제 적용에서 검사하며 만료된 문맥은 차단', async t => {
  const { post, source } = await setup(t);
  let result = await post('read');
  assert.equal((await post('generate', { revision: result.data.revision, instruction: '수정', scope: 'none', mode: 'replace' })).status, 200);
  assert.equal((await post('apply', { revision: result.data.revision, text: '수정', mode: 'replace' })).status, 400);
  source.selection = '선택';
  result = await post('read');
  assert.equal((await post('generate', { revision: result.data.revision, instruction: '추가', scope: 'none', mode: 'insert' })).status, 200);
  assert.equal((await post('apply', { revision: result.data.revision, text: '추가', mode: 'insert' })).status, 400);
  assert.equal((await post('generate', { revision: 'stale', instruction: '추가', scope: 'none', mode: 'insert' })).status, 400);
});

test('적용 실패 후에도 스냅샷 만료로 중복 쓰기 방지', async t => {
  const { post, calls } = await setup(t, { failApply: true });
  const { data: snapshot } = await post('read');
  const args = { revision: snapshot.revision, text: '변경', mode: 'insert' };
  assert.equal((await post('apply', args)).status, 400);
  assert.equal((await post('apply', args)).status, 400);
  assert.equal(calls.filter(c => c.command === 'apply').length, 1);
});

test('외부 Origin, 잘못된 세션 토큰, DNS rebinding Host 차단', async t => {
  const { post, base, calls } = await setup(t);
  assert.equal((await post('connect', {}, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await post('connect', {}, { 'X-Session-Token': 'wrong' })).status, 403);
  // Node fetch manages Host itself; use HTTP directly to exercise a forged Host.
  const forgedHostStatus = await new Promise((resolve, reject) => {
    const req = request(`${base}/api/session`, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(forgedHostStatus, 403);
  assert.equal(calls.length, 0);
});

test('로컬 화면 제공 및 임의 파일 접근 차단', async t => {
  const { base } = await setup(t);
  const response = await fetch(base);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /한글 Copilot/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(`${base}/hwp-bridge.ps1`)).status, 403);
});
