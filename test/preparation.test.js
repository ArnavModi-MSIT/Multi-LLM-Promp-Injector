import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareProvider } from '../src/preparation.js';
import { getProvider } from '../src/providers.js';
import { runBrowserTool } from '../src/playwright-bridge.js';

const chooser = { content: [{ type: 'text', text: '### Modal state\n- [File chooser]: can be handled by browser_file_upload' }] };

test('preparation waits through MCP chooser state without uploading or sending twice', async () => {
  const actions = [];
  let id;
  let polls = 0;
  const tool = async (_, name, args) => {
    if (name === 'browser_file_upload') {
      assert.deepEqual(args, {}, 'clearing bookkeeping must not reset selected files');
      actions.push('clear'); return {};
    }
    if (args.code.includes('page.__promptInjectorPreparation = state')) {
      actions.push('prepare');
      id = JSON.parse(args.code.match(/const state = \{ id: ("[^"]+")/)[1]);
      return chooser;
    }
    actions.push('poll');
    if (++polls === 1) throw Object.assign(new Error('MCP modal'), { fileChooserPending: true });
    return { structuredContent: { id, status: 'complete', result: { promptPrepared: true, attachmentCount: 2 } } };
  };
  const result = await prepareProvider({}, getProvider('gemini'), 'test', [], { tool });
  assert.equal(result.promptPrepared, true);
  assert.deepEqual(actions, ['prepare', 'clear', 'poll', 'clear', 'poll']);
});

test('preparation failures and mismatched state are never accepted or retried', async () => {
  for (const mismatch of [false, true]) {
    let calls = 0;
    const tool = async (_, name, { code }) => {
      calls++;
      const id = JSON.parse(code.match(/const state = \{ id: ("[^"]+")/)[1]);
      return { structuredContent: { id: mismatch ? 'old-job' : id, status: 'failed', error: 'Upload rejected' } };
    };
    await assert.rejects(prepareProvider({}, getProvider('gemini'), 'test', [], { tool }), mismatch ? /state changed/ : /Upload rejected/);
    assert.equal(calls, 1);
  }
});

test('bridge identifies file chooser errors without treating JavaScript dialogs as upload modals', async () => {
  for (const isChooser of [true, false]) {
    const result = isChooser ? chooser : { content: [{ type: 'text', text: '### Modal state\n- [Dialog]: can be handled by browser_handle_dialog' }] };
    const client = { callTool: async () => ({ ...result, isError: true }) };
    await assert.rejects(runBrowserTool(client, 'browser_run_code_unsafe', {}), error => {
      assert.equal(error.fileChooserPending, isChooser); return true;
    });
  }
});
