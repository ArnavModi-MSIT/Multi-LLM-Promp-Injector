import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const mcpRequire = createRequire(require.resolve('@playwright/mcp/package.json'));
export const { chromium } = mcpRequire('playwright');

if (process.argv.includes('--install')) {
  const cli = path.join(path.dirname(mcpRequire.resolve('playwright/package.json')), 'cli.js');
  process.exitCode = spawnSync(process.execPath, [cli, 'install', '--with-deps', 'chromium'], { stdio: 'inherit' }).status ?? 1;
}
