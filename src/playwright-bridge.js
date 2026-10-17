import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export function chromeConnectionOptions({ selectExistingTab = false } = {}, env = process.env) {
  return { command: process.execPath,
    args: [path.join(path.dirname(require.resolve('@playwright/mcp/package.json')), 'cli.js'), '--extension', '--browser', 'chrome',
      ...(env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME ? ['--profile-dir-name', env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME] : [])],
    cwd: repoRoot, stderr: 'pipe',
    // The SDK only inherits a small default env allowlist. Forward explicitly.
    env: Object.fromEntries(Object.entries(env).filter(([key, value]) => typeof value === 'string' && (!selectExistingTab || key !== 'PLAYWRIGHT_MCP_EXTENSION_TOKEN'))),
  };
}

export async function connectToChrome(options = {}) {
  const client = new Client({ name: 'prompt-injector', version: '1.0.0' }, { capabilities: {} });
  // Only explicit continuation needs the tab-selection dialog rather than token access.
  const transport = new StdioClientTransport(chromeConnectionOptions(options));
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await transport.close();
    throw error;
  }
}

export async function runBrowserTool(client, name, args, { timeoutMs = 120000 } = {}) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: timeoutMs });
  if (result.isError) {
    const text = result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
    const message = text.match(/### Error\s*\n([^\n]+)/)?.[1]
      ?? text.match(/Error:\s*([^\n]+)/)?.[1]
      ?? `Playwright tool ${name} failed`;
    const error = new Error(message.trim());
    error.fileChooserPending = hasFileChooserModal(result);
    throw error;
  }
  return result;
}

export function hasFileChooserModal(result) {
  const text = result?.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
  const modal = text.split(/^### /m).find(section => /^Modal state\r?\n/.test(section)) ?? '';
  return modal.includes('[File chooser]: can be handled by browser_file_upload');
}

export function parseTabs(result) {
  const listing = result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
  // browser_tabs returns a Result listing and can repeat it under Open tabs
  // after navigation. Open tabs is the later snapshot; never concatenate the
  // two or parse tab-like text from page snapshots, code, or console messages.
  const sections = new Map();
  let lines = [];
  let hasHeadings = false;
  for (const line of listing.split(/\r?\n/)) {
    const heading = line.match(/^### (.+?)\s*$/);
    if (heading) {
      hasHeadings = true;
      lines = [];
      sections.set(heading[1], lines);
    } else lines.push(line);
  }
  const rows = hasHeadings ? sections.get('Open tabs') ?? sections.get('Result') ?? [] : lines;
  const tabs = new Map();
  for (const line of rows) {
    const match = line.match(/^- (\d+):( \(current\))? \[(.*)\]\((.*)\)(?: \[crashed\])?\s*$/);
    if (!match) continue;
    const tab = { index: Number(match[1]), current: Boolean(match[2]), title: match[3], url: match[4] };
    const previous = tabs.get(tab.index);
    if (previous && (previous.url !== tab.url || previous.current !== tab.current)) {
      throw new Error('Conflicting browser tab entries. No prompt was entered or sent.');
    }
    tabs.set(tab.index, tab);
  }
  return [...tabs.values()];
}

function providerTabs(result, provider) {
  return parseTabs(result).filter(tab => {
    try { const url = new URL(tab.url); return url.protocol === 'https:' && provider.hosts.includes(url.hostname); }
    catch { return false; }
  });
}

export function isBrowserDisconnect(error) {
  return /disconnected|connection closed|transport closed|not connected|(?:browser|page|context|target).{0,40}closed|ECONNRESET|EPIPE/i.test(error?.message ?? '')
    || Boolean(error?.cause && isBrowserDisconnect(error.cause));
}

export async function selectProviderTab(client, provider, { requireExisting = false, fresh = false, timeoutMs = 20000 } = {}) {
  const destination = new URL(provider.url);
  if (destination.protocol !== 'https:' || !provider.hosts.includes(destination.hostname)) {
    throw new Error(`Refusing navigation outside ${provider.label}'s approved origin.`);
  }
  if (fresh && requireExisting) throw new Error('A fresh tab cannot also be an existing conversation.');
  const deadline = Date.now() + timeoutMs;
  let previousIndices;
  let createdIndex;
  if (fresh) {
    previousIndices = new Set(parseTabs(await runBrowserTool(client, 'browser_tabs', { action: 'list' })).map(tab => tab.index));
    const created = parseTabs(await runBrowserTool(client, 'browser_tabs', { action: 'new', url: provider.url }))
      .filter(tab => !previousIndices.has(tab.index));
    if (created.length > 1) throw new Error('New tab identity is ambiguous. No prompt was entered or sent.');
    createdIndex = created[0]?.index;
  }
  while (Date.now() < deadline) {
    const listing = await runBrowserTool(client, 'browser_tabs', { action: 'list' });
    if (fresh && createdIndex === undefined) {
      const created = parseTabs(listing).filter(tab => !previousIndices.has(tab.index));
      if (created.length > 1) throw new Error('New tab identity is ambiguous. No prompt was entered or sent.');
      createdIndex = created[0]?.index;
    }
    const tabs = providerTabs(listing, provider);
    if (requireExisting && tabs.length > 1 && !tabs.some(tab => tab.current)) {
      throw new Error(`Multiple ${provider.label} tabs are open. Select the intended conversation before continuing.`);
    }
    const selected = fresh ? tabs.find(tab => tab.index === createdIndex) : tabs.find(tab => tab.current) ?? tabs[0];
    if (selected) {
      // MCP already selects newly created pages. Re-selecting calls
      // bringToFront upstream and needlessly interrupts background use.
      if (!fresh || !selected.current) await runBrowserTool(client, 'browser_tabs', { action: 'select', index: selected.index });
      if (fresh) await runBrowserTool(client, 'browser_run_code_unsafe', { code: `async (page) => {
        const url = new URL(page.url());
        if (url.protocol !== 'https:' || !${JSON.stringify(provider.hosts)}.includes(url.hostname)) throw new Error('New provider tab changed before preparation.');
        page.__promptInjectorFreshTab = true;
        return { fresh: true };
      }` });
      return selected.url;
    }
    if (!fresh && !requireExisting) return selectProviderTab(client, provider, { fresh: true, timeoutMs: Math.max(1, deadline - Date.now()) });
    await delay(500);
  }
  throw new Error(`${provider.label} tab did not become accessible. Check its sign-in page or choose the existing conversation in the Playwright dialog.`);
}
