import test from 'node:test';
import assert from 'node:assert/strict';
import { collectResponses } from '../src/response.js';

test('five completed providers share a 30-second observation window', async () => {
  let time = 0;
  const visits = [];
  const tasks = ['one', 'two', 'three', 'four', 'five'].map(id => ({
    receipt: { id }, label: id, codeForResponse: receipt => receipt.id,
    beforePoll: async () => { visits.push(id); },
  }));
  const client = { callTool: async () => ({ content: [{ type: 'text', text: JSON.stringify({ text: 'done', complete: true, finishedControls: true }) }] }) };
  const results = await collectResponses(client, tasks, 60000, { now: () => time, wait: async ms => { time += ms; } });
  assert.equal(time, 30000);
  assert.equal(results.every(result => result.response.text === 'done'), true);
  assert.deepEqual(visits.slice(0, 10), ['one', 'two', 'three', 'four', 'five', 'one', 'two', 'three', 'four', 'five']);
});

test('a missing selector does not block other providers and yields match diagnostics', async () => {
  let time = 0;
  let finishedAt;
  const client = { callTool: async ({ arguments: { code } }) => ({ content: [{ type: 'text', text: JSON.stringify(code === 'good'
    ? { text: 'done', complete: true, finishedControls: true }
    : { text: '', complete: false, diagnostics: { selector: '.missing', rawMatches: 0, turnMatches: 0, newTurns: 0 } }) }] }) };
  const tasks = ['missing', 'good'].map(id => ({ receipt: { id }, label: id, codeForResponse: receipt => receipt.id,
    onComplete: () => { finishedAt = time; } }));
  const results = await collectResponses(client, tasks, 60000, { now: () => time, wait: async ms => { time += ms; } });
  assert.equal(finishedAt, 30000);
  assert.match(results[0].error.message, /\.missing.*matched 0 nodes \/ 0 distinct turns/);
  assert.equal(time, 60000);
});
