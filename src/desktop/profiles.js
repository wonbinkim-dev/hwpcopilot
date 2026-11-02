import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { providers } from '../providers.js';

export function cleanProfiles(value) {
  if (!Array.isArray(value) || value.length > 100) throw new Error('연결 설정 형식이 올바르지 않습니다.');
  return value.map(profile => {
    if (!profile || !providers[profile.provider] || !['name', 'baseUrl', 'model'].every(key => typeof profile[key] === 'string')) throw new Error('연결 설정 필드를 확인하세요.');
    if (!profile.name.trim() || profile.name.length > 100 || profile.model.length > 200 || profile.baseUrl.length > 2048) throw new Error('연결 설정이 비어 있거나 너무 깁니다.');
    const url = new URL(profile.baseUrl || providers[profile.provider].baseUrl);
    if (url.username || url.password || url.search || url.hash) throw new Error('설정 URL에 인증정보나 쿼리를 저장할 수 없습니다.');
    // Reconstruct the object: keys and arbitrary extra fields never reach disk.
    return { name: profile.name, provider: profile.provider, baseUrl: profile.baseUrl, model: profile.model };
  });
}
export async function loadProfiles(directory) {
  try { return cleanProfiles(JSON.parse(await readFile(join(directory, 'profiles.json'), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return []; throw new Error('저장된 연결 설정을 읽을 수 없습니다.'); }
}
export async function saveProfiles(directory, profiles) {
  const cleaned = cleanProfiles(profiles);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'profiles.tmp'), JSON.stringify(cleaned, null, 2), { mode: 0o600 });
  await rename(join(directory, 'profiles.tmp'), join(directory, 'profiles.json'));
  return cleaned;
}
