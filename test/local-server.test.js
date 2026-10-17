import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { providers, getProvider, validateProviderFiles, providerReadyCode, providerAvailabilityCode, providerPrepareCode, providerPreflightCode, providerSubmissionCode, providerResponseCode } from '../src/providers.js';
import { stageAttachmentPaths } from '../src/attachment-paths.js';
import { toolValue } from '../src/tool-result.js';
import { isBrowserDisconnect } from '../src/playwright-bridge.js';
import { validateAttachmentList, attachmentMimeType } from '../src/attachments.js';

test('reserves submission while reading a body and releases it after invalid input', async () => {
  let handler;
  let uuid = 0;
  const context = vm.createContext({
    http: { createServer: fn => { handler = fn; return {}; } },
    path: { resolve: () => '', dirname: () => '' }, fileURLToPath: () => '',
    randomUUID: () => String(++uuid), process: { env: {} }, Buffer,
    maxRequestBytes: 1024, URL,
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
  vm.runInContext(html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)[1].replace('__LOCAL_PROVIDER_METADATA__', '[]'), context);
  assert.equal(await vm.runInContext("poll('old-job')", context), true);
  assert.equal(elements.get('submit').disabled, false);
  assert.equal(elements.get('prepare').disabled, false);
  assert.equal(elements.get('error').textContent, 'Job not found.');
});

async function serverFixture(overrides = {}) {
  let handler;
  const context = vm.createContext({
    http: { createServer: fn => { handler = fn; return {}; } },
    path: { resolve: () => '', dirname: () => '', extname: value => value.endsWith('.zip') ? '.zip' : '.md' },
    fileURLToPath: () => '', randomUUID: () => 'token', process: { env: {} }, Buffer, URL,
    maxRequestBytes: 1024, providers, getProvider, validateProviderFiles, validateAttachmentList, attachmentMimeType, isBrowserDisconnect, toolValue, stageAttachmentPaths,
    providerReadyCode, providerAvailabilityCode, providerPrepareCode, providerPreflightCode, providerSubmissionCode, providerResponseCode, ...overrides,
  });
  let source = await fs.readFile(new URL('../src/local-server.js', import.meta.url), 'utf8');
  source = source.replace(/^import .*;$/gm, '').replace('import.meta.url', "'file:///server.js'");
  vm.runInContext(source.slice(0, source.indexOf('server.listen(')), context);
  return { context, handler };
}
const localHeaders = { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', 'x-prompt-injector-token': 'token' };

test('API rejects foreign Host, Origin, URL, and missing tokens even with normalized paths', async () => {
  const { handler } = await serverFixture();
  for (const [url, headers] of [
    ['/api/status', { ...localHeaders, host: 'example.com' }],
    ['/api/status', { ...localHeaders, origin: 'https://example.com' }],
    ['/api/status', { host: localHeaders.host }],
    ['/other/../api/status', { host: localHeaders.host }],
    ['//example.com/api/status', localHeaders],
    ['http://example.com/api/status', localHeaders],
  ]) {
    const response = { writeHead(status) { this.status = status; }, end() {} };
    await handler({ method: 'GET', url, headers }, response);
    assert.equal(response.status, 403, url);
  }
  const response = { writeHead(status) { this.status = status; }, end() {} };
  await handler({ method: 'GET', url: '/api/status-extra', headers: localHeaders }, response);
  assert.equal(response.status, 404);
});

test('submission validates JSON shape and canonical base64 before browser work', async () => {
  const { context } = await serverFixture();
  for (const data of [null, [], { prompt: 'test', files: [{ name: 'one.md', base64: 'A' }] },
    { prompt: 'test', files: [{ name: 'one.md', base64: 'YR==' }] }]) {
    context.data = data;
    assert.throws(() => vm.runInContext('validateSubmission(data)', context));
  }
  context.data = { prompt: 'test', files: [{ name: 'one.zip', base64: 'YQ==' }] };
  const submission = vm.runInContext('validateSubmission(data)', context);
  assert.equal(submission.attachments[0].mimeType, 'application/zip');
  assert.equal(submission.attachments[0].size, 1);
});

test('API rejects ZIP for DeepSeek and Qwen, including mixed-provider jobs', async () => {
  const { context } = await serverFixture();
  for (const providers of [['deepseek'], ['qwen'], ['chatgpt', 'qwen']]) {
    context.data = { prompt: 'review', providers, files: [{ name: 'review.ZIP', base64: 'YQ==' }] };
    assert.throws(() => vm.runInContext('validateSubmission(data)', context), /does not accept ZIP/);
    context.data.files = [{ name: 'review.bin', mimeType: 'application/zip', base64: 'YQ==' }];
    assert.throws(() => vm.runInContext('validateSubmission(data)', context), /does not accept ZIP/);
  }
  context.data = { prompt: 'review', providers: ['qwen'], files: Array.from({ length: 5 }, (_, i) => ({ name: `notes-${i}.txt`, base64: 'YQ==' })) };
  assert.equal(vm.runInContext('validateSubmission(data)', context).selected[0].id, 'qwen');
});

async function uiFixture(fetch) {
  const html = await fs.readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const elements = new Map();
  const context = vm.createContext({ document: { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { disabled: true, addEventListener() {}, replaceChildren() {} });
    return elements.get(id);
  } }, fetch, clearTimeout() {}, setTimeout() {} });
  vm.runInContext(html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)[1].replace('__LOCAL_PROVIDER_METADATA__', '[]'), context);
  return { context, elements };
}

test('repeated network polling failures restore controls instead of looping forever', async () => {
  const { context, elements } = await uiFixture(async () => { throw new Error('offline'); });
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal(await vm.runInContext("poll('job')", context), attempt === 2);
  }
  assert.equal(elements.get('submit').disabled, false);
  assert.match(elements.get('error').textContent, /Refresh this page/);
});

test('a stale polling response cannot overwrite the UI of a newer run', async () => {
  let release;
  const response = new Promise(resolve => { release = resolve; });
  const { context, elements } = await uiFixture(async () => response);
  const poll = vm.runInContext("poll('old-job')", context);
  vm.runInContext('watchVersion++;', context);
  elements.get('status').textContent = 'New run';
  release({ ok: false, status: 404, json: async () => ({ error: 'old error' }) });
  assert.equal(await poll, true);
  assert.equal(elements.get('status').textContent, 'New run');
  assert.equal(elements.get('submit').disabled, true);
});

test('Clear and a new submission are rejected throughout an active job', async () => {
  const { context, handler } = await serverFixture();
  vm.runInContext("currentJob = { id: 'active', status: 'running' };", context);
  for (const url of ['/api/clear', '/api/submit']) {
    const response = { writeHead(status) { this.status = status; }, end() {} };
    await handler({ method: 'POST', url, headers: { ...localHeaders, 'content-type': 'application/json' } }, response);
    assert.equal(response.status, 409);
    assert.equal(vm.runInContext('currentJob.id', context), 'active');
  }
});

function jobFixture(ids = ['chatgpt', 'gemini']) {
  return { results: ids.map(id => ({ id, status: 'queued', response: '', submission: 'not_sent', capture: 'not_started' })) };
}

async function connectionFixture({ captureFailure = false, actionTimeout = false, connectFailure = false } = {}) {
  let connections = 0;
  let closes = 0;
  let current;
  const captures = [];
  const overrides = {
    connectToChrome: async () => { connections++; if (connectFailure) throw new Error('Extension did not connect'); return { close: async () => { closes++; } }; },
    selectProviderTab: async (_, provider) => {
      current = provider;
      if (actionTimeout && provider.id === 'gemini') throw new Error('Send button timed out');
    },
    selectSubmissionTab: async (_, provider) => { captures.push(provider.id); },
    runBrowserTool: async (_, name, { code }) => {
      let value = {};
      if (code.includes('const patterns =')) value = { available: true, url: current.url };
      if (code.includes('const receipt = await')) value = { submitted: true, captureId: current.id, url: current.url };
      return { content: [{ type: 'text', text: JSON.stringify(value) }] };
    },
    collectResponses: async (_, tasks) => {
      let fatal;
      const results = [];
      for (const task of tasks) {
        if (!fatal) await task.beforePoll();
        if (captureFailure) {
          fatal ??= new Error('Transport closed'); await task.onError(fatal); results.push({ task, error: fatal }); continue;
        }
        const response = { text: 'reply', url: 'https://chatgpt.com/c/test' };
        await task.onComplete(response); results.push({ task, response });
      }
      return results;
    },
  };
  const fixture = await serverFixture(overrides);
  fixture.context.job = jobFixture();
  fixture.context.submission = { attachments: [], prompt: 'test', mode: 'send' };
  return { ...fixture, captures, connections: () => connections, closes: () => closes };
}

test('ordinary provider timeouts preserve the connection and pending capture markers', async () => {
  const fixture = await connectionFixture({ actionTimeout: true });
  await vm.runInContext('processJob(job, submission)', fixture.context);
  assert.equal(fixture.connections(), 1);
  assert.equal(fixture.closes(), 0);
  assert.deepEqual(fixture.captures, ['chatgpt']);
  assert.equal(fixture.context.job.results[0].capture, 'complete');
});

test('a capture disconnect stops later capture attempts and reconnects only on the next job', async () => {
  const fixture = await connectionFixture({ captureFailure: true });
  await vm.runInContext('processJob(job, submission)', fixture.context);
  assert.equal(fixture.closes(), 1);
  assert.equal(fixture.connections(), 1);
  assert.deepEqual(fixture.captures, ['chatgpt']);
  assert.equal(fixture.context.job.results[1].capture, 'uncertain');
  fixture.context.job = jobFixture();
  await vm.runInContext('processJob(job, submission)', fixture.context);
  assert.equal(fixture.connections(), 2);
});

test('extension connection failure is attempted once for the entire job', async () => {
  const fixture = await connectionFixture({ connectFailure: true });
  await vm.runInContext('processJob(job, submission)', fixture.context);
  assert.equal(fixture.connections(), 1);
  assert.equal(fixture.context.job.results.every(item => item.status === 'skipped'), true);
});

test('a connection that closes between jobs is not reused by the next job', async () => {
  const fixture = await connectionFixture();
  await vm.runInContext('processJob(job, submission)', fixture.context);
  vm.runInContext('client.onclose();', fixture.context);
  fixture.context.job = jobFixture();
  await vm.runInContext('processJob(job, submission)', fixture.context);
  assert.equal(fixture.connections(), 2);
});

test('unexpected job failures terminalize unfinished results without losing completed replies', async () => {
  const { context } = await serverFixture();
  context.job = { results: [
    { status: 'completed', submission: 'sent', response: 'finished reply', capture: 'complete' },
    { status: 'submitting', submission: 'uncertain', response: '', capture: 'not_started' },
    { status: 'waiting-for-reply', submission: 'sent', response: 'partial reply', capture: 'streaming' },
    { status: 'connecting', submission: 'not_sent', capture: 'not_started' },
  ] };
  vm.runInContext("failJob(job, new Error('unexpected failure'));", context);
  assert.equal(context.job.status, 'error');
  assert.deepEqual(context.job.results.map(item => item.status), ['completed', 'error', 'error', 'skipped']);
  assert.equal(context.job.results[0].response, 'finished reply');
  assert.equal(context.job.results[1].capture, 'uncertain');
  assert.equal(context.job.results[2].capture, 'partial');
});

test('shutdown during a browser action prevents subsequent provider actions', async () => {
  let calls = 0;
  const fixture = await connectionFixture();
  fixture.context.runBrowserTool = async () => {
    calls++;
    vm.runInContext('shuttingDown = true;', fixture.context);
    return { structuredContent: { ready: true } };
  };
  await vm.runInContext('processJob(job, submission)', fixture.context);
  assert.equal(calls, 1);
  assert.equal(fixture.context.job.status, 'error');
  assert.equal(fixture.context.job.results.every(item => item.status === 'skipped'), true);
});

test('a connection completed after shutdown is closed before any provider action', async () => {
  let closed = 0;
  const { context } = await serverFixture({ connectToChrome: async () => {
    vm.runInContext('shuttingDown = true;', context);
    return { close: async () => { closed++; } };
  } });
  context.job = jobFixture();
  context.submission = { attachments: [], prompt: 'test', mode: 'send' };
  await vm.runInContext('processJob(job, submission)', context);
  assert.equal(closed, 1);
  assert.equal(context.job.status, 'error');
  assert.equal(context.job.results.every(item => item.submission === 'not_sent'), true);
});
