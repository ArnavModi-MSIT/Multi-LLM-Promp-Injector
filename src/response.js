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

export async function collectResponse(client, receipt, outputPath, timeoutMs, codeForResponse = value => responseCode(value.previousReplies, value.prompt, value.previousCopyButtons), label = 'ChatGPT', onUpdate = () => {}, { now = Date.now, wait = delay } = {}) {
  const deadline = now() + timeoutMs;
  let latest = { text: '', url: receipt.url ?? '' };
  let stable = 0;
  let failure;
  while (now() < deadline) {
    let state;
    try {
      state = toolValue(await runBrowserTool(client, 'browser_run_code_unsafe', { code: codeForResponse(receipt) }));
    } catch (error) {
      failure = error;
      break;
    }
    stable = state.complete && state.text === latest.text ? stable + 1 : 0;
    // A transient rerender can hide the reply. Keep the last extracted text,
    // while resetting completion until the reply is visible again.
    latest = { ...state, text: state.text || latest.text, url: state.url || latest.url };
    onUpdate(latest);
    // A new Copy control is the strongest signal. Some layouts hide it, so
    // accept a longer quiet period when text is present and Stop is absent.
    if (stable >= (state.finishedControls ? 4 : 15)) {
      if (outputPath) {
        try { await save(outputPath, latest, false, label); }
        catch (error) { failure = error; break; }
      }
      return latest;
    }
    await wait(Math.min(2000, Math.max(0, deadline - now())));
  }
  const reason = failure ? `Response capture failed: ${failure.message}`
    : latest.text ? 'Response completion was not confirmed.' : 'No new response could be extracted before the timeout.';
  let message = reason + ' Check Chrome; the prompt was already submitted. Do not resubmit automatically.';
  if (latest.text && outputPath) {
    const partial = outputPath + '.partial.md';
    try {
      await save(partial, latest, true, label);
      message += ' Partial response saved to ' + partial + '.';
    } catch (error) {
      message += ' Could not save partial response: ' + error.message;
    }
  }
  const error = new Error(message, failure ? { cause: failure } : undefined);
  error.partial = latest;
  throw error;
}

async function save(filename, response, partial, label) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, '# ' + label + ' response' + (partial ? ' (partial)' : '') + '\n\nConversation: ' + response.url + '\n\n' + response.text + '\n', { encoding: 'utf8', flag: 'wx' });
}
