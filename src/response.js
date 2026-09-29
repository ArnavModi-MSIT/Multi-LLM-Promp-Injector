import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runBrowserTool } from './playwright-bridge.js';
import { responseCode } from './sites/chatgpt.js';

export function toolValue(result) {
  const text = result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') ?? '';
  const section = text.match(/### Result\s*\n([\s\S]*?)(?=\n### |$)/)?.[1] ?? text;
  try { return JSON.parse(section.trim()); }
  catch { throw new Error('Could not read the browser result. Submission may have occurred; check Chrome before retrying.'); }
}

export async function collectResponse(client, receipt, outputPath, timeoutMs, codeForResponse = value => responseCode(value.previousReplies, value.prompt, value.previousCopyButtons), label = 'ChatGPT', onUpdate = () => {}) {
  const deadline = Date.now() + timeoutMs;
  let latest = { text: '', url: receipt.url ?? '' };
  let stable = 0;
  while (Date.now() < deadline) {
    let state;
    try {
      state = toolValue(await runBrowserTool(client, 'browser_run_code_unsafe', { code: codeForResponse(receipt) }));
    } catch (error) {
      error.partial = latest;
      throw error;
    }
    stable = state.complete && state.text === latest.text ? stable + 1 : 0;
    latest = { ...state, url: state.url || latest.url };
    onUpdate(latest);
    // A new Copy control is the strongest signal. Some layouts hide it, so
    // accept a longer quiet period when text is present and Stop is absent.
    if (stable >= (state.finishedControls ? 4 : 15)) {
      if (outputPath) await save(outputPath, latest, false, label);
      return latest;
    }
    await delay(2000);
  }
  if (latest.text) {
    if (outputPath) {
      const partial = outputPath + '.partial.md';
      await save(partial, latest, true, label);
      const error = new Error('Response completion was not confirmed. Partial response saved to ' + partial + '. Check Chrome; do not resubmit automatically.');
      error.partial = latest;
      throw error;
    }
    const error = new Error('Response completion was not confirmed. Check Chrome; the prompt was already submitted.');
    error.partial = latest;
    throw error;
  }
  const error = new Error('No new response could be extracted before the timeout. Check Chrome; the prompt was already submitted.');
  error.partial = latest;
  throw error;
}

async function save(filename, response, partial, label) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, '# ' + label + ' response' + (partial ? ' (partial)' : '') + '\n\nConversation: ' + response.url + '\n\n' + response.text + '\n', { encoding: 'utf8', flag: 'wx' });
}
