import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { connectToChrome, runBrowserTool, selectProviderTab } from './playwright-bridge.js';
import { existingConversationCode } from './sites/chatgpt.js';
import { getProvider, providerReadyCode, providerAvailabilityCode, providerPrepareCode, providerSendCode, providerResponseCode } from './providers.js';
import { toolValue, collectResponse } from './response.js';

const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const checkOnly = args.includes('--check');
const dryRun = args.includes('--dry-run');
const autoSend = args.includes('--auto');
const continueChat = args.includes('--continue');
const sendOnly = args.includes('--send-only');
const rl = readline.createInterface({ input, output });

try {
  const providerList = (option('--providers') ?? option('--provider') ?? 'chatgpt').split(',').map(value => value.trim());
  if (new Set(providerList).size !== providerList.length) throw new Error('Duplicate provider in --providers.');
  const selectedProviders = providerList.map(getProvider);
  const timeoutSeconds = Number(option('--timeout') ?? 600);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error('--timeout must be a positive number of seconds.');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let prompt;
  let filePath;
  if (!checkOnly) {
    prompt = (option('--prompt') ?? (option('--prompt-file')
      ? await fs.readFile(path.resolve(option('--prompt-file')), 'utf8')
      : await rl.question('Prompt: '))).trim();
    if (!prompt || prompt === '/quit') {
      console.log('No prompt submitted.');
      process.exitCode = prompt === '/quit' ? 0 : 1;
    } else {
      const fileAnswer = option('--file') ?? (option('--prompt') || option('--prompt-file')
        ? '/skip' : await rl.question('File path (or /skip): '));
      if (fileAnswer.trim() && fileAnswer.trim() !== '/skip') {
        filePath = path.resolve(fileAnswer.trim());
        const file = await fs.stat(filePath);
        if (!file.isFile()) throw new Error(`Not a file: ${filePath}`);
      }
    }
  }

  if (checkOnly || prompt) {
    console.log(continueChat
      ? 'Connecting to Chrome. In the Playwright dialog, select the existing conversation tab.'
      : 'Connecting to your regular Chrome. Approve the Playwright connection in Chrome if prompted.');
    const client = await connectToChrome({ selectExistingTab: continueChat });
    console.log('MCP connected.');
    try {
      for (const provider of selectedProviders) {
        try {
          await selectProviderTab(client, provider, { requireExisting: continueChat });
          if (continueChat && provider.id === 'chatgpt') await runBrowserTool(client, 'browser_run_code_unsafe', { code: existingConversationCode });
          await runBrowserTool(client, 'browser_run_code_unsafe', { code: providerReadyCode(provider) });
          let availability = toolValue(await runBrowserTool(client, 'browser_run_code_unsafe', { code: providerAvailabilityCode(provider) }));
          if (!availability.available) { console.log(provider.label + ' skipped: ' + availability.reason); continue; }
          if (checkOnly) { console.log(provider.label + ' composer found.'); continue; }
          await runBrowserTool(client, 'browser_run_code_unsafe', { code: await providerPrepareCode(provider, prompt, filePath) });
          availability = toolValue(await runBrowserTool(client, 'browser_run_code_unsafe', { code: providerAvailabilityCode(provider) }));
          if (!availability.available) { console.log(provider.label + ' skipped: ' + availability.reason); continue; }
          console.log(provider.label + ': prompt prepared. Review it in Chrome.');
          const answer = dryRun ? 'no' : autoSend ? 'yes' : (await rl.question(`Send to ${provider.label}? Type yes: `)).trim().toLowerCase();
          if (answer !== 'yes') { console.log(provider.label + ': not submitted.'); continue; }
          const sent = toolValue(await runBrowserTool(client, 'browser_run_code_unsafe', { code: providerSendCode(provider) }));
          if (sendOnly) { console.log(provider.label + ' submitted: ' + sent.url); continue; }
          const outputPath = path.resolve(option('--output')
            ? selectedProviders.length === 1 ? option('--output') : option('--output').replace(/(\.md)?$/i, `-${provider.id}.md`)
            : path.join('outputs', `${provider.id}-${stamp}.md`));
          const response = await collectResponse(client, sent, outputPath, timeoutSeconds * 1000, value => providerResponseCode(provider, value), provider.label);
          console.log(provider.label + ' response saved to: ' + outputPath);
          console.log('Conversation: ' + response.url);
        } catch (error) {
          console.error(provider.label + ': ' + error.message + ' Check Chrome before retrying; the prompt may have been sent.');
          process.exitCode = 1;
        }
      }
    } finally {
      await client.close();
    }
  }
} catch (error) {
  console.error(`Could not complete action: ${error.message}`);
  if (/Request timed out|extension did not connect/i.test(error.message)) {
    console.error('Chrome did not receive the extension connection. Run this command in your own PowerShell window while your regular Chrome profile is open.');
  }
  process.exitCode = 1;
} finally {
  rl.close();
}
