// Explicit opt-in smoke check: starts a temporary loopback server and never
// connects to Chrome or submits to a provider.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const port = Number(process.env.PROMPT_INJECTOR_TEST_PORT ?? 4189);
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['src/local-server.js'], {
  env: { ...process.env, PROMPT_INJECTOR_PORT: String(port), PROMPT_INJECTOR_OPEN_BROWSER: '0' },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let diagnostics = '';
child.stderr.on('data', chunk => { diagnostics += chunk; });
const closed = once(child, 'exit');
function request(method, url, headers = {}, data) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path: url, headers, timeout: 5000 }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('HTTP check timed out')));
    req.end(data);
  });
}
try {
  await Promise.race([
    once(child.stdout, 'data'),
    closed.then(() => { throw new Error('Temporary server exited: ' + diagnostics); }),
  ]);
  const page = await request('GET', '/');
  assert.equal(page.status, 200);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  const token = page.body.match(/const sessionToken = '([^']+)'/)[1];
  assert.notEqual(token, '__LOCAL_SESSION_TOKEN__');
  const headers = { 'X-Prompt-Injector-Token': token, Origin: origin };
  assert.equal((await request('GET', '/api/status')).status, 403);
  assert.equal((await request('GET', '/api/status', { ...headers, Host: 'example.com' })).status, 403);
  assert.equal((await request('GET', '/api/status', { ...headers, Origin: 'https://example.com' })).status, 403);
  assert.equal((await request('GET', '/other/../api/status')).status, 403);
  assert.equal((await request('GET', '//example.com/api/status', headers)).status, 403);
  assert.equal((await request('GET', '/api/status', headers)).status, 404);
  assert.equal((await request('POST', '/api/clear', headers)).status, 200);
  // Exercise the maximum decoded file budget without ever launching Chrome:
  // the credential filename is rejected after both buffers have been decoded.
  const tenMB = Buffer.alloc(10 * 1024 * 1024).toString('base64');
  const fullSize = JSON.stringify({ prompt: 'x'.repeat(100000), providers: ['chatgpt'], files: [
    { name: '.env', base64: tenMB }, { name: 'dummy.bin', base64: tenMB },
  ] });
  const rejected = await request('POST', '/api/submit', { ...headers, 'Content-Type': 'application/json' }, fullSize);
  assert.equal(rejected.status, 400);
  assert.match(rejected.body, /credentials/);
  assert.equal((await request('POST', '/api/clear', headers)).status, 200);
  assert.equal((await request('POST', '/api/submit', { ...headers, 'Content-Type': 'application/json' }, '{')).status, 400);
  assert.equal((await request('POST', '/api/submit', { ...headers, 'Content-Type': 'application/json' }, 'null')).status, 400);
  assert.equal((await request('POST', '/api/clear', headers)).status, 200);
  console.log('HTTP smoke check passed: page, framing headers, token, Host/Origin/URL rejection, 20 MB decoded payload, malformed bodies, and lock recovery.');
} finally {
  child.kill();
  await closed;
}
