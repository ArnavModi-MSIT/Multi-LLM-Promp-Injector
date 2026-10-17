import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePrompt, currentNoticeTexts } from '../src/browser-state.js';
import { getProvider, providerSendCode } from '../src/providers.js';

test('prompt comparison preserves blank lines and code indentation', () => {
  assert.equal(normalizePrompt('first\r\nsecond'), normalizePrompt('first\nsecond'));
  assert.notEqual(normalizePrompt('first\n\nsecond'), normalizePrompt('first\nsecond'));
  assert.notEqual(normalizePrompt('def f():\n    pass'), normalizePrompt('def f():\npass'));
});

function enterFixture({ readError = false, acknowledged = false, id = 'deepseek' } = {}) {
  const provider = getProvider(id);
  let submitted = false;
  let now = 0;
  const empty = { count: async () => 0 };
  const composer = {
    first() { return this; }, count: async () => 1, locator: () => empty,
    evaluate: async () => {
      if (submitted && readError) throw new Error('Editor read failed');
      return submitted ? '' : 'test';
    },
    press: async () => { submitted = true; },
  };
  const page = {
    url: () => provider.url,
    locator: selector => selector.startsWith('textarea') ? composer
      : selector === provider.reply ? { count: async () => submitted && acknowledged ? 1 : 0 } : empty,
    getByRole: () => empty,
    waitForTimeout: async ms => { now += ms; },
  };
  const send = new Function('Date', 'return ' + providerSendCode(provider))({ now: () => now });
  return { send, page };
}

test('DeepSeek and Kimi Enter cannot claim success after an editor read error', async () => {
  for (const id of ['deepseek', 'kimi']) {
    const { send, page } = enterFixture({ readError: true, id });
    await assert.rejects(send(page), /Editor read failed/);
  }
});

test('clearing the editor alone is not a confirmed submission', async () => {
  const { send, page } = enterFixture();
  await assert.rejects(send(page), /Submission was not confirmed/);
});

test('a cleared editor and a new reply confirm the single Enter attempt', async () => {
  const { send, page } = enterFixture({ acknowledged: true });
  assert.equal((await send(page)).submitted, true);
});

test('aria-live conversation content cannot become a usage-limit notice', () => {
  const message = { innerText: 'too many requests', closest: () => ({}), querySelector: () => null };
  const container = { innerText: 'daily limit reached', closest: () => null, querySelector: () => ({}) };
  const alert = { innerText: 'usage limit exceeded', closest: () => null, querySelector: () => null };
  assert.deepEqual(currentNoticeTexts([message, container, alert]), ['usage limit exceeded']);
});
