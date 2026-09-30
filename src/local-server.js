import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connectToChrome, runBrowserTool, selectProviderTab } from './playwright-bridge.js';
import { getProvider, providerReadyCode, providerAvailabilityCode, providerPrepareCode, providerPreflightCode, providerSendCode, providerResponseCode } from './providers.js';
import { collectResponse, toolValue } from './response.js';
import { maxRequestBytes, validateAttachmentList } from './attachments.js';

const host = '127.0.0.1';
const port = Number(process.env.PROMPT_INJECTOR_PORT ?? 4173);
const origin = `http://${host}:${port}`;
const sessionToken = randomUUID();
const htmlPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/index.html');
let client;
let clientPromise;
let currentJob;

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxRequestBytes) throw new Error('Request is too large (20 MB combined file limit).');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function validateSubmission(data) {
  const prompt = typeof data.prompt === 'string' ? data.prompt.trim() : '';
  if (!prompt) throw new Error('Enter a prompt.');
  if (prompt.length > 100_000) throw new Error('Prompt is too long.');
  const ids = data.providers ?? ['chatgpt'];
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('Choose one or more unique providers.');
  const selected = ids.map(getProvider);
  const mode = data.mode === 'prepare' ? 'prepare' : data.mode === 'send' || data.mode == null ? 'send' : null;
  if (!mode) throw new Error('Invalid action.');
  const submittedFiles = data.files ?? (data.file ? [data.file] : []);
  if (!Array.isArray(submittedFiles)) throw new Error('Files must be a list.');
  const attachments = submittedFiles.map(file => {
    if (typeof file?.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64)) throw new Error('Invalid file data.');
    const buffer = Buffer.from(file.base64, 'base64');
    const name = file.name;
    const knownType = ({ '.md': 'text/markdown', '.txt': 'text/plain', '.pdf': 'application/pdf', '.csv': 'text/csv', '.json': 'application/json' })[path.extname(typeof name === 'string' ? name : '').toLowerCase()];
    return { name, size: buffer.length, mimeType: knownType ?? (typeof file.mimeType === 'string' && file.mimeType ? file.mimeType : 'application/octet-stream'), buffer };
  });
  validateAttachmentList(attachments);
  return { prompt, selected, mode, attachments };
}

async function browser() {
  if (client) return client;
  if (!clientPromise) {
    clientPromise = connectToChrome({ selectExistingTab: true }).then(value => {
      client = value;
      return value;
    }).finally(() => { clientPromise = undefined; });
  }
  return clientPromise;
}

async function processJob(job, submission) {
  const awaitingCapture = [];
  job.phase = 'sending';
  for (const [index, item] of job.results.entries()) {
    job.currentProvider = item.id;
    job.currentIndex = index + 1;
    const provider = getProvider(item.id);
    let sendStarted = false;
    try {
      item.status = 'connecting';
      const connected = await browser();
      item.status = 'checking-tab';
      await selectProviderTab(connected, provider);
      toolValue(await runBrowserTool(connected, 'browser_run_code_unsafe', { code: providerReadyCode(provider) }));
      let availability = toolValue(await runBrowserTool(connected, 'browser_run_code_unsafe', { code: providerAvailabilityCode(provider) }));
      if (!availability.available) {
        item.status = 'skipped';
        item.error = `${provider.label} cannot accept a prompt now: ${availability.reason}.`;
        continue;
      }
      item.status = 'attaching';
      await runBrowserTool(connected, 'browser_run_code_unsafe', { code: await providerPrepareCode(provider, submission.prompt, submission.attachments) });
      availability = toolValue(await runBrowserTool(connected, 'browser_run_code_unsafe', { code: providerAvailabilityCode(provider) }));
      if (!availability.available) {
        item.status = 'skipped';
        item.error = `${provider.label} cannot accept a prompt now: ${availability.reason}.`;
        continue;
      }
      if (submission.mode === 'prepare') {
        item.status = 'prepared';
        item.url = availability.url;
        continue;
      }
      item.status = 'checking-send';
      toolValue(await runBrowserTool(connected, 'browser_run_code_unsafe', { code: providerPreflightCode(provider, submission.prompt) }));
      item.status = 'submitting';
      // A failed click may still have submitted. Never retry this call.
      sendStarted = true;
      item.submission = 'uncertain';
      const receipt = toolValue(await runBrowserTool(connected, 'browser_run_code_unsafe', { code: providerSendCode(provider) }));
      item.url = receipt.url;
      item.submission = 'sent';
      item.status = 'submitted';
      awaitingCapture.push({ item, provider, receipt });
    } catch (error) {
      item.status = sendStarted ? 'error' : 'skipped';
      if (sendStarted) item.capture = 'uncertain';
      item.error = `${error.message}${sendStarted ? ' The prompt may have been sent. Check this tab before trying again.' : ''}`;
      if (!sendStarted && client && /disconnected|closed|timed out/i.test(error.message)) {
        await client.close().catch(() => {});
        client = undefined;
      }
    }
  }
  job.phase = 'capturing';
  for (const [index, { item, provider, receipt }] of awaitingCapture.entries()) {
    job.currentProvider = item.id;
    job.currentIndex = index + 1;
    try {
      const connected = await browser();
      await selectProviderTab(connected, provider, { requireExisting: true });
      item.status = 'waiting-for-reply';
      item.capture = 'streaming';
      const response = await collectResponse(connected, receipt, null, 5 * 60_000, value => providerResponseCode(provider, value), provider.label, state => {
        if (state.text) item.response = state.text;
        if (state.url) item.url = state.url;
      });
      item.url = response.url;
      item.response = response.text;
      item.capture = 'complete';
      item.status = 'completed';
    } catch (error) {
      item.status = 'error';
      item.capture = item.response || error.partial?.text ? 'partial' : 'uncertain';
      if (error.partial?.text) item.response = error.partial.text;
      if (error.partial?.url) item.url = error.partial.url;
      item.error = `${error.message} The prompt was already submitted. Check its tab before trying again.`;
    }
  }
  job.phase = 'finished';
  job.currentProvider = null;
  job.status = job.results.some(item => !['completed', 'prepared'].includes(item.status)) ? 'completed-with-errors' : 'completed';
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.host !== `${host}:${port}`) return json(res, 403, { error: 'Invalid Host header.' });
    if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: 'Invalid Origin header.' });
    if (req.url?.startsWith('/api/') && req.headers['x-prompt-injector-token'] !== sessionToken) return json(res, 403, { error: 'Invalid local session.' });
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end((await fs.readFile(htmlPath, 'utf8')).replace('__LOCAL_SESSION_TOKEN__', sessionToken));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/clear') {
      if (req.headers.origin !== origin) return json(res, 403, { error: 'Request origin was not accepted.' });
      if (currentJob && !['completed', 'completed-with-errors', 'error'].includes(currentJob.status)) return json(res, 409, { error: 'A submission is running.' });
      currentJob = undefined;
      return json(res, 200, { cleared: true });
    }
    if (req.method === 'GET' && req.url?.startsWith('/api/status')) {
      const id = new URL(req.url, origin).searchParams.get('id');
      const found = currentJob && (!id || currentJob.id === id);
      json(res, found ? 200 : 404, found ? currentJob : { error: 'Job not found.' });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/submit') {
      if (req.headers.origin !== origin) return json(res, 403, { error: 'Request origin was not accepted.' });
      if (!String(req.headers['content-type']).startsWith('application/json')) return json(res, 415, { error: 'Expected JSON.' });
      if (currentJob && !['completed', 'completed-with-errors', 'error'].includes(currentJob.status)) return json(res, 409, { error: 'A submission is already running.' });
      const submission = validateSubmission(await body(req));
      currentJob = { id: randomUUID(), status: 'running', phase: 'queued', currentProvider: null, currentIndex: 0, results: submission.selected.map(({ id, label }) => ({ id, label, status: 'queued', submission: 'not_sent', capture: 'not_started', url: '', response: '', error: '' })) };
      json(res, 202, { id: currentJob.id });
      void processJob(currentJob, submission).catch(error => { currentJob.status = 'error'; currentJob.error = error.message; });
      return;
    }
    json(res, 404, { error: 'Not found.' });
  } catch (error) {
    json(res, 400, { error: error.message });
  }
});

server.listen(port, host, () => console.log(`Prompt Injector: ${origin}`));

process.on('SIGINT', async () => {
  if (client) await client.close().catch(() => {});
  server.close();
});
