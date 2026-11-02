import { randomUUID } from 'node:crypto';
import { generateWithUsage, listModels, providers, validateHistory } from './providers.js';

export class DocumentService {
  #snapshot = null;
  #revision = null;
  #busy = false;
  constructor({ bridge, generateText = generateWithUsage, listAvailableModels = listModels, onWindow = () => {} }) {
    this.bridge = bridge;
    this.generateText = generateText;
    this.listAvailableModels = listAvailableModels;
    this.onWindow = onWindow;
  }
  invalidate() { this.#snapshot = null; this.#revision = null; }
  async execute(route, args = {}) {
    if (route === 'session') return { providers };
    if (this.#busy) { const error = new Error('진행 중인 작업이 끝난 뒤 다시 시도하세요.'); error.status = 409; throw error; }
    this.#busy = true;
    try {
      switch (route) {
        case 'models': return await this.listAvailableModels(args.config);
        case 'diagnostics': return await this.bridge.call('diagnostics');
        case 'connect': {
          this.invalidate();
          const result = await this.bridge.call('connect', { progId: args.progId || 'HWPFrame.HwpObject' });
          await this.onWindow(result);
          return result;
        }
        case 'open': {
          this.invalidate();
          const connection = await this.bridge.call('connect', { progId: args.progId || 'HWPFrame.HwpObject' });
          await this.onWindow(connection);
          if (connection.editingSupported === false) throw new Error('이 한글 버전에서 문서 편집에 필요한 API를 확인하지 못했습니다.');
          const result = await this.bridge.call('open');
          if (result.cancelled) return { ...connection, cancelled: true };
          this.#snapshot = result;
          this.#revision = randomUUID();
          await this.onWindow(result);
          return { ...connection, ...result, revision: this.#revision };
        }
        case 'read': {
          this.invalidate();
          const result = await this.bridge.call('read');
          this.#snapshot = result;
          this.#revision = randomUUID();
          await this.onWindow(result);
          return { ...result, revision: this.#revision };
        }
        case 'generate': {
          const document = args.revision != null && args.revision === this.#revision ? this.#snapshot : null;
          if (args.revision != null && !document) throw new Error('한글 문서를 먼저 읽으세요.');
          if (typeof args.instruction !== 'string' || !args.instruction.trim()) throw new Error('작업 지시를 입력하세요.');
          if (!['insert', 'replace'].includes(args.mode)) throw new Error('적용 방식을 선택하세요.');
          if (!['none', 'selection', 'document'].includes(args.scope)) throw new Error('문맥 범위를 선택하세요.');
          if (args.scope !== 'none' && !document) throw new Error('문서 문맥을 보내려면 한글 문서를 먼저 읽으세요.');
          const context = args.scope === 'document' ? document.text : args.scope === 'selection' ? document.selection : '';
          if (context.length > 150_000) throw new Error('문서가 너무 깁니다. 선택 영역만 보내도록 변경하세요.');
          const history = validateHistory(args.history);
          const result = await this.generateText(args.config, args.instruction, context, undefined, history);
          return { ...(typeof result === 'string' ? { text: result, usage: null } : result), revision: document ? this.#revision : null };
        }
        case 'apply': {
          if (!this.#snapshot || args.revision !== this.#revision) throw new Error('문서 상태가 만료되었습니다. 다시 읽으세요.');
          if (!['insert', 'replace'].includes(args.mode) || typeof args.text !== 'string' || !args.text.trim() || args.text.length > 200_000) throw new Error('적용할 본문과 방식을 확인하세요.');
          if (args.mode === 'replace' && !this.#snapshot.selection?.trim()) throw new Error('한글에서 수정할 문장을 선택한 뒤 문서를 읽으세요.');
          if (args.mode === 'insert' && this.#snapshot.selection) throw new Error('한글에서 선택을 해제하고 커서를 놓은 뒤 문서를 다시 읽으세요.');
          this.invalidate();
          return await this.bridge.call('apply', { text: args.text, mode: args.mode });
        }
        case 'save':
          this.invalidate();
          return await this.bridge.call('save');
        default: { const error = new Error('찾을 수 없는 요청입니다.'); error.status = 404; throw error; }
      }
    } finally { this.#busy = false; }
  }
}
