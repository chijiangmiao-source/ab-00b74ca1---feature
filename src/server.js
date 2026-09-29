'use strict';

// 零依赖 HTTP 服务：页面、健康路径、审计接口。
const http = require('http');
const { audit } = require('./bisimulation');
const { samples } = require('./samples');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req, limit = 1024 * 256) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('BODY_TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'GET' && url.pathname === '/healthz') {
    sendJson(res, 200, { status: 'ok' });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/samples') {
    sendJson(res, 200, samples);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/audit') {
    let payload;
    try {
      const raw = await readBody(req);
      payload = JSON.parse(raw);
    } catch (e) {
      sendJson(res, 400, { ok: false, equivalent: null, errors: [{ code: 'BAD_JSON', field: 'body', side: null, message: '请求体不是合法 JSON' }], rounds: [], eliminatedPairs: [], firstEliminated: null, initialPairs: [] });
      return;
    }
    const result = audit(payload.procA, payload.procB);
    // 输入无效时同样以 200 返回结构化问题集合（结论字段为空，表示已清除旧结论）；
    // 仅结构错误（非 JSON）才返回 400。
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(require('fs').readFileSync(require('path').join(__dirname, 'public', 'index.html')));
    return;
  }

  sendJson(res, 404, { error: 'NOT_FOUND' });
});

server.listen(PORT, HOST, () => {
  console.log(`silent-jump-audit listening on http://${HOST}:${PORT}`);
});

module.exports = server;
