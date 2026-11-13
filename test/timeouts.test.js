import test from 'node:test';
import assert from 'node:assert/strict';
import { stepTimeouts, resolveTimeouts } from '../src/timeouts.js';
import { providerIds, getProvider, providerReadyCode, providerAvailabilityCode, providerPrepareCode, providerPreflightCode, providerSubmissionCode } from '../src/providers.js';
import { prepareProvider } from '../src/preparation.js';
import { selectProviderTab } from '../src/playwright-bridge.js';

test('step budgets have sensible defaults and validated environment overrides', () => {
  assert.deepEqual(stepTimeouts({}), { readyMs: 180_000, prepareMs: 600_000, sendMs: 300_000 });
  assert.deepEqual(stepTimeouts({ PROMPT_INJECTOR_READY_SECONDS: '30', PROMPT_INJECTOR_PREPARE_SECONDS: '1200', PROMPT_INJECTOR_SEND_SECONDS: '' }),
    { readyMs: 30_000, prepareMs: 1_200_000, sendMs: 300_000 });
  for (const bad of ['0', '-5', 'abc', '86401', 'Infinity']) {
    assert.throws(() => stepTimeouts({ PROMPT_INJECTOR_READY_SECONDS: bad }), /PROMPT_INJECTOR_READY_SECONDS must be/);
  }
  assert.throws(() => resolveTimeouts({ sendMs: 0 }, {}), /positive whole number/);
  assert.equal(resolveTimeouts({ sendMs: 5 }, {}).sendMs, 5);
});

test('no generated browser code waits without a deadline', () => {
  const files = ['notes.md'];
  for (const id of providerIds) {
    const provider = getProvider(id);
    for (const code of [providerReadyCode(provider), providerAvailabilityCode(provider), providerPreflightCode(provider, 'hello', files), providerSubmissionCode(provider, 'hello', files)]) {
      assert.doesNotMatch(code, /timeout:\s*0\b/, `${id} must not use an unlimited Playwright timeout`);
      assert.doesNotMatch(code, /setDefault(?:Navigation)?Timeout\?\.\(0\)/, `${id} must not reset page defaults to unlimited`);
    }
  }
});

test('preparation code is bounded by one deadline across fills, uploads and confirmation', async () => {
  for (const id of providerIds) {
    const code = await providerPrepareCode(getProvider(id), 'hello', [{ name: 'notes.md', path: '/tmp/notes.md', mimeType: 'text/markdown' }], { prepareMs: 90_000 });
    assert.doesNotMatch(code, /timeout:\s*0\b/);
    assert.match(code, /const deadline = Date\.now\(\) \+ 90000;/);
    assert.match(code, /did not finish within 90 seconds\. Nothing was sent\./);
    assert.match(code, /while \(attachments\.length\) \{\s*left\(\);/);
  }
});

test('a missing or signed-out composer fails that site with a clear message', async () => {
  const provider = getProvider('chatgpt');
  const seen = [];
  const empty = { first() { return this; }, waitFor: async options => { seen.push(options); throw new Error('Timeout 2000ms exceeded'); } };
  const page = { url: () => provider.url, locator: () => empty, setDefaultTimeout: ms => seen.push(['default', ms]), setDefaultNavigationTimeout() {} };
  const ready = new Function('return ' + providerReadyCode(provider, { readyMs: 2000 }))();
  await assert.rejects(ready(page), /ChatGPT composer was not found within 2 seconds\. Sign in .* Nothing was sent\./);
  assert.deepEqual(seen, [['default', 2000], { state: 'visible', timeout: 2000 }]);
});

test('attachment confirmation before Send stops waiting after the preparation budget', async () => {
  const provider = getProvider('gemini');
  let now = 0;
  const composer = { first() { return this; }, count: async () => 1, locator: () => ({ count: async () => 0 }),
    evaluate: async fn => fn.name === 'readComposerText' ? 'hello' : false };
  const page = { url: () => provider.url, locator: () => composer, getByRole: () => ({ count: async () => 0 }),
    setDefaultTimeout() {}, setDefaultNavigationTimeout() {}, waitForTimeout: async ms => { now += ms; } };
  const preflight = new Function('Date', 'return ' + providerPreflightCode(provider, 'hello', ['notes.md'], { prepareMs: 1000 }))({ now: () => now });
  await assert.rejects(preflight(page), /Gemini attachments were not confirmed within 1 seconds: notes\.md\. Nothing was sent\./);
  assert.ok(now >= 1000 && now < 2000, `waited ${now} ms`);
});

test('preparation polling gives up when the snippet stops reporting back', async () => {
  const tool = async (_, name, { code }) => {
    const id = JSON.parse(code.match(/const state = \{ id: ("[^"]+")/)?.[1] ?? 'null') ?? undefined;
    if (id) tool.id = id;
    return { structuredContent: { id: tool.id, status: 'running' } };
  };
  const started = Date.now();
  await assert.rejects(prepareProvider({}, getProvider('gemini'), 'hello', [], { tool, timeouts: { prepareMs: 150 }, graceMs: 0 }), /did not report back in time\. Nothing was sent\./);
  assert.ok(Date.now() - started < 3000);
});

test('tab selection stops waiting for a provider tab that never opens', async () => {
  const client = { callTool: async () => ({ content: [{ type: 'text', text: '### Result\n- 0: (current) [Start](about:blank)' }] }) };
  await assert.rejects(selectProviderTab(client, getProvider('claude'), { requireExisting: true, timeoutMs: 300 }), /Claude tab did not become accessible/);
});
