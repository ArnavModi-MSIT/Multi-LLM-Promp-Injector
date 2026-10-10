import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

test('reserves submission while reading a body and releases it after invalid input', async () => {
  let handler;
  let uuid = 0;
  const context = vm.createContext({
    http: { createServer: fn => { handler = fn; return {}; } },
    path: { resolve: () => '', dirname: () => '' }, fileURLToPath: () => '',
    randomUUID: () => String(++uuid), process: { env: {} }, Buffer,
    maxRequestBytes: 1024,
  });
  let source = await fs.readFile(new URL('../src/local-server.js', import.meta.url), 'utf8');
  source = source.replace(/^import .*;$/gm, '').replace('import.meta.url', "'file:///server.js'");
  vm.runInContext(source.slice(0, source.indexOf('server.listen(')), context);
  const response = () => ({ writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } });
  const headers = { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'x-prompt-injector-token': '1', 'content-type': 'application/json' };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = handler({ method: 'POST', url: '/api/submit', headers, async *[Symbol.asyncIterator]() { await gate; yield Buffer.from('{'); } }, response());
  const second = response();
  await handler({ method: 'POST', url: '/api/submit', headers }, second);
  assert.equal(second.status, 409);
  const clear = response();
  await handler({ method: 'POST', url: '/api/clear', headers }, clear);
  assert.equal(clear.status, 409);
  release(); await first;
  const after = response();
  await handler({ method: 'POST', url: '/api/clear', headers }, after);
  assert.equal(after.status, 200);
});

test('status HTTP failures stop polling and restore controls', async () => {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const elements = new Map();
  const context = vm.createContext({
    document: { getElementById(id) {
      if (!elements.has(id)) elements.set(id, { disabled: true, addEventListener() {}, replaceChildren() {} });
      return elements.get(id);
    } },
    fetch: async () => ({ ok: false, status: 404, json: async () => ({ error: 'Job not found.' }) }),
    clearTimeout() {}, setTimeout() { throw new Error('Must not keep polling'); },
  });
  vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  assert.equal(await vm.runInContext("poll('old-job')", context), true);
  assert.equal(elements.get('submit').disabled, false);
  assert.equal(elements.get('prepare').disabled, false);
  assert.equal(elements.get('error').textContent, 'Job not found.');
});
