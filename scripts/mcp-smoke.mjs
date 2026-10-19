// Exercise the installed MCP server and its real response format in an isolated
// browser. All browser requests are fulfilled from local fixtures; no accounts.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium } from './fixture-browser.mjs';
import { BrowserClient, runBrowserTool, selectProviderTab, parseTabs } from '../src/playwright-bridge.js';
import { toolValue } from '../src/tool-result.js';
import { providers, providerReadyCode, providerAvailabilityCode, providerPreflightCode, providerSubmissionCode } from '../src/providers.js';
import { stageAttachmentPaths } from '../src/attachment-paths.js';
import { createAttachmentTransfer } from '../src/attachment-transfer.js';
import { prepareProvider } from '../src/preparation.js';

const require = createRequire(import.meta.url);
const cli = path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js');
const executable = chromium.executablePath();
const installed = await fs.access(executable).then(() => true, () => false);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli, '--headless', '--isolated', '--block-service-workers', '--timeout-settle', '0', '--timeout-action', '0', '--timeout-navigation', '0',
    // Match the downloaded test binary's channel. Omitting --browser leaves
    // MCP's system-Chrome launch defaults in effect on the Linux CI runner.
    ...(installed ? ['--browser', 'chromium', '--executable-path', executable]
      : process.platform === 'win32' ? ['--browser', 'chrome'] : ['--browser', 'chromium'])],
  stderr: 'pipe',
});
const client = new BrowserClient({ name: 'prompt-injector-mcp-smoke', version: '1.0.0' }, { capabilities: {} });
let staged;
let transfer;
let stderr = '';
const code = async source => toolValue(await runBrowserTool(client, 'browser_run_code_unsafe', { code: source }));
try {
  await client.connect(transport);
  transport.stderr?.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
  const fixtures = {};
  for (const provider of Object.values(providers)) {
    const html = await fs.readFile(new URL(`../test/fixtures/${provider.id}.html`, import.meta.url), 'utf8');
    for (const host of provider.hosts) fixtures[host] = html;
  }
  await code(`async (page) => {
    const fixtures = ${JSON.stringify(fixtures)};
    await page.context().route('**/*', route => {
      const html = fixtures[new URL(route.request().url()).hostname];
      return html ? route.fulfill({ contentType: 'text/html', body: html }) : route.abort();
    });
    await page.goto('https://chatgpt.com/c/existing');
    await page.locator('#prompt-textarea').fill('Existing user draft');
    return { ready: true };
  }`);
  const content = 'Synthetic MCP upload fixture.';
  staged = await stageAttachmentPaths(Array.from({ length: 5 }, (_, i) => ({ name: `mcp-notes-${i}.md`, buffer: Buffer.from(content) })));
  transfer = await createAttachmentTransfer(staged.files);
  let creations = 0;
  // Keep the real, repeated Result/Open-tabs format instead of replacing it
  // with the simplified tab rows used by the original unit-test mocks.
  const bridgeClient = { async callTool(...args) {
    const result = await client.callTool(...args);
    if (args[0].name === 'browser_tabs' && args[0].arguments.action === 'new') {
      creations++;
      const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      assert.match(text, /### Result/);
      assert.match(text, /### Open tabs/);
      assert.ok((text.match(/^- \d+:/gm) ?? []).length > creations + 1, 'MCP must exercise repeated tab listings');
    }
    return result;
  } };
  for (const withFiles of [false, true]) {
    const files = withFiles ? transfer.files : [];
    for (const provider of Object.values(providers)) {
      assert.equal(await selectProviderTab(bridgeClient, provider, { fresh: true }), provider.url);
      await code(providerReadyCode(provider));
      assert.equal((await code(providerAvailabilityCode(provider))).available, true);
      // The one-use marker must survive separate MCP code calls.
      await code(`async (page) => {
        if (!page.__promptInjectorFreshTab) throw new Error('Fresh marker lost between MCP calls');
        await page.locator(${JSON.stringify(provider.editor)}).first().fill('Restored fixture draft');
        return { ready: true };
      }`);
      if (withFiles && provider.id === 'gemini') {
        await code(`async (page) => {
          await page.evaluate(() => {
            const input = document.querySelector('input[type=file]'); input.remove();
            const form = document.querySelector('form');
            const attach = document.createElement('button'); attach.type = 'button'; attach.textContent = 'Upload and tools';
            const menu = document.createElement('div'); menu.hidden = true;
            const upload = document.createElement('button'); upload.type = 'button'; upload.setAttribute('role', 'menuitem'); upload.textContent = 'Upload files';
            menu.append(upload); form.append(attach, menu);
            attach.onclick = () => { menu.hidden = false; };
            upload.onclick = () => { form.append(input); menu.hidden = true; input.click(); };
          });
          return { menuReady: true };
        }`);
      }
      const prompt = 'Review these notes.\n    Preserve indentation.\n\nSame input for all six.';
      await prepareProvider(client, provider, prompt, files);
      if (withFiles && provider.id === 'chatgpt') {
        // Completed cards can move outside the inner form and replace the
        // initial title metadata; the composer must still verify exact names.
        await code(`async (page) => {
          await page.evaluate(() => {
            const form = document.querySelector('form');
            const draft = document.createElement('main'); form.before(draft); draft.append(form);
            const cards = document.getElementById('attachments'); draft.prepend(cards);
            for (const card of cards.children) {
              const image = document.createElement('img'); image.alt = card.title;
              card.removeAttribute('title'); card.append(image);
            }
            cards.hidden = true;
            setTimeout(() => { cards.hidden = false; }, 500);
          });
          return { cardsMoved: true };
        }`);
      }
      const uploads = await code(`async (page) => {
        return page.locator('input[type="file"]').evaluateAll(async inputs =>
          Promise.all([...inputs[0].files].map(async file => ({ name: file.name, text: await file.text() }))));
      }`);
      assert.deepEqual(uploads, files.map(file => ({ name: file.name, text: content })));
      await code(providerPreflightCode(provider, prompt, files));
      const receipt = await code(providerSubmissionCode(provider, prompt, files));
      assert.deepEqual(receipt, { submitted: true, url: provider.url });
      const submitted = await code(`async (page) => {
        return page.locator(${JSON.stringify(provider.user ?? '[data-role="user"], [data-testid="user-message"]')}).count();
      }`);
      assert.equal(submitted, 1);
      console.log(`${provider.label}: real MCP fresh tab, ${files.length} files, and exactly one submission passed.`);
    }
  }
  const tabs = parseTabs(await runBrowserTool(client, 'browser_tabs', { action: 'list' }));
  assert.equal(tabs.length, 13);
  const preserved = await code(`async (page) => {
    const existing = page.context().pages().find(candidate => candidate.url() === 'https://chatgpt.com/c/existing');
    return existing.locator('#prompt-textarea').innerText();
  }`);
  assert.equal(preserved, 'Existing user draft');
  console.log('MCP bridge: 12 distinct job tabs; existing conversation draft preserved.');
} catch (error) {
  if (stderr) console.error(stderr);
  throw error;
} finally {
  try { await client.close(); } finally {
    try { await transport.close(); } finally {
      try { await transfer?.close(); } finally { await staged?.cleanup(); }
    }
  }
}
