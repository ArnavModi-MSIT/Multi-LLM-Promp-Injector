import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { BrowserClient, runBrowserTool } from '../src/playwright-bridge.js';

test('unlimited MCP calls install no timer and still reject on connection close', async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = new Server({ name: 'wait-fixture', version: '1' }, { capabilities: { tools: {} } });
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  server.setRequestHandler(CallToolRequestSchema, async (_, { signal }) => {
    started();
    await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    return { content: [] };
  });
  const client = new BrowserClient({ name: 'wait-test', version: '1' }, { capabilities: {} });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const pending = runBrowserTool(client, 'browser_run_code_unsafe', { code: 'slow' });
    const rejected = assert.rejects(pending, /Connection closed/);
    await entered;
    assert.equal(client._timeoutInfo.size, 0, 'unlimited work must have no hidden SDK request timer');
    await client.close();
    await rejected;
  } finally { await client.close(); await server.close(); }
});
