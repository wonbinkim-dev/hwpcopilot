import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { HwpBridge } from './bridge.js';
import { DocumentService } from './document-service.js';

export function createApp({ bridge = new HwpBridge(), generateText, listAvailableModels } = {}) {
  const token = randomBytes(32).toString('hex');
  const service = new DocumentService({ bridge, generateText, listAvailableModels });
  const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/chat-state.js': ['chat-state.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
  const server = http.createServer(async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    const expectedHost = `127.0.0.1:${server.address()?.port}`;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (req.headers.host !== expectedHost || (req.headers.origin && req.headers.origin !== `http://${expectedHost}`)) return send(403, { error: '허용되지 않은 접근입니다.' });
    try {
      if (req.method === 'GET' && assets[req.url]) {
        const [file, type] = assets[req.url];
        const content = await readFile(new URL(`./public/${file}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(content); return;
      }
      if (req.method === 'GET' && req.url === '/api/session') return send(200, { token, ...await service.execute('session') });
      if (req.method !== 'POST' || req.headers['x-session-token'] !== token || !req.headers['content-type']?.startsWith('application/json')) return send(403, { error: '요청이 허용되지 않았습니다.' });
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2_000_000) return send(413, { error: '요청이 너무 큽니다.' });
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      const args = JSON.parse(body || '{}');
      return send(200, await service.execute(req.url?.startsWith('/api/') ? req.url.slice(5) : '', args));
    } catch (error) {
      send(error.status || 400, { error: error instanceof SyntaxError ? '잘못된 JSON 요청입니다.' : error.message, usage: error.usage || null });
    }
  });
  server.on('close', () => bridge.stop());
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createApp();
  const port = Number(process.env.PORT || 3210);
  server.listen(port, '127.0.0.1', () => console.log(`한글 Copilot 실행: http://127.0.0.1:${server.address().port}\n종료: Ctrl+C (한글 문서는 직접 저장하세요)`));
  server.on('error', error => { console.error(`실행 실패: ${error.message}`); process.exitCode = 1; });
  process.on('SIGINT', () => { server.close(); server.closeAllConnections(); });
}
