import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, generate, listModels } from '../src/providers.js';
import { DocumentService } from '../src/document-service.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('OpenAI는 키로 모델을 조회하며 정확한 ID와 텍스트 후보만 반환', async () => {
  const result = await listModels({ provider: 'openai', apiKey: 'Bearer test-key' }, async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/models');
    assert.equal(options.method, 'GET');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.equal(options.redirect, 'error');
    assert.ok(!url.includes('test-key'));
    return json({ data: [{ id: 'gpt-exact-model-id' }, { id: 'future-text-model' }, { id: 'text-embedding-test' }, { id: 'gpt-image-test' }, { id: 'gpt-exact-model-id' }] });
  });
  assert.deepEqual(result.models.map(m => m.id), ['future-text-model', 'gpt-exact-model-id']);
});

test('Claude 모델 목록은 인증 헤더와 after_id 페이지를 사용', async () => {
  let page = 0;
  const result = await listModels({ provider: 'anthropic', apiKey: 'key' }, async (url, options) => {
    assert.equal(options.headers['x-api-key'], 'key');
    assert.equal(options.headers['anthropic-version'], '2023-06-01');
    assert.equal(new URL(url).searchParams.get('limit'), '100');
    if (page++ === 0) return json({ data: [{ id: 'claude-test-a', display_name: 'Claude A' }], has_more: true, last_id: 'claude-test-a' });
    assert.equal(new URL(url).searchParams.get('after_id'), 'claude-test-a');
    return json({ data: [{ id: 'claude-test-b', display_name: 'Claude B' }], has_more: false });
  });
  assert.equal(result.models.length, 2);
  assert.equal(result.models[0].label, 'Claude A (claude-test-a)');
});

test('Gemini 목록은 generateContent 지원 모델만 선택하며 페이지를 끝까지 조회', async () => {
  let page = 0;
  const result = await listModels({ provider: 'gemini', apiKey: 'key' }, async (url, options) => {
    assert.equal(options.headers['x-goog-api-key'], 'key');
    if (page++ === 0) return json({ models: [{ name: 'models/gemini-a', displayName: 'Gemini A', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'next page' });
    assert.equal(new URL(url).searchParams.get('pageToken'), 'next page');
    return json({ models: [{ name: 'models/gemini-b', supportedGenerationMethods: ['generateContent'] }] });
  });
  assert.deepEqual(result.models.map(m => m.id), ['gemini-a', 'gemini-b']);
});

test('인증 없는 로컬 호환 API에서도 모델 목록 선택 지원', async () => {
  const result = await listModels({ provider: 'compatible' }, async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:11434/v1/models');
    assert.equal(options.headers.Authorization, undefined);
    return json({ data: [{ id: 'local-model:latest' }] });
  });
  assert.equal(result.models[0].id, 'local-model:latest');
});

test('목록 조회에 모델 입력은 불필요하지만 API 키와 URL은 검증', async () => {
  let fetched = false;
  await assert.rejects(listModels({ provider: 'openai' }, async () => { fetched = true; }), /API 키/);
  await assert.rejects(listModels({ provider: 'openai', apiKey: 'key with spaces' }), /공백/);
  await assert.rejects(listModels({ provider: 'compatible', baseUrl: 'http://remote.example/v1' }), /HTTPS/);
  assert.equal(fetched, false);
  assert.equal(buildRequest({ provider: 'openai', apiKey: 'Bearer secret', model: 'exact-id' }, 'i', '').headers.Authorization, 'Bearer secret');
});

test('401·403·404·429·결제 한도를 구분하고 원문 키를 노출하지 않음', async () => {
  const config = { provider: 'openai', apiKey: 'secret' };
  for (const [status, code, pattern] of [[401, 'invalid_api_key', /인증/], [403, 'permission_denied', /권한/], [404, 'model_not_found', /주소 또는 모델/], [429, 'rate_limit_exceeded', /요청 빈도/], [429, 'insufficient_quota', /금액 한도/]]) {
    await assert.rejects(listModels(config, async () => json({ error: { code, message: 'secret echoed by provider' } }, status)), error => pattern.test(error.message) && error.message.includes(String(status)) && !error.message.includes('secret'));
  }
  await assert.rejects(generate({ ...config, model: 'model' }, 'i', '', async () => json({ error: { type: 'rate_limit_error', details: { error_code: 'enforced_spend_limit_reached' } } }, 429)), /금액 한도/);
});

test('지원하지 않는 목록 형식·빈 목록·무한 페이지는 명확하게 거절', async () => {
  const config = { provider: 'compatible' };
  await assert.rejects(listModels(config, async () => json({ unknown: [] })), /목록 형식/);
  await assert.rejects(listModels(config, async () => json({ data: [] })), /찾지 못/);
  await assert.rejects(listModels(config, async () => json({ data: [{ id: 'a' }], has_more: true, last_id: 'a' })), /페이지 정보/);
  await assert.rejects(listModels(config, async () => json({ data: [], has_more: true })), /다음 페이지/);
});

test('모델 조회 중 네트워크·JSON 오류도 키와 원문 없이 안내', async () => {
  const config = { provider: 'compatible' };
  await assert.rejects(listModels(config, async () => { throw new Error('secret URL'); }), error => /연결하지 못/.test(error.message) && !error.message.includes('secret'));
  await assert.rejects(listModels(config, async () => new Response('<html>not API</html>')), /JSON/);
});

test('문서 연결 없이 모델 조회 가능하며 기존 문서 스냅샷을 보존', async () => {
  const calls = [];
  const service = new DocumentService({ bridge: { async call(command) { calls.push(command); return { text: '', selection: '' }; } }, listAvailableModels: async () => ({ models: [{ id: 'exact-id' }] }) });
  assert.equal((await service.execute('models', { config: {} })).models[0].id, 'exact-id');
  assert.deepEqual(calls, []);
  const snapshot = await service.execute('read');
  await service.execute('models', { config: {} });
  await service.execute('apply', { revision: snapshot.revision, mode: 'insert', text: '테스트' });
  assert.deepEqual(calls, ['read', 'apply']);
});
