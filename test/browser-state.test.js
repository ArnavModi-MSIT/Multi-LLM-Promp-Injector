import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePrompt, currentNoticeTexts } from '../src/browser-state.js';
import { getProvider, providerIds, providerSendCode, providerPreflightCode } from '../src/providers.js';

test('prompt comparison preserves blank lines and code indentation', () => {
  assert.equal(normalizePrompt('first\r\nsecond'), normalizePrompt('first\nsecond'));
  assert.notEqual(normalizePrompt('first\n\nsecond'), normalizePrompt('first\nsecond'));
  assert.notEqual(normalizePrompt('def f():\n    pass'), normalizePrompt('def f():\npass'));
});

function enterFixture({ readError = false, acknowledged = false, id = 'deepseek', timeouts = {} } = {}) {
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
    waitForTimeout: async ms => { now += ms; if (!acknowledged && now >= 180000) throw new Error('Test stopped waiting without acknowledgement'); },
  };
  const send = new Function('Date', 'return ' + providerSendCode(provider, undefined, [], timeouts))({ now: () => now });
  return { send, page, elapsed: () => now };
}

test('DeepSeek and Kimi Enter cannot claim success after an editor read error', async () => {
  for (const id of ['deepseek', 'kimi']) {
    const { send, page } = enterFixture({ readError: true, id });
    await assert.rejects(send(page), /Editor read failed/);
  }
});

test('clearing the editor alone is not a confirmed submission', async () => {
  const { send, page } = enterFixture();
  await assert.rejects(send(page), /Test stopped waiting without acknowledgement/);
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

test('an unconfirmed Send stops waiting after the send budget and warns that it may have gone out', async () => {
  const { send, page, elapsed } = enterFixture({ timeouts: { sendMs: 1000 } });
  await assert.rejects(send(page), /Submission was not confirmed within 1 seconds\. The prompt may have been sent\. Check this tab before retrying\./);
  assert.ok(elapsed() >= 1000 && elapsed() < 2000, `waited ${elapsed()} ms`);
});

// Qwen ignores Send while it is still processing an attachment. These fixtures replay that.
function ignoredSendFixture({ acceptOnClick = 2, onClick = {}, sendMs = 120000 } = {}) {
  const provider = getProvider('qwen');
  let now = 0;
  const state = { clicks: 0, text: 'hello', staged: true, turns: 0 };
  const empty = { count: async () => 0, first() { return this; } };
  const composer = { first() { return this; }, count: async () => 1, locator: () => empty,
    evaluate: async fn => fn.name === 'readComposerText' ? state.text : state.staged };
  const send = { count: async () => 1, click: async () => {
    state.clicks++;
    onClick[state.clicks]?.(state);
    if (state.clicks >= acceptOnClick) { state.text = ''; state.staged = false; state.turns = 1; }
  } };
  const page = {
    url: () => provider.url, getByRole: () => empty, setDefaultTimeout() {}, setDefaultNavigationTimeout() {},
    locator: selector => selector === provider.editor ? composer
      : selector === provider.reply || selector === provider.user ? { count: async () => state.turns }
      : selector.includes('aria-label="Send"') ? send : empty,
    waitForTimeout: async ms => { now += ms; },
  };
  const run = new Function('Date', 'return ' + providerSendCode(provider, undefined, ['notes.md'], { sendMs }))({ now: () => now });
  return { run: () => run(page), state, elapsed: () => now };
}

test('Qwen clicks Send again only after an ignored click leaves the prompt and file staged', async () => {
  const fixture = ignoredSendFixture({ acceptOnClick: 3 });
  const receipt = await fixture.run();
  assert.equal(fixture.state.clicks, 3);
  assert.equal(receipt.submitted, true);
  assert.equal(receipt.retries, 2);
  assert.ok(fixture.elapsed() >= 30000 && fixture.elapsed() < 31000, `waited ${fixture.elapsed()} ms`);
});

test('an accepted first click is never repeated and reports no retries', async () => {
  const fixture = ignoredSendFixture({ acceptOnClick: 1 });
  const receipt = await fixture.run();
  assert.equal(fixture.state.clicks, 1);
  assert.deepEqual(Object.keys(receipt).sort(), ['submitted', 'url']);
});

test('re-clicks stop after three extra attempts and the run still ends as uncertain', async () => {
  const fixture = ignoredSendFixture({ acceptOnClick: 99, sendMs: 80000 });
  await assert.rejects(fixture.run(), /Submission was not confirmed within 80 seconds\. The prompt may have been sent/);
  assert.equal(fixture.state.clicks, 4, 'one click plus at most three guarded re-clicks');
});

test('no re-click when the composer text or the staged file changed after the first click', async () => {
  for (const change of [state => { state.text = 'hello (edited)'; }, state => { state.staged = false; }]) {
    const fixture = ignoredSendFixture({ acceptOnClick: 99, sendMs: 60000, onClick: { 1: change } });
    await assert.rejects(fixture.run(), /not confirmed/);
    assert.equal(fixture.state.clicks, 1);
  }
});

test('only Qwen settles after uploads and re-clicks; other sites keep a single send', () => {
  for (const id of providerIds) {
    const provider = getProvider(id);
    const preflight = providerPreflightCode(provider, 'hello', ['notes.md']);
    const send = providerSendCode(provider, 'hello', ['notes.md']);
    assert.equal(/await page\.waitForTimeout\(8000\);/.test(preflight), id === 'qwen', `${id} settle`);
    assert.equal(send.includes('resend:'), id === 'qwen', `${id} re-click`);
    assert.equal(/await page\.waitForTimeout\(8000\);/.test(providerPreflightCode(provider, 'hello', [])), false, `${id} without files never settles`);
  }
});
