import test from 'node:test';
import assert from 'node:assert/strict';
import { toolValue } from '../src/tool-result.js';

const textResult = text => ({ content: [{ type: 'text', text }] });

test('structured tool results take precedence, including null and false', () => {
  for (const value of [{ submitted: true }, [1, 2], null, false, 0]) {
    assert.deepEqual(toolValue({ structuredContent: value, content: [{ type: 'text', text: 'not JSON' }] }), value);
  }
});

test('legacy tool results preserve nested JSON and markdown in response strings', () => {
  const value = { text: 'nested { brace }\n### Result\n"quoted"\\\n### Other', nested: [{ ok: true }] };
  for (const serialized of [JSON.stringify(value), JSON.stringify(value, null, 2)]) {
    assert.deepEqual(toolValue(textResult(serialized)), value);
    assert.deepEqual(toolValue(textResult('### Result\n' + serialized + '\n### Page\nURL: https://example.com/')), value);
  }
});

test('malformed tool results fail conservatively without disclosing response contents', () => {
  for (const text of ['secret response', '### Result\n{"text":"unterminated\n### Page\n{}', '{"ok":true} garbage']) {
    assert.throws(() => toolValue(textResult(text)), /Submission may have occurred/);
  }
});
