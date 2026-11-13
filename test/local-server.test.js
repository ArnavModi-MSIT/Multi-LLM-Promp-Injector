import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { providers, getProvider, validateProviderFiles, providerReadyCode, providerAvailabilityCode, providerPrepareCode, providerPreflightCode, providerSubmissionCode } from '../src/providers.js';
import { stageAttachmentPaths } from '../src/attachment-paths.js';
import { toolValue } from '../src/tool-result.js';
import { isBrowserDisconnect } from '../src/playwright-bridge.js';
import { validateAttachmentList, attachmentMimeType } from '../src/attachments.js';
import { prepareProvider } from '../src/preparation.js';

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
    maxRequestBytes: 1024, createAttachmentTransfer: async files => ({ files, close: async () => {} }), providers, getProvider, validateProviderFiles, validateAttachmentList, attachmentMimeType, isBrowserDisconnect, toolValue, stageAttachmentPaths,
    prepareProvider, providerReadyCode, providerAvailabilityCode, providerPrepareCode, providerPreflightCode, providerSubmissionCode, ...overrides,
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
  context.data = { prompt: 'test', providers: ['chatgpt'], files: [{ name: 'one.zip', base64: 'YQ==' }] };
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
  return { results: ids.map(id => ({ id, status: 'queued', submission: 'not_sent' })) };
}

async function connectionFixture({ disconnect = false, actionTimeout = false, connectFailure = false } = {}) {
  let connections = 0;
  let closes = 0;
  let current;
  const overrides = {
    connectToChrome: async () => { connections++; if (connectFailure) throw new Error('Extension did not connect'); return { close: async () => { closes++; } }; },
    selectProviderTab: async (_, provider) => {
      current = provider;
      if (disconnect && provider.id === 'gemini') throw new Error('Transport closed');
      if (actionTimeout && provider.id === 'gemini') throw new Error('Send button timed out');
    },
    runBrowserTool: async (_, name, { code }) => {
      let value = {};
      if (code.includes('page.__promptInjectorPreparation = state')) {
        value = { id: JSON.parse(code.match(/const state = \{ id: ("[^"]+")/)[1]), status: 'complete', result: { promptPrepared: true } };
      }
      if (code.includes('const patterns =')) value = { available: true, url: current.url };
      if (code.includes('const receipt = await')) value = { submitted: true, url: current.url };
      return { content: [{ type: 'text', text: JSON.stringify(value) }] };
    },
  };
  const fixture = await serverFixture(overrides);
  fixture.context.job = jobFixture();
  fixture.context.submission = { attachments: [], prompt: 'test', mode: 'send' };
  return { ...fixture, connections: () => connections, closes: () => closes };
}

test('ordinary provider timeouts preserve the connection and completed submissions', async () => {
  const fixture = await connectionFixture({ actionTimeout: true });
  await vm.runInContext('processJob(job, submission)', fixture.context);
  assert.equal(fixture.connections(), 1); assert.equal(fixture.closes(), 0);
  assert.equal(fixture.context.job.results[0].status, 'submitted');
  assert.equal(Object.hasOwn(fixture.context.job.results[0], 'response'), false);
  assert.equal(Object.hasOwn(fixture.context.job.results[0], 'capture'), false);
});

test('a disconnect stops remaining actions and reconnects only on the next job', async () => {
  const fixture = await connectionFixture({ disconnect: true });
  await vm.runInContext('processJob(job, submission)', fixture.context);
  assert.equal(fixture.closes(), 1); assert.equal(fixture.connections(), 1);
  assert.equal(fixture.context.job.results[0].status, 'submitted');
  assert.equal(fixture.context.job.results[1].submission, 'not_sent');
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

test('unexpected failures preserve submitted sites and finalize unfinished submissions', async () => {
  const { context } = await serverFixture();
  context.job = { results: [
    { status: 'submitted', submission: 'sent' },
    { status: 'submitting', submission: 'uncertain' },
    { status: 'connecting', submission: 'not_sent' },
  ] };
  vm.runInContext("failJob(job, new Error('unexpected failure'));", context);
  assert.equal(context.job.status, 'error');
  assert.deepEqual(context.job.results.map(item => item.status), ['submitted', 'error', 'skipped']);
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

test('web defaults to all six sites and finishes immediately after sending', async () => {
  const fixture = await connectionFixture();
  fixture.context.data = { prompt: 'same prompt', files: [] };
  const selected = vm.runInContext('validateSubmission(data).selected', fixture.context);
  assert.equal(selected.length, 6);
  fixture.context.job = jobFixture(selected.map(provider => provider.id));
  await vm.runInContext('processJob(job, submission)', fixture.context);
  assert.equal(fixture.context.job.status, 'completed');
  assert.equal(fixture.context.job.phase, 'finished');
  assert.equal(fixture.context.job.results.every(item => item.status === 'submitted' && item.submission === 'sent'), true);
  assert.equal(fixture.context.job.results.some(item => 'capture' in item || 'response' in item), false);
});

async function cancelFixture() {
  const fixture = await connectionFixture();
  const original = fixture.context.runBrowserTool;
  let reached; const entered = new Promise(resolve => { reached = resolve; });
  let release; const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  fixture.context.runBrowserTool = async (...args) => { if (++calls === 1) { reached(); await gate; } return original(...args); };
  fixture.context.job.status = 'running';
  vm.runInContext('currentJob = job;', fixture.context);
  return { ...fixture, entered, release, calls: () => calls };
}
const cancelRequest = (handler, headers = localHeaders) => {
  const response = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  return handler({ method: 'POST', url: '/api/cancel', headers }, response).then(() => response);
};

test('Cancel needs a same-origin request and a running job', async () => {
  const { handler, context } = await serverFixture();
  assert.equal((await cancelRequest(handler)).status, 409);
  vm.runInContext("currentJob = { id: 'active', status: 'running', results: [] };", context);
  assert.equal((await cancelRequest(handler, { host: localHeaders.host, 'x-prompt-injector-token': 'token' })).status, 403);
  assert.equal((await cancelRequest(handler, { ...localHeaders, origin: 'https://example.com' })).status, 403);
  assert.equal(vm.runInContext('currentJob.status', context), 'running');
});

test('Cancel during a browser action stops the job, closes Chrome and sends nothing', async () => {
  const fixture = await cancelFixture();
  const run = vm.runInContext('processJob(job, submission)', fixture.context);
  await fixture.entered;
  const response = await cancelRequest(fixture.handler);
  assert.equal(response.status, 200);
  assert.equal(fixture.closes(), 1, 'the Playwright connection is closed to interrupt the action');
  assert.equal(vm.runInContext('client', fixture.context), undefined);
  fixture.release();
  await run;
  const { job } = fixture.context;
  assert.equal(job.status, 'cancelled');
  assert.equal(job.phase, 'finished');
  assert.deepEqual(job.results.map(item => item.status), ['skipped', 'skipped']);
  assert.equal(job.results.every(item => item.submission === 'not_sent' && /Cancelled by you\. Nothing was sent\./.test(item.error)), true);
  assert.equal(fixture.calls(), 1, 'no further browser action runs after Cancel');
  // The page can start a new run: Clear is no longer blocked.
  const clear = { writeHead(status) { this.status = status; }, end() {} };
  await fixture.handler({ method: 'POST', url: '/api/clear', headers: localHeaders }, clear);
  assert.equal(clear.status, 200);
});

test('Cancel keeps earlier submissions and flags a send that was already under way', async () => {
  const { context } = await serverFixture();
  context.job = { status: 'running', results: [
    { status: 'submitted', submission: 'sent' },
    { status: 'submitting', submission: 'uncertain' },
    { status: 'queued', submission: 'not_sent' },
  ] };
  vm.runInContext('cancelJob(job);', context);
  assert.equal(context.job.status, 'cancelled');
  assert.deepEqual(context.job.results.map(item => item.status), ['submitted', 'error', 'skipped']);
  assert.match(context.job.results[1].error, /submission may have occurred/);
});

test('Cancel while still connecting does not let the stale job touch Chrome later', async () => {
  let connect;
  const connected = new Promise(resolve => { connect = resolve; });
  const fixture = await connectionFixture();
  let toolCalls = 0;
  fixture.context.connectToChrome = async () => { await connected; return { close: async () => {} }; };
  fixture.context.runBrowserTool = async () => { toolCalls++; return { content: [{ type: 'text', text: '{}' }] }; };
  fixture.context.job.status = 'running';
  vm.runInContext('currentJob = job;', fixture.context);
  const run = vm.runInContext('processJob(job, submission)', fixture.context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await cancelRequest(fixture.handler)).status, 200);
  connect();
  await run;
  assert.equal(toolCalls, 0);
  assert.equal(fixture.context.job.status, 'cancelled');
});

test('the page shows Cancel only while running and restores controls afterwards', async () => {
  const job = status => ({ ok: true, status: 200, json: async () => ({ id: 'j', status, currentProvider: null, currentIndex: 0, results: [] }) });
  // The page asks once on load whether a job is already running. Answer "none"
  // to that first request so only the explicit poll below reports the status.
  const afterLoad = status => { let loaded = false; return async () => { if (!loaded) { loaded = true; return { ok: false, status: 404, json: async () => ({}) }; } return job(status); }; };
  for (const [state, hidden, done] of [['running', false, false], ['cancelled', true, true], ['completed', true, true]]) {
    const { context, elements } = await uiFixture(afterLoad(state));
    assert.equal(await vm.runInContext("poll('j')", context), done);
    assert.equal(elements.get('cancel').hidden, hidden, state);
    if (done) { assert.equal(elements.get('submit').disabled, false); assert.equal(elements.get('prepare').disabled, false); }
  }
  const { context, elements } = await uiFixture(afterLoad('cancelled'));
  await vm.runInContext("poll('j')", context);
  assert.match(elements.get('status').textContent, /Cancelled\. Check the provider tabs/);
});

test('a re-clicked Send is reported on the site so a possible duplicate can be checked', async () => {
  const fixture = await connectionFixture();
  const original = fixture.context.runBrowserTool;
  fixture.context.runBrowserTool = async (client, name, args) => args.code?.includes('const receipt = await')
    ? { content: [{ type: 'text', text: JSON.stringify({ submitted: true, url: 'https://chat.qwen.ai/c/1', retries: 1 }) }] }
    : original(client, name, args);
  fixture.context.job = jobFixture(['qwen', 'chatgpt']);
  await vm.runInContext('processJob(job, submission)', fixture.context);
  const [qwen, other] = fixture.context.job.results;
  assert.equal(qwen.status, 'submitted');
  assert.match(qwen.note, /Qwen ignored the first Send click, so Send was clicked 1 more time\. Check the conversation for a duplicate message\./);
  assert.match(other.note, /ChatGPT ignored the first Send click/);
});
