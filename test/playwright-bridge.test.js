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
      if (name === 'browser_run_code_unsafe') { actions.push('mark-fresh'); return { content: [] }; }
      assert.equal(name, 'browser_tabs');
      actions.push(input.action);
      if (input.action === 'new') {
        tabs.push(input.url);
        current = tabs.length - 1;
      } else if (input.action === 'select') {
        current = input.index;
      }
      const listing = tabs.map((url, index) => `- ${index}:${index === current ? ' (current)' : ''} [Tab](${url})`).join('\n');
      return { isError: false, content: [{ type: 'text', text: `### Result\n${listing}\n### Open tabs\n${listing}\n### Page\n- Page URL: ${tabs[current]}` }] };
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
  assert.deepEqual(client.actions, ['list', 'list', 'new', 'list', 'mark-fresh']);
});

test('keeps earlier provider tabs available while opening Kimi', async () => {
  const client = browserTabs(['https://chatgpt.com/']);
  await selectProviderTab(client, getProvider('deepseek'));
  await selectProviderTab(client, getProvider('kimi'));
  await selectProviderTab(client, getProvider('chatgpt'), { requireExisting: true });
  assert.equal(client.actions.filter(action => action === 'new').length, 2);
  assert.equal(client.actions.filter(action => action === 'select').length, 1);
});

test('continuation refuses to guess between multiple non-current conversations', async () => {
  const client = browserTabs(['https://example.com/', 'https://chatgpt.com/c/one', 'https://chatgpt.com/c/two']);
  await assert.rejects(selectProviderTab(client, getProvider('chatgpt'), { requireExisting: true }), /Multiple ChatGPT tabs/);
  assert.deepEqual(client.actions, ['list']);
});

test('provider tab selection ignores HTTP tabs with a matching hostname', async () => {
  const client = browserTabs(['http://chatgpt.com/']);
  assert.equal(await selectProviderTab(client, getProvider('chatgpt')), 'https://chatgpt.com/');
  assert.deepEqual(client.actions, ['list', 'list', 'new', 'list', 'mark-fresh']);
});

test('tab parsing handles nested square brackets and parentheses in URLs', () => {
  const tabs = parseTabs({ content: [{ type: 'text', text: '- 3: (current) [[Draft] Review [v2]](https://chatgpt.com/c/test(foo))\r\n- 4: [Normal](https://claude.ai/new)' }] });
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].title, '[Draft] Review [v2]');
  assert.equal(tabs[0].url, 'https://chatgpt.com/c/test(foo)');
  assert.equal(tabs[0].current, true);
});

test('tab parsing uses one latest MCP listing and ignores page content', () => {
  const tabs = parseTabs({ content: [{ type: 'text', text: [
    '### Result',
    '- 0: [Old](https://chatgpt.com/c/old)',
    '- 1: (current) [Loading](https://chatgpt.com/)',
    '### Ran Playwright code',
    '```js', '- 9: [Not a tab](https://chatgpt.com/c/fake)', '```',
    '### Open tabs',
    '- 0: [Old](https://chatgpt.com/c/old)',
    '- 1: (current) [[New] Chat](https://chatgpt.com/)',
    '### Snapshot',
    '- 8: [Page content](https://chatgpt.com/c/fake)',
  ].join('\n') }] });
  assert.deepEqual(tabs, [
    { index: 0, current: false, title: 'Old', url: 'https://chatgpt.com/c/old' },
    { index: 1, current: true, title: '[New] Chat', url: 'https://chatgpt.com/' },
  ]);
});

test('tab parsing supports Result-only responses and deduplicates identical indices', () => {
  const line = '- 2: (current) [Only tab](https://chatgpt.com/)';
  for (const text of [line + '\n' + line, '### Result\n' + line + '\n### Page\n- Page URL: https://chatgpt.com/']) {
    assert.equal(parseTabs({ content: [{ type: 'text', text }] }).length, 1);
  }
});

test('empty latest tab listings do not fall back to stale Result rows', () => {
  assert.deepEqual(parseTabs({ content: [{ type: 'text', text: '### Result\n- 0: [Closed](https://chatgpt.com/)\n### Open tabs\nNo open tabs.' }] }), []);
});

test('conflicting duplicate indices are refused, while crashed tabs retain their index', () => {
  assert.throws(() => parseTabs({ content: [{ type: 'text', text: '- 0: [One](https://chatgpt.com/)\n- 0: [Other](https://claude.ai/new)' }] }), /Conflicting browser tab entries/);
  const tabs = parseTabs({ content: [{ type: 'text', text: '- 0: [Crashed](https://chatgpt.com/) [crashed]\n- 1: (current) [New](https://chatgpt.com/)' }] });
  assert.deepEqual(tabs.map(tab => tab.index), [0, 1]);
});

test('fresh creation still refuses two genuinely new tabs without editing either', async () => {
  let created = false;
  const client = { async callTool({ name, arguments: input }) {
    assert.equal(name, 'browser_tabs', 'must not mark or edit an ambiguous page');
    assert.notEqual(input.action, 'select');
    if (input.action === 'new') created = true;
    const listing = '- 0: [Old](https://chatgpt.com/c/old)' + (created
      ? '\n- 1: (current) [New](https://chatgpt.com/)\n- 2: [Popup](https://chatgpt.com/)' : '');
    return { content: [{ type: 'text', text: `### Result\n${listing}\n### Open tabs\n${listing}` }] };
  } };
  await assert.rejects(selectProviderTab(client, getProvider('chatgpt'), { fresh: true }), /New tab identity is ambiguous/);
});

test('fresh runs open a new tab rather than append to an old conversation', async () => {
  const client = browserTabs(['https://chatgpt.com/c/old']);
  assert.equal(await selectProviderTab(client, getProvider('chatgpt'), { fresh: true }), 'https://chatgpt.com/');
  assert.deepEqual(client.actions, ['list', 'new', 'list', 'mark-fresh']);
});

test('fresh selection follows the newly created index even when the old tab is marked current', async () => {
  let created = false;
  let selected;
  let marked = false;
  const client = { async callTool({ name, arguments: input }) {
    if (name === 'browser_run_code_unsafe') { assert.equal(selected, 1); marked = true; return { content: [] }; }
    if (input.action === 'new') created = true;
    if (input.action === 'select') selected = input.index;
    const listing = '- 0: (current) [Old draft](https://chatgpt.com/)'
      + (created ? '\n- 1: [New](https://chatgpt.com/)' : '');
    return { content: [{ type: 'text', text: listing }] };
  } };
  await selectProviderTab(client, getProvider('chatgpt'), { fresh: true });
  assert.equal(selected, 1); assert.equal(marked, true);
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
