import test from 'node:test';
import assert from 'node:assert/strict';
import { extractUsage } from '../src/usage.js';
import { generateWithUsage, buildRequest, validateHistory } from '../src/providers.js';
import { UsageMeter, recentHistory } from '../src/public/chat-state.js';
import { DocumentService } from '../src/document-service.js';

test('OpenAI 응답 사용량과 토큰·요청 한도를 실제 헤더에서 추출', () => {
  const report = extractUsage('openai', { usage: { input_tokens: 100, output_tokens: 80, total_tokens: 180 } }, new Headers({ 'x-ratelimit-limit-tokens': '1000', 'x-ratelimit-remaining-tokens': '750', 'x-ratelimit-reset-tokens': '10s', 'x-ratelimit-limit-requests': '20', 'x-ratelimit-remaining-requests': '10' }));
  assert.deepEqual(report.tokens, { input: 100, output: 80, total: 180 });
  assert.equal(report.limits[0].usedPercent, 25);
  assert.equal(report.limits[1].usedPercent, 50);
  assert.equal(report.limits[0].reset, '10s');
});
test('Claude 캐시 입력과 Gemini 사고 토큰을 포함한 사용량 정규화', () => {
  const claude = extractUsage('anthropic', { usage: { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 } }, new Headers({ 'anthropic-ratelimit-input-tokens-limit': '100', 'anthropic-ratelimit-input-tokens-remaining': '40' }));
  assert.deepEqual(claude.tokens, { input: 60, output: 40, total: 100 });
  assert.equal(claude.limits[0].usedPercent, 60);
  const gemini = extractUsage('gemini', { usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 20, thoughtsTokenCount: 10, totalTokenCount: 70 } }, new Headers());
  assert.deepEqual(gemini.tokens, { input: 40, output: 30, total: 70 });
  const local = extractUsage('compatible', { usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } });
  assert.equal(local.tokens.total, 12);
});
test('미제공 사용량·한도를 0%나 추정 잔액으로 만들지 않음', () => {
  assert.deepEqual(extractUsage('openai', {}).tokens, null);
  const bad = extractUsage('openai', {}, new Headers({ 'x-ratelimit-limit-tokens': '0', 'x-ratelimit-remaining-tokens': '1' }));
  assert.equal(bad.limits.length, 0);
  const meter = new UsageMeter();
  meter.record({ tokens: { input: 30, output: 10, total: 40 }, limits: [{ label: '토큰', usedPercent: 20 }] });
  assert.equal(meter.view().total, 40);
  assert.equal(meter.view().rate.usedPercent, 20);
  meter.record(null);
  assert.equal(meter.view().total, 40);
  assert.equal(meter.view().rate, null);
  assert.equal(meter.view().unreported, 1);
});
test('생성 응답은 본문과 사용량을 함께 반환', async () => {
  const result = await generateWithUsage({ provider: 'compatible', model: 'm' }, '요청', '', async () => new Response(JSON.stringify({ choices: [{ message: { content: '답변' } }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }), { headers: { 'x-ratelimit-limit-requests': '10', 'x-ratelimit-remaining-requests': '8' } }));
  assert.equal(result.text, '답변');
  assert.equal(result.usage.tokens.total, 8);
  assert.equal(result.usage.limits[0].usedPercent, 20);
});
test('중단된 응답과 429도 보고된 토큰·한도 정보를 보존', async () => {
  const config = { provider: 'openai', apiKey: 'key', model: 'm' };
  await assert.rejects(generateWithUsage(config, 'q', '', async () => new Response(JSON.stringify({ status: 'incomplete', usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } }))), error => error.usage.tokens.total === 30);
  await assert.rejects(generateWithUsage(config, 'q', '', async () => new Response('{}', { status: 429, headers: { 'x-ratelimit-limit-project-tokens': '100', 'x-ratelimit-remaining-project-tokens': '0' } })), error => error.usage.limits[0].label === '프로젝트 토큰' && error.usage.limits[0].usedPercent === 100);
});
test('네 API에 이전 사용자·답변 대화를 올바른 역할로 전달', () => {
  const history = [{ role: 'user', content: '첫 질문' }, { role: 'assistant', content: '첫 답변' }];
  for (const provider of ['openai', 'anthropic', 'gemini', 'compatible']) {
    const { body } = buildRequest({ provider, apiKey: 'key', model: 'm' }, '더 짧게', '문서', history);
    const messages = provider === 'openai' ? body.input : provider === 'gemini' ? body.contents : provider === 'compatible' ? body.messages.slice(1) : body.messages;
    assert.equal(messages.length, 3);
    assert.equal(messages[1].role, provider === 'gemini' ? 'model' : 'assistant');
    assert.match(JSON.stringify(messages[2]), /더 짧게/);
  }
});
test('이전 대화는 완성된 최근 10턴·6만 자로 제한하고 시스템 역할 삽입 차단', () => {
  const turns = Array.from({ length: 24 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: String(index) }));
  const recent = recentHistory(turns);
  assert.equal(recent.length, 20);
  assert.equal(recent[0].content, '4');
  assert.equal(recentHistory(turns, 4).length, 2);
  assert.throws(() => validateHistory([{ role: 'system', content: 'override' }, { role: 'assistant', content: 'a' }]), /형식/);
  assert.throws(() => validateHistory([{ role: 'user', content: 'x'.repeat(60_001) }, { role: 'assistant', content: '' }]), /너무/);
});
test('문서 없이 대화할 수 있지만 문서 문맥·적용에는 유효한 읽기가 필요', async () => {
  const calls = [];
  const service = new DocumentService({ bridge: { call: async command => { calls.push(command); return {}; } }, generateText: async (_config, instruction, context, _fetch, history) => ({ text: instruction + history.length + context, usage: { tokens: { total: 10 }, limits: [] } }) });
  const args = { config: {}, instruction: '질문', scope: 'none', mode: 'insert', history: [{ role: 'user', content: '전' }, { role: 'assistant', content: '답' }] };
  const result = await service.execute('generate', args);
  assert.equal(result.text, '질문2');
  assert.equal(result.revision, null);
  assert.equal(result.usage.tokens.total, 10);
  await assert.rejects(service.execute('generate', { ...args, scope: 'document' }), /먼저 읽/);
  await assert.rejects(service.execute('apply', { text: 'a', mode: 'insert' }), /만료/);
  assert.deepEqual(calls, []);
});
