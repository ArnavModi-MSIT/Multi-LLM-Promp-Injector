import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connectToChrome, runBrowserTool, selectProviderTab, selectSubmissionTab } from './playwright-bridge.js';
import { existingConversationCode } from './sites/chatgpt.js';
import { getProvider, providerReadyCode, providerAvailabilityCode, providerPrepareCode, providerPreflightCode, providerSubmissionCode, providerResponseCode } from './providers.js';
import { toolValue, collectResponses } from './response.js';
import { stageAttachmentPaths } from './attachment-paths.js';
import { validateAttachmentList } from './attachments.js';
import { parseCommandLine, providerOutputPath } from './cli-options.js';

export async function runCli(args = process.argv.slice(2), dependencies = {}) {
  const connect = dependencies.connect ?? connectToChrome;
  const tool = dependencies.tool ?? runBrowserTool;
  const select = dependencies.select ?? selectProviderTab;
  const selectCapture = dependencies.selectCapture ?? selectSubmissionTab;
  const captureAll = dependencies.captureAll ?? collectResponses;
  const logger = dependencies.logger ?? console;
  const rl = dependencies.readline ?? readline.createInterface({ input, output });
  let exitCode = 0;
  let stagedAttachments;
  try {
    const values = parseCommandLine(args);
    const option = name => values[name.slice(2)];
    const options = name => values[name.slice(2)] ?? [];
    const checkOnly = values.check;
    const dryRun = values['dry-run'];
    const autoSend = values.auto;
    const continueChat = values.continue;
    const sendOnly = values['send-only'];
    const providerList = (option('--providers') ?? option('--provider') ?? 'chatgpt').split(',').map(value => value.trim());
    if (new Set(providerList).size !== providerList.length) throw new Error('Duplicate provider in --providers.');
    const selectedProviders = providerList.map(getProvider);
    if (continueChat && (selectedProviders.length !== 1 || selectedProviders[0].id !== 'chatgpt')) throw new Error('--continue supports exactly one provider: chatgpt.');
    const timeoutSeconds = Number(option('--timeout') ?? 600);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) throw new Error('--timeout must be a positive number of seconds.');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let prompt;
    let filePaths = [];
    if (!checkOnly) {
      prompt = (option('--prompt') ?? (option('--prompt-file')
        ? await fs.readFile(path.resolve(option('--prompt-file')), 'utf8')
        : await rl.question('Prompt: '))).trim();
      if (!prompt || prompt === '/quit') {
        logger.log('No prompt submitted.');
        return prompt === '/quit' ? 0 : 1;
      } else {
        if (prompt.length > 100_000) throw new Error('Prompt is too long.');
        const supplied = options('--file');
        const answers = supplied.length ? supplied : (option('--prompt') !== undefined || option('--prompt-file')
          ? [] : (await rl.question('File paths separated by ; (or /skip): ')).split(';'));
        filePaths = answers.map(value => value?.trim()).filter(value => value && value !== '/skip').map(value => path.resolve(value));
        const files = await Promise.all(filePaths.map(async filename => {
          const file = await fs.stat(filename);
          if (!file.isFile()) throw new Error(`Not a file: ${filename}`);
          return { name: path.basename(filename), size: file.size };
        }));
        validateAttachmentList(files);
        stagedAttachments = await stageAttachmentPaths(filePaths);
        filePaths = stagedAttachments.files;
      }
    }

    const outputPaths = new Map(selectedProviders.map(provider => [provider.id,
      providerOutputPath(option('--output'), provider.id, selectedProviders.length, stamp)]));
    if (!checkOnly && !dryRun && !sendOnly) {
      for (const filename of outputPaths.values()) {
        try { await fs.access(filename); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        throw new Error(`Output already exists: ${filename}. Choose another --output.`);
      }
    }
    if (checkOnly || prompt) {
      logger.log(continueChat
        ? 'Connecting to Chrome. In the Playwright dialog, select the existing conversation tab.'
        : 'Connecting to your regular Chrome. Approve the Playwright connection in Chrome if prompted.');
      const client = await connect({ selectExistingTab: continueChat });
      logger.log('MCP connected.');
      try {
        const awaitingCapture = [];
        for (const provider of selectedProviders) {
          let sendStarted = false;
          try {
            await select(client, provider, { requireExisting: Boolean(continueChat), fresh: !continueChat });
            if (continueChat && provider.id === 'chatgpt') await tool(client, 'browser_run_code_unsafe', { code: existingConversationCode });
            await tool(client, 'browser_run_code_unsafe', { code: providerReadyCode(provider) });
            let availability = toolValue(await tool(client, 'browser_run_code_unsafe', { code: providerAvailabilityCode(provider) }));
            if (!availability.available) { logger.error(provider.label + ' skipped: ' + availability.reason); exitCode = 1; continue; }
            if (checkOnly) { logger.log(provider.label + ' composer found.'); continue; }
            await tool(client, 'browser_run_code_unsafe', { code: await providerPrepareCode(provider, prompt, filePaths) });
            availability = toolValue(await tool(client, 'browser_run_code_unsafe', { code: providerAvailabilityCode(provider) }));
            if (!availability.available) { logger.error(provider.label + ' skipped: ' + availability.reason); exitCode = 1; continue; }
            logger.log(provider.label + ': prompt prepared. Review it in Chrome.');
            const answer = dryRun ? 'no' : autoSend ? 'yes' : (await rl.question(`Send to ${provider.label}? Type yes: `)).trim().toLowerCase();
            if (answer !== 'yes') { logger.log(provider.label + ': not submitted.'); continue; }
            await tool(client, 'browser_run_code_unsafe', { code: providerPreflightCode(provider, prompt) });
            sendStarted = true;
            const sent = toolValue(await tool(client, 'browser_run_code_unsafe', { code: providerSubmissionCode(provider, randomUUID()) }));
            logger.log(provider.label + ' submitted: ' + sent.url);
            if (!sendOnly) awaitingCapture.push({ provider, sent });
          } catch (error) {
            logger.error(provider.label + ': ' + error.message + (sendStarted ? ' Check Chrome before retrying; the prompt may have been sent.' : ' Nothing was sent.'));
            exitCode = 1;
          }
        }
        const outcomes = await captureAll(client, awaitingCapture.map(({ provider, sent }) => ({
          receipt: sent, label: provider.label, outputPath: outputPaths.get(provider.id),
          codeForResponse: value => providerResponseCode(provider, value),
          beforePoll: options => selectCapture(client, provider, sent.captureId, options),
          onComplete: response => {
            logger.log(provider.label + ' response saved to: ' + outputPaths.get(provider.id));
            logger.log('Conversation: ' + response.url);
          },
          onError: error => logger.error(provider.label + ': ' + error.message + ' The prompt was already submitted. Check Chrome before retrying.'),
        })), timeoutSeconds * 1000);
        if (outcomes.some(result => result.error)) exitCode = 1;
      } finally {
        await client.close();
      }
    }
  } catch (error) {
    logger.error(`Could not complete action: ${error.message}`);
    if (/Request timed out|extension did not connect/i.test(error.message)) {
      logger.error('Chrome did not receive the extension connection. Run this command in your own PowerShell window while your regular Chrome profile is open.');
    }
    exitCode = 1;
  } finally {
    try { await stagedAttachments?.cleanup(); } finally { rl.close(); }
  }
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli();
}
