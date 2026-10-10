import test from 'node:test';
import assert from 'node:assert/strict';
import { getProvider, providerAvailabilityCode, providerResponseCode } from '../src/providers.js';

test('only active notices block availability, not conversation body text', async () => {
  const check = new Function('return ' + providerAvailabilityCode(getProvider('gemini')))();
  let notices = [];
  const page = { url: () => 'https://gemini.google.com/app', locator: selector => {
    assert.notEqual(selector, 'body');
    return { filter() { return this; }, allTextContents: async () => notices };
  } };
  assert.equal((await check(page)).available, true);
  notices = ['You have reached your daily limit'];
  assert.equal((await check(page)).available, false);
});

test('capture refuses a different tab before reading any response', async () => {
  for (const id of ['chatgpt', 'gemini', 'deepseek', 'kimi', 'claude']) {
    const capture = new Function('return ' + providerResponseCode(getProvider(id), { captureId: 'sent-tab', previousReplies: 0, previousCopyButtons: 0 }))();
    await assert.rejects(capture({ __promptInjectorCaptureId: 'other-tab' }), /Submission tab changed/);
  }
});

test('ChatGPT preflight waits for upload readiness and preserves timeout diagnostics', async () => {
  const { preflightCode } = await import('../src/sites/chatgpt.js');
  const preflight = new Function('return ' + preflightCode('hello'))();
  const editor = { first() { return this; }, evaluate: async () => 'hello' };
  const send = { count: async () => 1, async click(options) {
    assert.equal(options.trial, true);
    assert.equal(options.timeout, 60000);
    throw new Error('control is disabled');
  } };
  const page = { url: () => 'https://chatgpt.com/', getByRole: () => send, locator: selector => {
    if (selector.includes('prompt-textarea')) return editor;
    if (selector === '[data-testid="stop-button"]:visible') return { count: async () => 0 };
    assert.match(selector, /:not\(\[data-testid="stop-button"\]\)/);
    return send;
  } };
  await assert.rejects(preflight(page), /Details: control is disabled/);
});
