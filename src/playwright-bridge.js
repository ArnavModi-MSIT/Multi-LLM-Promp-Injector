import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { toolValue } from './tool-result.js';

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
    throw new Error(message.trim());
  }
  return result;
}

export function parseTabs(result) {
  const listing = result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
  return listing.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^- (\d+):( \(current\))? \[(.*)\]\((.*)\)\s*$/);
    return match ? [{ index: Number(match[1]), current: Boolean(match[2]), title: match[3], url: match[4] }] : [];
  });
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
  if (fresh) await runBrowserTool(client, 'browser_tabs', { action: 'new', url: provider.url });
  while (Date.now() < deadline) {
    const tabs = providerTabs(await runBrowserTool(client, 'browser_tabs', { action: 'list' }), provider);
    if (requireExisting && tabs.length > 1 && !tabs.some(tab => tab.current)) {
      throw new Error(`Multiple ${provider.label} tabs are open. Select the intended conversation before continuing.`);
    }
    const selected = tabs.find(tab => tab.current) ?? (fresh ? undefined : tabs[0]);
    if (selected) {
      await runBrowserTool(client, 'browser_tabs', { action: 'select', index: selected.index });
      return selected.url;
    }
    if (!fresh && !requireExisting) return selectProviderTab(client, provider, { fresh: true, timeoutMs: Math.max(1, deadline - Date.now()) });
    await delay(500);
  }
  throw new Error(`${provider.label} tab did not become accessible. Check its sign-in page or choose the existing conversation in the Playwright dialog.`);
}

// Capture markers belong to Page objects in this exact connection.
export async function selectSubmissionTab(client, provider, captureId, { timeoutMs = 15000 } = {}) {
  if (!captureId) throw new Error('Missing submission tab identity.');
  const deadline = Date.now() + timeoutMs;
  const call = (name, args) => runBrowserTool(client, name, args, { timeoutMs: Math.max(1, deadline - Date.now()) });
  const tabs = providerTabs(await call('browser_tabs', { action: 'list' }), provider);
  for (const tab of tabs) {
    if (Date.now() >= deadline) throw new Error('Submission tab selection timed out.');
    await call('browser_tabs', { action: 'select', index: tab.index });
    const state = await call('browser_run_code_unsafe', { code: `async (page) => ({ matches: page.__promptInjectorCaptureId === ${JSON.stringify(captureId)} })` });
    if (toolValue(state).matches) return tab.url;
  }
  throw new Error(`${provider.label} submission tab is no longer accessible. Capture stopped.`);
}
