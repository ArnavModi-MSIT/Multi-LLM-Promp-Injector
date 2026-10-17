import test from 'node:test';
import assert from 'node:assert/strict';
import { getProvider, providerAvailabilityCode, providerPreflightCode } from '../src/providers.js';

test('only active notices block availability, not conversation body text', async () => {
  const check = new Function('return ' + providerAvailabilityCode(getProvider('gemini')))();
  let notices = [];
  const page = { url: () => 'https://gemini.google.com/app', locator: selector => {
    assert.notEqual(selector, 'body');
    return { filter() { return this; }, evaluateAll: async () => notices };
  } };
  assert.equal((await check(page)).available, true);
  notices = ['You have reached your daily limit'];
  assert.equal((await check(page)).available, false);
});

test('ChatGPT preflight waits for upload readiness and preserves timeout diagnostics', async () => {
  const { preflightCode } = await import('../src/sites/chatgpt.js');
  const preflight = new Function('return ' + preflightCode('hello'))();
  const editor = { first() { return this; }, evaluate: async () => 'hello', locator: () => ({ count: async () => 0 }) };
  const send = { count: async () => 1, async click(options) {
    assert.equal(options.trial, true);
    assert.equal(options.timeout, 60000);
    throw new Error('control is disabled');
  } };
  const page = { url: () => 'https://chatgpt.com/', getByRole: () => send, locator: selector => {
    if (selector.includes('prompt-textarea')) return editor;
    if (selector === '[data-testid="stop-button"]:visible') return { count: async () => 0 };
    if (selector.includes("#composer-submit-button")) assert.match(selector, /:not\(\[data-testid="stop-button"\]\)/);
    return send;
  } };
  await assert.rejects(preflight(page), /Details: control is disabled/);
});

test('an unrelated page-wide Run/submit control is not treated as Send', async () => {
  const empty = { count: async () => 0 };
  let trialClicked = false;
  const composer = { first() { return this; }, evaluate: async () => 'test', locator: () => empty };
  const page = {
    url: () => 'https://chat.deepseek.com/',
    locator: selector => selector.startsWith('textarea') ? composer : {
      count: async () => selector.includes('button[type="submit"]') ? 1 : 0,
      click: async () => { trialClicked = true; },
    },
    getByRole: (_, options) => ({ count: async () => options.name.test('Run') ? 1 : 0, click: async () => { trialClicked = true; } }),
  };
  const preflight = new Function('return ' + providerPreflightCode(getProvider('deepseek'), 'test'))();
  assert.equal((await preflight(page)).method, 'enter');
  assert.equal(trialClicked, false);
});
