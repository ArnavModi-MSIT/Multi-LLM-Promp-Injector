import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isBrowserDisconnect, runBrowserTool } from './playwright-bridge.js';
import { responseCode } from './sites/chatgpt.js';

import { toolValue } from './tool-result.js';
export { toolValue } from './tool-result.js';

export async function collectResponse(client, receipt, outputPath, timeoutMs, codeForResponse = value => responseCode(value.previousReplies), label = 'ChatGPT', onUpdate = () => {}, options = {}) {
  const [result] = await collectResponses(client, [{ receipt, outputPath, codeForResponse, label, onUpdate }], timeoutMs, options);
  if (result.error) throw result.error;
  return result.response;
}

// One browser connection has one selected tab. Visit each pending capture in
// order, then wait once per round; never run tab selection concurrently.
export async function collectResponses(client, tasks, timeoutMs, { now = Date.now, wait = delay, isFatal = isBrowserDisconnect } = {}) {
  const startedAt = now();
  const records = tasks.map(task => ({ task, deadline: startedAt + timeoutMs, lastChangeAt: null, eligibleSince: null,
    latest: { text: '', url: task.receipt.url ?? '' }, terminal: false }));
  async function fail(record, failure) {
    const { task, latest } = record;
    const diagnostics = latest.diagnostics;
    const detail = diagnostics ? ` Selector ${JSON.stringify(diagnostics.selector)} matched ${diagnostics.rawMatches} nodes / ${diagnostics.turnMatches} distinct turns; new turns: ${diagnostics.newTurns}.` : '';
    const reason = failure ? `Response capture failed: ${failure.message}`
      : latest.text ? 'Response completion was not confirmed.' : 'No new response could be extracted before the timeout.';
    let message = reason + detail + ' Check Chrome; the prompt was already submitted. Do not resubmit automatically.';
    if (latest.text && task.outputPath) {
      const partial = task.outputPath + '.partial.md';
      try { await save(partial, latest, true, task.label); message += ' Partial response saved to ' + partial + '.'; }
      catch (error) { message += ' Could not save partial response: ' + error.message; }
    }
    record.error = new Error(message, failure ? { cause: failure } : undefined);
    record.error.partial = latest;
    record.terminal = true;
    await task.onError?.(record.error);
  }
  while (records.some(record => !record.terminal)) {
    let fatal;
    for (const record of records) {
      if (record.terminal) continue;
      if (fatal) { await fail(record, fatal); continue; }
      if (now() >= record.deadline) { await fail(record); continue; }
      const { task } = record;
      try {
        await task.beforePoll?.({ timeoutMs: Math.max(1, Math.min(15000, record.deadline - now())) });
        const state = toolValue(await runBrowserTool(client, 'browser_run_code_unsafe', { code: task.codeForResponse(task.receipt) },
          { timeoutMs: Math.max(1, Math.min(15000, record.deadline - now())) }));
        const observedAt = now();
        if (record.lastChangeAt === null || state.text !== record.latest.text) record.lastChangeAt = observedAt;
        const eligible = state.complete && !state.generating && state.finishedControls && Boolean(state.text);
        record.eligibleSince = eligible ? record.eligibleSince ?? observedAt : null;
        record.latest = { ...state, text: state.text || record.latest.text, url: state.url || record.latest.url };
        await task.onUpdate?.(record.latest);
        if (eligible && observedAt - Math.max(record.lastChangeAt, record.eligibleSince) >= 30000) {
          if (task.outputPath) await save(task.outputPath, record.latest, false, task.label);
          record.response = record.latest;
          record.terminal = true;
          await task.onComplete?.(record.latest);
        }
      } catch (error) {
        await fail(record, error);
        if (isFatal(error)) fatal = error;
      }
    }
    if (fatal) for (const record of records) if (!record.terminal) await fail(record, fatal);
    const pending = records.filter(record => !record.terminal);
    if (pending.length) await wait(Math.min(2000, Math.max(0, Math.min(...pending.map(record => record.deadline)) - now())));
  }
  return records.map(({ task, response, error }) => ({ task, response, error }));
}

async function save(filename, response, partial, label) {
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, '# ' + label + ' response' + (partial ? ' (partial)' : '') + '\n\nConversation: ' + response.url + '\n\n' + response.text + '\n', { encoding: 'utf8', flag: 'wx' });
}
