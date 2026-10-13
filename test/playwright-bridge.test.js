import test from 'node:test';
import assert from 'node:assert/strict';
import { selectProviderTab, selectSubmissionTab } from '../src/playwright-bridge.js';
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

test('capture finds the marked tab even after tab indices change', async () => {
  let selected;
  const client = { async callTool({ name, arguments: input }) {
    if (name === 'browser_tabs' && input.action === 'list') return { content: [{ type: 'text', text: '- 0: (current) [Other](https://chatgpt.com/c/other)\n- 2: [Sent](https://chatgpt.com/c/sent)' }] };
    if (name === 'browser_tabs') { selected = input.index; return { content: [] }; }
    return { content: [{ type: 'text', text: JSON.stringify({ matches: selected === 2 }) }] };
  } };
  assert.equal(await selectSubmissionTab(client, getProvider('chatgpt'), 'marker'), 'https://chatgpt.com/c/sent');
  assert.equal(selected, 2);
});

test('capture fails when the submission tab is closed', async () => {
  const client = { callTool: async () => ({ content: [{ type: 'text', text: '' }] }) };
  await assert.rejects(selectSubmissionTab(client, getProvider('chatgpt'), 'marker'), /no longer accessible/);
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
