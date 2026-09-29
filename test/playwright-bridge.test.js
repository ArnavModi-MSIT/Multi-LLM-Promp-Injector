import test from 'node:test';
import assert from 'node:assert/strict';
import { selectProviderTab } from '../src/playwright-bridge.js';
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
