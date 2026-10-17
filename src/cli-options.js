import { parseArgs } from 'node:util';

export function parseCommandLine(args) {
  const { values } = parseArgs({ args, allowPositionals: false, options: {
    providers: { type: 'string' }, provider: { type: 'string' },
    prompt: { type: 'string' }, 'prompt-file': { type: 'string' },
    file: { type: 'string', multiple: true },
    check: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    auto: { type: 'boolean' }, continue: { type: 'boolean' },
  } });
  if (values.provider && values.providers) throw new Error('Use either --provider or --providers.');
  if (values.prompt !== undefined && values['prompt-file'] !== undefined) throw new Error('Use either --prompt or --prompt-file.');
  for (const key of ['provider', 'providers', 'prompt-file', 'file']) {
    for (const value of [].concat(values[key] ?? [])) {
      if (!value.trim() || value.startsWith('--')) throw new Error(`--${key} requires a value.`);
    }
  }
  return values;
}
