import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const messages = {
  HWP_COM_UNAVAILABLE: '한글 자동화에 연결할 수 없습니다. Windows용 한글 데스크톱 설치와 COM 등록 상태를 확인하세요.',
  HWP_WINDOW_UNAVAILABLE: '연결된 한글 창을 찾을 수 없습니다. 한글 창 연결을 다시 누르세요.',
  HWP_REQUIRED_API_UNAVAILABLE: '이 한글 버전에서 안전한 문서 편집에 필요한 API를 확인하지 못했습니다. 버전 정보와 함께 호환성을 확인하세요.',
  HWP_ALREADY_CONNECTED: '이미 다른 한글 자동화 버전에 연결되어 있습니다. 문서를 저장하고 도우미를 다시 실행해 변경하세요.',
  INVALID_HWP_PROGID: '지원하지 않는 한글 연결 식별자입니다.',
};

export class HwpBridge {
  #child;
  #pending = new Map();
  #sequence = 0;
  #queue = Promise.resolve();
  constructor({ scriptPath = fileURLToPath(new URL('./native/hwp-bridge.ps1', import.meta.url)) } = {}) { this.scriptPath = scriptPath; }

  #start() {
    if (process.platform !== 'win32') throw new Error('한글 연결은 Windows에서만 가능합니다.');
    if (this.#child) return;
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.#child = child;
    child.stdin.on('error', () => {});
    child.stderr.resume();
    createInterface({ input: child.stdout }).on('line', line => {
      let response;
      try { response = JSON.parse(line.replace(/^\uFEFF/, '')); } catch { return; }
      const pending = this.#pending.get(response.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(response.id);
      if (response.ok) pending.resolve(response.data);
      else pending.reject(new Error(messages[response.error] || response.error));
    });
    const fail = () => {
      if (this.#child !== child) return;
      this.#child = undefined;
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('한글 연결이 종료되었습니다. 연결 후 문서를 다시 읽으세요.'));
      }
      this.#pending.clear();
    };
    child.on('error', fail);
    child.on('exit', fail);
  }

  call(command, args = {}) {
    const task = this.#queue.then(() => new Promise((resolve, reject) => {
      try { this.#start(); } catch (error) { reject(error); return; }
      const id = ++this.#sequence;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        // 늦은 쓰기 작업이 다음 명령과 섞이지 않도록 브리지를 중단합니다.
        const child = this.#child;
        this.#child = undefined;
        child?.kill();
        reject(new Error('한글 응답 시간이 초과되었습니다. 보안 확인창을 확인하고 문서 상태를 직접 확인하세요. 같은 작업을 자동 재시도하지 않습니다.'));
      }, 120_000);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(JSON.stringify({ id, command, ...args }) + '\n');
    }));
    this.#queue = task.catch(() => {});
    return task;
  }

  stop() { this.#child?.kill(); }
}
