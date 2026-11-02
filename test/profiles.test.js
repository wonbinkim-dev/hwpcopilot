import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanProfiles, loadProfiles, saveProfiles } from '../src/desktop/profiles.js';

test('연결 설정의 API 키와 임의 필드는 디스크에 저장하지 않음', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hwp-profile-test-'));
  try {
    assert.deepEqual(await loadProfiles(directory), []);
    await saveProfiles(directory, [{ name: '팀 연결', provider: 'compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'local', apiKey: 'NEVER_STORE_THIS' }]);
    const disk = await readFile(join(directory, 'profiles.json'), 'utf8');
    assert.ok(!disk.includes('NEVER_STORE_THIS'));
    assert.ok(!disk.includes('apiKey'));
    assert.equal((await loadProfiles(directory))[0].name, '팀 연결');
    await saveProfiles(directory, []);
    assert.deepEqual(await loadProfiles(directory), []);
  } finally { await unlink(join(directory, 'profiles.json')).catch(() => {}); await rmdir(directory); }
});
test('URL에 포함된 인증정보나 쿼리의 키 저장 차단', () => {
  const profile = { name: 'test', provider: 'openai', baseUrl: 'https://example.com/v1', model: 'm' };
  assert.throws(() => cleanProfiles([{ ...profile, baseUrl: 'https://user:secret@example.com/v1' }]), /인증정보/);
  assert.throws(() => cleanProfiles([{ ...profile, baseUrl: 'https://example.com/v1?api_key=secret' }]), /인증정보/);
});
