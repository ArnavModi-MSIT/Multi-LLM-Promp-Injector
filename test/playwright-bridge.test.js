import test from 'node:test';
import assert from 'node:assert/strict';
import { selectProviderTab, parseTabs, isBrowserDisconnect, chromeConnectionOptions } from '../src/playwright-bridge.js';
import { getProvider } from '../src/providers.js';

function browserTabs(urls) {
  const tabs = [...urls];
  const actions = [];
  let current = 0;
  return {
    actions,
    async callTool({ name, arguments: input }) {
      assert.equal(name, 'browser_tabs');
      actions.push(input.action);
      if (input.action === 'new') {
        tabs.push(input.url);
        current = tabs.length - 1;
      } else if (input.action === 'select') {
        current = input.index;
      }
      const listing = tabs.map((url, index) => `- ${index}:${index === current ? ' (current)' : ''} [Tab](${url})`).join('\n');
      return { isError: false, content: [{ type: 'text', text: listing }] };
    },
  };
}

test('selects an existing provider tab without navigating another tab', async () => {
  const client = browserTabs(['https://chatgpt.com/', 'https://gemini.google.com/app']);
  const url = await selectProviderTab(client, getProvider('gemini'));
  assert.equal(url, 'https://gemini.google.com/app');
  assert.deepEqual(client.actions, ['list', 'select']);
});

test('opens a separate tab when the provider is missing', async () => {
  const client = browserTabs(['https://chatgpt.com/']);
  const url = await selectProviderTab(client, getProvider('deepseek'));
  assert.equal(url, 'https://chat.deepseek.com/');
  assert.deepEqual(client.actions, ['list', 'new', 'list', 'select']);
});

test('keeps earlier provider tabs available while opening Kimi', async () => {
  const client = browserTabs(['https://chatgpt.com/']);
  await selectProviderTab(client, getProvider('deepseek'));
  await selectProviderTab(client, getProvider('kimi'));
  await selectProviderTab(client, getProvider('chatgpt'), { requireExisting: true });
  assert.equal(client.actions.filter(action => action === 'new').length, 2);
  assert.equal(client.actions.filter(action => action === 'select').length, 3);
});

test('continuation refuses to guess between multiple non-current conversations', async () => {
  const client = browserTabs(['https://example.com/', 'https://chatgpt.com/c/one', 'https://chatgpt.com/c/two']);
  await assert.rejects(selectProviderTab(client, getProvider('chatgpt'), { requireExisting: true }), /Multiple ChatGPT tabs/);
  assert.deepEqual(client.actions, ['list']);
});

test('provider tab selection ignores HTTP tabs with a matching hostname', async () => {
  const client = browserTabs(['http://chatgpt.com/']);
  assert.equal(await selectProviderTab(client, getProvider('chatgpt')), 'https://chatgpt.com/');
  assert.deepEqual(client.actions, ['list', 'new', 'list', 'select']);
});

test('tab parsing handles nested square brackets and parentheses in URLs', () => {
  const tabs = parseTabs({ content: [{ type: 'text', text: '- 3: (current) [[Draft] Review [v2]](https://chatgpt.com/c/test(foo))\r\n- 4: [Normal](https://claude.ai/new)' }] });
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].title, '[Draft] Review [v2]');
  assert.equal(tabs[0].url, 'https://chatgpt.com/c/test(foo)');
  assert.equal(tabs[0].current, true);
});

test('fresh runs open a new tab rather than append to an old conversation', async () => {
  const client = browserTabs(['https://chatgpt.com/c/old']);
  assert.equal(await selectProviderTab(client, getProvider('chatgpt'), { fresh: true }), 'https://chatgpt.com/');
  assert.deepEqual(client.actions, ['new', 'list', 'select']);
});

test('ordinary action timeouts are not connection failures', () => {
  assert.equal(isBrowserDisconnect(new Error('Send button timed out')), false);
  assert.equal(isBrowserDisconnect(new Error('Transport closed')), true);
  assert.equal(isBrowserDisconnect(new Error('Target page, context or browser has been closed')), true);
});

test('normal connections forward the token explicitly; only continuation strips it', () => {
  const env = { PLAYWRIGHT_MCP_EXTENSION_TOKEN: 'test-token', PATH: 'test-path' };
  assert.deepEqual(chromeConnectionOptions({}, env).env, env);
  assert.deepEqual(chromeConnectionOptions({ selectExistingTab: true }, env).env, { PATH: 'test-path' });
});
