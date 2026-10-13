import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export function parseCommandLine(args) {
  const { values } = parseArgs({ args, allowPositionals: false, options: {
    providers: { type: 'string' }, provider: { type: 'string' },
    prompt: { type: 'string' }, 'prompt-file': { type: 'string' },
    file: { type: 'string', multiple: true }, output: { type: 'string' },
    timeout: { type: 'string' }, check: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    auto: { type: 'boolean' }, continue: { type: 'boolean' }, 'send-only': { type: 'boolean' },
  } });
  if (values.provider && values.providers) throw new Error('Use either --provider or --providers.');
  if (values.prompt !== undefined && values['prompt-file'] !== undefined) throw new Error('Use either --prompt or --prompt-file.');
  for (const key of ['provider', 'providers', 'prompt-file', 'file', 'output', 'timeout']) {
    for (const value of [].concat(values[key] ?? [])) {
      if (!value.trim() || value.startsWith('--')) throw new Error(`--${key} requires a value.`);
    }
  }
  return values;
}

export function providerOutputPath(output, provider, count, stamp) {
  if (!output) return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../outputs', `${provider}-${stamp}.md`);
  if (count === 1) return path.resolve(output);
  return path.resolve(output.replace(/\.md$/i, '') + `-${provider}.md`);
}
