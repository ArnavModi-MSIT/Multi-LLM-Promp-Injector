import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export async function connectToChrome({ selectExistingTab = false } = {}) {
  const client = new Client({ name: 'prompt-injector', version: '1.0.0' }, { capabilities: {} });
  const args = [path.resolve('node_modules/@playwright/mcp/cli.js'), '--extension', '--browser', 'chrome'];
  if (process.env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME) {
    args.push('--profile-dir-name', process.env.PLAYWRIGHT_MCP_PROFILE_DIR_NAME);
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    cwd: process.cwd(),
    stderr: 'pipe',
    // The extension's token bypasses tab selection. Continuation requires the
    // user to choose the existing conversation in the extension dialog.
    ...(selectExistingTab ? { env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'PLAYWRIGHT_MCP_EXTENSION_TOKEN')) } : {}),
  });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await transport.close();
    throw error;
  }
}

export async function runBrowserTool(client, name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  if (result.isError) {
    const text = result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
    const message = text.match(/### Error\s*\n([^\n]+)/)?.[1]
      ?? text.match(/Error:\s*([^\n]+)/)?.[1]
      ?? `Playwright tool ${name} failed`;
    throw new Error(message.trim());
  }
  return result;
}

export async function selectProviderTab(client, provider, { requireExisting = false, timeoutMs = 20_000 } = {}) {
  const destination = new URL(provider.url);
  if (destination.protocol !== 'https:' || !provider.hosts.includes(destination.hostname)) {
    throw new Error(`Refusing navigation outside ${provider.label}'s approved origin.`);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await runBrowserTool(client, 'browser_tabs', { action: 'list' });
    const listing = result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
    const accessible = [...listing.matchAll(/^- (\d+):( \(current\))? \[[^\]]*\]\(([^)]*)\)/gm)];
    const tabs = accessible.filter(match => { try { return provider.hosts.includes(new URL(match[3]).hostname); } catch { return false; } });
    const selected = tabs.find(match => match[2]) ?? tabs[0];
    if (selected) {
      await runBrowserTool(client, 'browser_tabs', { action: 'select', index: Number(selected[1]) });
      return selected[3];
    }
    if (!requireExisting) {
      // The extension grants this client a tab group. Reuse an approved tab
      // rather than opening a new tab outside the initial grant.
      const approved = accessible.find(match => match[2]) ?? accessible[0];
      if (!approved) throw new Error('No approved browser tab is available. Select one tab in the Playwright Extension dialog.');
      await runBrowserTool(client, 'browser_tabs', { action: 'select', index: Number(approved[1]) });
      await runBrowserTool(client, 'browser_navigate', { url: provider.url });
      return provider.url;
    }
    await delay(2000);
  }
  throw new Error(`No ${provider.label} tab was selected. Choose an existing tab in the Playwright Extension dialog.`);
}
