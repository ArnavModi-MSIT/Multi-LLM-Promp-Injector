// Per-step wait budgets in milliseconds. They stop one signed-out, stuck or
// slow site from blocking every site queued behind it. A step that runs out of
// time fails that site only. Override each with an environment variable in
// whole seconds, for example PROMPT_INJECTOR_PREPARE_SECONDS=1200.
const defaults = { readyMs: 180_000, prepareMs: 600_000, sendMs: 300_000 };
const variables = {
  readyMs: 'PROMPT_INJECTOR_READY_SECONDS',
  prepareMs: 'PROMPT_INJECTOR_PREPARE_SECONDS',
  sendMs: 'PROMPT_INJECTOR_SEND_SECONDS',
};
const maxSeconds = 24 * 60 * 60;

export function stepTimeouts(env = process.env) {
  const result = {};
  for (const [key, name] of Object.entries(variables)) {
    const raw = env[name];
    if (raw === undefined || raw === '') { result[key] = defaults[key]; continue; }
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > maxSeconds) {
      throw new Error(`${name} must be a number of seconds from 1 to ${maxSeconds}.`);
    }
    result[key] = Math.round(seconds * 1000);
  }
  return result;
}

// Defaults and environment first, then explicit overrides (used by tests).
export function resolveTimeouts(overrides = {}, env = process.env) {
  const resolved = { ...stepTimeouts(env), ...overrides };
  for (const [key, value] of Object.entries(resolved)) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`Time limit ${key} must be a positive whole number of milliseconds.`);
  }
  return resolved;
}

export const secondsText = ms => Math.round(ms / 1000);
