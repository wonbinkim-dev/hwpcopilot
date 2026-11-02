import { UsageMeter, recentHistory } from './chat-state.js';

const $ = id => document.getElementById(id);
const desktop = window.hwpDesktop;
let token, providers, snapshot, connected = false, editable = true, busy = false, docked = true;
let modelsLoaded = false, preferredModel = '';
const usageMeter = new UsageMeter();
const turns = [];
let draftTurn = null;
if (desktop) { document.body.classList.add('desktop'); $('desktopControls').hidden = false; $('panelHint').textContent = 'Ctrl+Shift+Space로 패널 열기 · 트레이에서도 열 수 있습니다.'; }
let profiles = [];
try { if (!desktop) profiles = JSON.parse(localStorage.getItem('hwp-profiles') || '[]'); if (!Array.isArray(profiles)) profiles = []; } catch { /* storage unavailable */ }

function status(message, error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
function update() {
  $('read').disabled = busy || !connected || !editable;
  $('save').disabled = busy || !connected;
  const needsDocument = $('scope').value !== 'none';
  $('generate').disabled = busy || (needsDocument && !snapshot) || !modelsLoaded || !$('model').value || !$('instruction').value.trim();
  const invalidSelection = snapshot && ($('mode').value === 'replace' ? !snapshot.selection?.trim() : Boolean(snapshot.selection));
  $('apply').disabled = busy || !snapshot || invalidSelection || !$('draft').value.trim();
  $('applyHint').textContent = !snapshot ? '적용할 문서는 설정에서 읽으세요. 적용 후 파일 저장은 별도입니다.' : invalidSelection ? '설정의 적용 방식에 맞춰 커서나 선택 영역을 정하고 문서를 다시 읽으세요.' : '현재 읽은 문서에 적용합니다. 적용 후 설정에서 파일을 저장하세요.';
  for (const el of document.querySelectorAll('button,input,select,textarea:not([readonly])')) {
    if (!['read', 'save', 'generate', 'apply', 'openSettings', 'closeSettings', 'contextButton'].includes(el.id)) el.disabled = busy;
  }
  $('draftCount').textContent = `${$('draft').value.length.toLocaleString()}자`;
  const scope = $('scope').value;
  $('context').value = !snapshot ? '' : scope === 'document' ? snapshot.text : scope === 'selection' ? snapshot.selection : '';
  $('contextCount').textContent = `${$('context').value.length.toLocaleString()}자`;
  $('hwpVersion').disabled = busy || connected;
  $('model').disabled = busy || !modelsLoaded;
  $('loadModels').disabled = busy || ($('provider').value !== 'compatible' && !$('apiKey').value.trim());
  $('activeModel').textContent = $('model').value || '모델 선택';
  const scopeName = $('scope').selectedOptions[0]?.textContent || '';
  $('contextButton').textContent = `${scopeName} · ${$('mode').value === 'replace' ? '선택 문장 교체' : '글 추가'}`;
}

function renderUsage() {
  const { total, responses, unreported, rate } = usageMeter.view();
  const bar = $('usageBar');
  bar.classList.toggle('unknown', !rate);
  bar.classList.toggle('warning', Boolean(rate && rate.usedPercent >= 85));
  $('usageFill').style.width = rate ? `${rate.usedPercent}%` : '0%';
  if (rate) {
    bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); bar.setAttribute('aria-valuenow', String(rate.usedPercent));
    bar.setAttribute('aria-label', `${rate.label} 한도 사용률, 직전 응답 기준`);
    $('usageValue').textContent = `${rate.label} ${rate.usedPercent}% 사용`;
    $('usageDetail').textContent = `응답 토큰 누적 ${total.toLocaleString()}${unreported ? ' + 일부 미제공' : ''} · 남음 ${rate.remaining.toLocaleString()} / ${rate.limit.toLocaleString()} (직전 응답 기준)`;
    bar.title = rate.reset ? `제공자가 보고한 초기화 정보: ${rate.reset}` : '제공자가 응답 헤더로 보고한 값입니다.';
  } else {
    for (const attribute of ['aria-valuenow', 'aria-valuemin', 'aria-valuemax']) bar.removeAttribute(attribute);
    bar.setAttribute('aria-label', 'API 한도 정보 없음');
    $('usageValue').textContent = '한도 미제공';
    $('usageDetail').textContent = `응답 토큰 누적 ${total.toLocaleString()}${unreported ? ` · 토큰 미제공 ${unreported}회` : ''} · ${responses ? '현재 연결의 보고된 사용량' : 'API 응답 후 표시합니다.'}`;
    bar.title = '계정의 월간 잔액이나 한도를 추정하지 않습니다.';
  }
}
function resetUsage() { usageMeter.reset(); renderUsage(); }
function openSettings() { if (!$('settingsDialog').open) $('settingsDialog').showModal(); }
$('openSettings').onclick = openSettings;
$('contextButton').onclick = openSettings;
$('closeSettings').onclick = () => $('settingsDialog').close();
$('settingsDialog').addEventListener('close', () => $('instruction').focus({ preventScroll: true }));

function nearBottom() { const log = $('conversation'); return log.scrollHeight - log.clientHeight - log.scrollTop < 90; }
function scrollBottom() { const log = $('conversation'); log.scrollTop = log.scrollHeight; }
function message(role, text, extra = '') {
  const article = document.createElement('article'); article.className = `message ${role} ${extra}`.trim();
  const label = document.createElement('div'); label.className = 'message-label'; label.textContent = role === 'user' ? '나' : 'Copilot';
  const body = document.createElement('div'); body.className = 'message-body';
  const content = document.createElement('p'); content.className = 'message-text'; content.textContent = text; body.append(content);
  article.append(label, body); $('conversation').append(article);
  return { article, body };
}
function syncDraft() { if (draftTurn) draftTurn.content = $('draft').value; }
function fitDraft() {
  const field = $('draft');
  field.style.height = '0px';
  field.style.height = `${Math.min(320, Math.max(70, field.scrollHeight))}px`;
}
function archiveEditor() {
  const editor = $('latestDraft');
  if (draftTurn && editor.parentElement.classList.contains('message-body')) {
    syncDraft();
    const previousTurn = draftTurn, previousBody = editor.parentElement;
    const content = document.createElement('p'); content.className = 'message-text'; content.textContent = previousTurn.content;
    const edit = document.createElement('button'); edit.className = 'subtle message-action'; edit.type = 'button'; edit.textContent = '이 답변 편집';
    edit.onclick = () => {
      if (busy) return;
      const current = archiveEditor();
      previousBody.replaceChildren(current); current.hidden = false;
      draftTurn = previousTurn; $('draft').value = previousTurn.content; fitDraft(); update();
    };
    previousBody.replaceChildren(content, edit);
  }
  return editor;
}
$('newChat').onclick = () => {
  if (busy) return;
  const editor = $('latestDraft'); editor.hidden = true;
  turns.length = 0; draftTurn = null; $('draft').value = '';
  $('conversation').replaceChildren(editor);
  message('assistant', '새 대화를 시작했어요. 어떤 보고서를 함께 작성할까요?');
  $('settingsDialog').close(); status('새 대화입니다. 이전 대화는 다음 요청에 보내지 않습니다.'); update();
};
async function api(route, args = {}) {
  if (desktop) {
    const result = await desktop.request(route, args);
    if (!result.ok) { const error = new Error(result.error || '요청 실패'); error.usage = result.usage; throw error; }
    return result.data;
  }
  const response = await fetch(`/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': token }, body: JSON.stringify(args) });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || '요청 실패'); error.usage = data.usage; throw error; }
  return data;
}
async function run(message, action) {
  busy = true; update(); status(message);
  try { await action(); } catch (error) { status(error.message, true); }
  finally { busy = false; update(); }
}
function config() { return { provider: $('provider').value, baseUrl: $('baseUrl').value.trim(), model: $('model').value.trim(), apiKey: $('apiKey').value.trim() }; }
function resetModels(remember = true) {
  if (remember && $('model').value) preferredModel = $('model').value;
  modelsLoaded = false;
  $('model').replaceChildren(new Option('API 키를 입력하고 목록을 불러오세요', ''));
  update();
}
function loadModels() {
  if (busy) return;
  return run('API 키로 모델 목록을 확인하는 중…', async () => {
    resetModels();
    const result = await api('models', { config: config() });
    if (!Array.isArray(result.models) || !result.models.length) throw new Error('선택할 모델이 없습니다. 키 권한과 제공자 API를 확인하세요.');
    $('model').replaceChildren(new Option('사용할 모델을 선택하세요', ''));
    for (const model of result.models) $('model').add(new Option(model.label, model.id));
    modelsLoaded = true;
    if (result.models.some(model => model.id === preferredModel)) $('model').value = preferredModel;
    status(`모델 ${result.models.length}개를 불러왔습니다. 사용할 모델을 선택하세요. 생성 API 사용 권한과 한도는 제공자 설정에 따릅니다.`);
  });
}
$('loadModels').onclick = loadModels;
$('apiKey').oninput = () => { resetModels(); resetUsage(); };
$('apiKey').onchange = () => { if ($('apiKey').value.trim() || $('provider').value === 'compatible') void loadModels(); };
$('baseUrl').oninput = () => { resetModels(); resetUsage(); };
function renderProfiles() {
  $('profile').replaceChildren(new Option('새 연결 설정', ''));
  profiles.forEach((p, i) => $('profile').add(new Option(p.name, String(i))));
}
async function persistProfiles() { if (desktop) profiles = await api('profiles-save', { profiles }); else localStorage.setItem('hwp-profiles', JSON.stringify(profiles)); renderProfiles(); }
$('saveProfile').onclick = async () => {
  try {
    const name = $('profileName').value.trim();
    if (!name) throw new Error('설정 이름을 입력하세요.');
    if (!modelsLoaded || !$('model').value) throw new Error('모델 목록을 불러오고 사용할 모델을 선택한 뒤 저장하세요.');
    const { provider, baseUrl, model } = config();
    const existing = profiles.findIndex(p => p.name === name);
    const entry = { name, provider, baseUrl, model };
    if (existing >= 0) profiles[existing] = entry; else profiles.push(entry);
    await persistProfiles(); status('연결 설정을 저장했습니다. API 키는 저장하지 않았습니다.');
  } catch (error) { status(error.message, true); }
};
$('removeProfile').onclick = async () => {
  try { if ($('profile').value === '') return; profiles.splice(Number($('profile').value), 1); await persistProfiles(); status('연결 설정을 삭제했습니다.'); }
  catch (error) { status(error.message, true); }
};
$('profile').onchange = () => {
  const p = profiles[Number($('profile').value)];
  if ($('profile').value === '' || !p) return;
  $('provider').value = p.provider; $('baseUrl').value = p.baseUrl; preferredModel = p.model; $('profileName').value = p.name; $('apiKey').value = '';
  resetModels(false);
  resetUsage();
};
$('provider').onchange = () => { $('baseUrl').value = providers[$('provider').value].baseUrl; preferredModel = ''; $('apiKey').value = ''; resetModels(false); resetUsage(); };
function showDocumentInfo() {
  $('documentInfo').textContent = `${snapshot.path || '저장하지 않은 문서'} · 본문 ${snapshot.text.length.toLocaleString()}자 · 선택 ${snapshot.selection.length.toLocaleString()}자`;
  $('connection').textContent = snapshot.path ? snapshot.path.split(/[\\/]/).pop() : '한글 연결됨';
  $('connection').title = snapshot.path || '저장하지 않은 문서';
}
$('openDocument').onclick = () => {
  $('settingsDialog').close();
  return run('한글의 파일 선택 창에서 작업할 문서를 고르세요. 저장·보안 확인창이 나오면 확인하세요.', async () => {
    snapshot = null;
    $('documentInfo').textContent = '문서 선택 중…';
    try {
      const result = await api('open', { progId: $('hwpVersion').value });
      connected = true; editable = result.editingSupported !== false;
      if (result.cancelled) {
        $('documentInfo').textContent = '파일 선택을 취소했습니다. 현재 문서에 작업하려면 문서 읽기를 누르세요.';
        status('파일 선택을 취소했습니다.'); return;
      }
      snapshot = result; showDocumentInfo();
      status('선택한 파일에 연결하고 내용을 읽었습니다. 위치나 선택 영역을 바꾸면 설정에서 문서를 다시 읽으세요.');
    } catch (error) {
      $('documentInfo').textContent = '파일을 연결하지 못했습니다. 한글에서 문서 상태를 확인한 뒤 다시 선택하거나 문서를 읽으세요.';
      throw error;
    }
  });
};
$('connect').onclick = () => run('한글 연결 중… 보안 확인창이 나오면 한글에서 확인하세요.', async () => {
  snapshot = null;
  const result = await api('connect', { progId: $('hwpVersion').value });
  connected = true; editable = result.editingSupported !== false;
  $('connection').textContent = result.version ? `한글 ${result.version}` : '한글 연결됨';
  if (!editable) { status('한글 창은 연결했지만 이 버전에서 편집에 필요한 API를 확인하지 못했습니다. 연결 점검 정보를 확인하세요.', true); return; }
  status('연결된 한글 창에서 파일을 열거나 새 문서를 작성한 후, 커서 또는 선택 영역을 정하고 문서 읽기를 누르세요.');
});
$('read').onclick = () => run('문서와 선택 영역을 읽는 중…', async () => {
  snapshot = null;
  snapshot = await api('read');
  showDocumentInfo();
  status('문서를 읽었습니다. AI에 보낼 범위와 지시를 확인하세요. 적용 전까지 한글의 커서와 선택 영역을 유지하세요.');
});
$('generate').onclick = () => {
  if (busy || $('generate').disabled) return;
  const instruction = $('instruction').value.trim();
  syncDraft();
  const history = recentHistory(turns);
  message('user', instruction);
  const pending = message('assistant', '답변을 작성하고 있어요…', 'pending');
  $('instruction').value = ''; scrollBottom();
  return run('AI가 답변하고 있습니다…', async () => {
    try {
      const result = await api('generate', { config: config(), instruction, history, scope: $('scope').value, mode: $('mode').value, revision: snapshot?.revision });
      const follow = nearBottom();
      const editor = archiveEditor();
      const answer = { role: 'assistant', content: result.text };
      turns.push({ role: 'user', content: instruction }, answer);
      draftTurn = answer;
      pending.article.classList.remove('pending'); pending.body.replaceChildren(editor); editor.hidden = false;
      $('draft').value = result.text;
      fitDraft();
      usageMeter.record(result.usage); renderUsage();
      if (follow) scrollBottom();
      status(snapshot ? '답변을 검토하고 문서에 적용할 수 있습니다.' : '답변을 받았습니다. 문서에 넣으려면 설정에서 한글 문서를 읽으세요.');
    } catch (error) {
      if (error.usage) { usageMeter.record(error.usage); renderUsage(); }
      const follow = nearBottom();
      pending.article.classList.remove('pending'); pending.article.classList.add('error'); pending.body.textContent = error.message;
      if (follow) scrollBottom();
      throw error;
    }
  });
};
$('apply').onclick = () => run('한글 문서에 적용 중…', async () => {
  const revision = snapshot.revision;
  snapshot = null;
  await api('apply', { revision, mode: $('mode').value, text: $('draft').value });
  status('한글 문서에 반영했습니다. 파일 저장 버튼으로 저장하세요. 다음 편집 전에는 문서를 다시 읽으세요.');
});
$('save').onclick = () => run('한글 파일 저장 중… 새 문서는 한글의 저장 대화상자를 확인하세요.', async () => {
  snapshot = null;
  await api('save'); status('파일을 저장했습니다. 다음 작업 전 문서를 다시 읽으세요.');
});
$('scope').onchange = update;
$('mode').onchange = update;
$('model').onchange = () => { preferredModel = $('model').value; usageMeter.latest = null; renderUsage(); update(); };
$('draft').oninput = () => { syncDraft(); fitDraft(); update(); };
$('instruction').oninput = update;
$('instruction').onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!$('generate').disabled) $('generate').click(); }
};
for (const button of document.querySelectorAll('[data-prompt]')) button.onclick = () => { $('instruction').value = button.dataset.prompt; $('settingsDialog').close(); $('instruction').focus(); update(); };

async function checkConnection() {
  const info = await api('diagnostics');
  const registrations = Array.isArray(info.registrations) ? info.registrations : [];
  const previous = $('hwpVersion').value;
  $('hwpVersion').replaceChildren(new Option('기본 한글 자동 연결', 'HWPFrame.HwpObject'));
  for (const registration of registrations) {
    const label = `${registration.progId} · ${registration.version || '버전 미확인'}`;
    if (registration.progId !== 'HWPFrame.HwpObject') $('hwpVersion').add(new Option(label, registration.progId));
  }
  if (Array.from($('hwpVersion').options).some(x => x.value === previous)) $('hwpVersion').value = previous;
  $('diagnostics').textContent = registrations.length ? `PowerShell ${info.powershell} (${info.architecture})\n${registrations.map(r => `${r.progId} · ${r.version || '버전 미확인'}\n${r.executable || '실행 경로 미확인'}`).join('\n')}\n여러 한글을 설치한 경우 기본 연결은 Windows에 마지막 등록된 버전을 사용합니다.` : '한글 자동화 등록을 찾지 못했습니다. 한글 뷰어가 아닌 Windows용 한글 데스크톱을 설치하세요.';
  return registrations.length;
}
$('checkConnection').onclick = () => run('한글 설치 및 연결 정보를 확인하는 중…', async () => { const count = await checkConnection(); status(count ? '설치 정보를 확인했습니다. 한글 창을 연결하세요.' : '한글 자동화 등록을 찾지 못했습니다.', !count); });
if (desktop) {
  desktop.onPanelState(state => {
    docked = state.docked;
    $('dock').textContent = docked ? '창에 붙이기 켜짐' : '독립 창 모드';
    $('dock').setAttribute('aria-pressed', String(docked));
    if (state.connected === false && connected) { connected = false; snapshot = null; $('connection').textContent = '연결 종료'; update(); }
    if (state.message && !busy) status(state.message);
  });
  $('dock').onclick = () => run('패널 배치를 변경하는 중…', async () => { await api('panel-dock', { enabled: !docked }); status(docked ? '한글 창에 붙였습니다.' : '독립 창으로 전환했습니다.'); });
  $('layout').onclick = () => run('한글과 패널을 나란히 배치하는 중…', async () => { await api('panel-layout'); status('한글과 패널을 나란히 배치했습니다.'); });
  $('focusHwp').onclick = () => api('panel-focus').catch(error => status(error.message, true));
}

try {
  const session = desktop ? await api('session') : await fetch('/api/session').then(r => { if (!r.ok) throw new Error('로컬 서버 연결 실패'); return r.json(); });
  token = session.token; providers = session.providers;
  for (const [id, value] of Object.entries(providers)) $('provider').add(new Option(value.label, id));
  $('baseUrl').value = providers.openai.baseUrl;
  if (desktop) profiles = await api('profiles-load');
  renderProfiles(); renderUsage(); update();
  await run('한글 설치 정보를 확인하는 중…', async () => { await checkConnection(); status('설정에서 AI를 연결하고 모델을 선택하면 대화를 시작할 수 있습니다.'); });
  document.body.dataset.ready = 'true';
} catch (error) { status(error.message, true); }
