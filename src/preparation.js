import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { providerPrepareCode } from './providers.js';
import { runBrowserTool, hasFileChooserModal } from './playwright-bridge.js';
import { toolValue } from './tool-result.js';

// MCP returns early when a chooser opens, while the original snippet continues
// uploading. Keep an explicit completion record; never repeat the upload code.
export async function prepareProvider(client, provider, prompt, files, { tool = runBrowserTool } = {}) {
  const id = randomUUID();
  const prepare = await providerPrepareCode(provider, prompt, files);
  const deadline = Date.now() + 110000;
  let result = await tool(client, 'browser_run_code_unsafe', { code: `async (page) => {
    const state = { id: ${JSON.stringify(id)}, status: 'running' };
    page.__promptInjectorPreparation = state;
    try {
      state.result = await (${prepare})(page);
      state.status = 'complete';
    } catch (error) {
      state.error = error.message;
      state.status = 'failed';
    }
    return state;
  }` });
  while (Date.now() < deadline) {
    if (hasFileChooserModal(result)) {
      // No paths: clears MCP's stale chooser bookkeeping without replacing the
      // file buffers already supplied by the still-running preparation snippet.
      await tool(client, 'browser_file_upload', {});
    } else if (result) {
      const state = toolValue(result);
      if (state?.id !== id) throw new Error('Preparation state changed. Nothing was sent.');
      if (state.status === 'failed') throw new Error(state.error || 'Preparation failed. Nothing was sent.');
      if (state.status === 'complete' && state.result?.promptPrepared === true) return state.result;
      if (state.status !== 'running') throw new Error('Preparation was not confirmed. Nothing was sent.');
    }
    await delay(100);
    try { result = await tool(client, 'browser_run_code_unsafe', { code: `async (page) => {
      const state = page.__promptInjectorPreparation;
      if (!state || state.id !== ${JSON.stringify(id)}) throw new Error('Preparation state changed. Nothing was sent.');
      return state;
    }` }); } catch (error) {
      if (!error.fileChooserPending) throw error;
      // A later single-file chooser may open between the previous result and
      // this poll. Clear only this known upload modal, then read state again.
      await tool(client, 'browser_file_upload', {});
      result = null;
    }
  }
  throw new Error('Preparation did not finish. Nothing was sent. Check the staged draft.');
}
