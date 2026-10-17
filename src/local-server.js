import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { connectToChrome, runBrowserTool, selectProviderTab, selectSubmissionTab, isBrowserDisconnect } from './playwright-bridge.js';
import { providers, getProvider, providerReadyCode, providerAvailabilityCode, providerPrepareCode, providerPreflightCode, providerSubmissionCode, providerResponseCode } from './providers.js';
import { collectResponses, toolValue } from './response.js';
import { stageAttachmentPaths } from './attachment-paths.js';
import { maxRequestBytes, validateAttachmentList, attachmentMimeType } from './attachments.js';

const host = '127.0.0.1';
const port = Number(process.env.PROMPT_INJECTOR_PORT ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PROMPT_INJECTOR_PORT must be an integer between 1 and 65535.');
const origin = `http://${host}:${port}`;
const captureTimeoutSeconds = Number(process.env.PROMPT_INJECTOR_CAPTURE_TIMEOUT_SECONDS ?? 600);
if (!Number.isFinite(captureTimeoutSeconds) || captureTimeoutSeconds <= 0 || captureTimeoutSeconds > 3600) throw new Error('PROMPT_INJECTOR_CAPTURE_TIMEOUT_SECONDS must be between 0 and 3600 seconds.');
const sessionToken = randomUUID();
const scriptNonce = randomUUID();
const htmlPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/index.html');
let client;
let clientPromise;
let currentJob;
let submissionPending = false;
let shuttingDown = false;

const safetyHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': `default-src 'self'; script-src 'nonce-${scriptNonce}'; style-src 'nonce-${scriptNonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'`, 'Referrer-Policy': 'no-referrer' };

function ensureRunning() {
  if (shuttingDown) throw new Error('Server is shutting down. Check provider tabs before retrying.');
}

async function jobTool(...args) {
  ensureRunning();
  const value = await runBrowserTool(...args);
  ensureRunning();
  return value;
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...safetyHeaders });
  res.end(JSON.stringify(value));
}

async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxRequestBytes) throw Object.assign(new Error('Request exceeds the 28 MB encoded JSON limit (20 MB of decoded attachments).'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function validateSubmission(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected a submission object.');
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
  if (submittedFiles.length > 5) throw new Error('Choose at most 5 files.');
  const attachments = submittedFiles.map(file => {
    if (typeof file?.base64 !== 'string') throw new Error('Invalid file data.');
    const buffer = Buffer.from(file.base64, 'base64');
    if (buffer.toString('base64') !== file.base64) throw new Error('Invalid file data.');
    const name = file.name;
    return { name, size: buffer.length, mimeType: attachmentMimeType(name, file.mimeType), buffer };
  });
  validateAttachmentList(attachments);
  return { prompt, selected, mode, attachments };
}

async function browser() {
  ensureRunning();
  if (client) return client;
  if (!clientPromise) {
    clientPromise = connectToChrome().then(async value => {
      if (shuttingDown) { await value.close().catch(() => {}); ensureRunning(); }
      client = value;
      const previousOnClose = value.onclose;
      value.onclose = () => {
        if (client === value) client = undefined;
        previousOnClose?.();
      };
      return value;
    }).finally(() => { clientPromise = undefined; });
  }
  return clientPromise;
}

function failJob(job, error) {
  job.status = 'error'; job.phase = 'finished'; job.currentProvider = null; job.error = error.message;
  for (const item of job.results) {
    if (['completed', 'prepared', 'skipped', 'error'].includes(item.status)) continue;
    const mayBeSent = item.submission !== 'not_sent';
    item.status = mayBeSent ? 'error' : 'skipped';
    item.capture = mayBeSent ? item.response ? 'partial' : 'uncertain' : 'not_started';
    item.error = error.message + (mayBeSent ? ' Check this tab before retrying; submission may have occurred.' : ' Nothing was sent.');
  }
}

async function processJob(job, submission) {
  let staged;
  try {
    ensureRunning();
    staged = await stageAttachmentPaths(submission.attachments);
    await runJob(job, { ...submission, attachments: staged.files });
  } catch (error) { failJob(job, error); }
  finally { await staged?.cleanup(); }
}

async function runJob(job, submission) {
  const awaitingCapture = [];
  let connected;
  try { connected = await browser(); }
  catch (error) {
    if (shuttingDown) throw error;
    for (const item of job.results) { item.status = 'skipped'; item.error = 'Browser connection failed before submission: ' + error.message; }
    job.phase = 'finished'; job.status = 'completed-with-errors'; job.currentProvider = null;
    return;
  }
  let disconnected;
  job.phase = 'sending';
  for (const [index, item] of job.results.entries()) {
    job.currentProvider = item.id;
    job.currentIndex = index + 1;
    const provider = getProvider(item.id);
    let sendStarted = false;
    try {
      ensureRunning();
      item.status = 'connecting';
      if (disconnected) throw disconnected;
      item.status = 'checking-tab';
      await selectProviderTab(connected, provider, { fresh: true });
      toolValue(await jobTool(connected, 'browser_run_code_unsafe', { code: providerReadyCode(provider) }));
      let availability = toolValue(await jobTool(connected, 'browser_run_code_unsafe', { code: providerAvailabilityCode(provider) }));
      if (!availability.available) {
        item.status = 'skipped';
        item.error = `${provider.label} cannot accept a prompt now: ${availability.reason}.`;
        continue;
      }
      item.status = 'attaching';
      await jobTool(connected, 'browser_run_code_unsafe', { code: await providerPrepareCode(provider, submission.prompt, submission.attachments) });
      availability = toolValue(await jobTool(connected, 'browser_run_code_unsafe', { code: providerAvailabilityCode(provider) }));
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
      toolValue(await jobTool(connected, 'browser_run_code_unsafe', { code: providerPreflightCode(provider, submission.prompt) }));
      ensureRunning();
      item.status = 'submitting';
      // A failed click may still have submitted. Never retry this call.
      sendStarted = true;
      item.submission = 'uncertain';
      const captureId = randomUUID();
      const receipt = toolValue(await jobTool(connected, 'browser_run_code_unsafe', { code: providerSubmissionCode(provider, captureId) }));
      item.url = receipt.url;
      item.submission = 'sent';
      item.status = 'submitted';
      awaitingCapture.push({ item, provider, receipt });
    } catch (error) {
      if (shuttingDown) throw error;
      item.status = sendStarted ? 'error' : 'skipped';
      if (sendStarted) item.capture = 'uncertain';
      item.error = `${error.message}${sendStarted ? ' The prompt may have been sent. Check this tab before trying again.' : ''}`;
      if (isBrowserDisconnect(error)) disconnected = error;
    }
  }
  job.phase = 'capturing';
  await collectResponses(connected, awaitingCapture.map(({ item, provider, receipt }, index) => ({
    receipt, label: provider.label, codeForResponse: value => providerResponseCode(provider, value),
    beforePoll: async options => {
      ensureRunning();
      if (disconnected) throw disconnected;
      job.currentProvider = item.id; job.currentIndex = index + 1;
      await selectSubmissionTab(connected, provider, receipt.captureId, options);
      ensureRunning();
      item.status = 'waiting-for-reply'; item.capture = 'streaming';
    },
    onUpdate: state => { if (state.text) item.response = state.text; if (state.url) item.url = state.url; },
    onComplete: response => { ensureRunning(); item.url = response.url; item.response = response.text; item.capture = 'complete'; item.status = 'completed'; },
    onError: error => {
      item.status = 'error'; item.capture = item.response || error.partial?.text ? 'partial' : 'uncertain';
      if (error.partial?.text) item.response = error.partial.text;
      if (error.partial?.url) item.url = error.partial.url;
      item.error = `${error.message} The prompt was already submitted. Check its tab before trying again.`;
      if (isBrowserDisconnect(error)) disconnected = error;
    },
  })), captureTimeoutSeconds * 1000);
  ensureRunning();
  if (disconnected) {
    await connected.close().catch(() => {});
    if (client === connected) client = undefined;
  }
  job.phase = 'finished';
  job.currentProvider = null;
  job.status = job.results.some(item => !['completed', 'prepared'].includes(item.status)) ? 'completed-with-errors' : 'completed';
}

const server = http.createServer(async (req, res) => {
  try {
    if (shuttingDown) return json(res, 503, { error: 'Server is shutting down.' });
    if (req.headers.host !== `${host}:${port}`) return json(res, 403, { error: 'Invalid Host header.' });
    if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: 'Invalid Origin header.' });
    const requestUrl = new URL(req.url, origin);
    if (requestUrl.origin !== origin) return json(res, 403, { error: 'Invalid request URL.' });
    if (requestUrl.pathname.startsWith('/api/') && req.headers['x-prompt-injector-token'] !== sessionToken) return json(res, 403, { error: 'Invalid local session.' });
    if (req.method === 'GET' && requestUrl.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...safetyHeaders });
      const metadata = Object.values(providers).map(({ id, label, hosts }) => ({ id, label, hosts }));
      res.end((await fs.readFile(htmlPath, 'utf8')).replace('__LOCAL_SESSION_TOKEN__', sessionToken)
        .replaceAll('__LOCAL_CSP_NONCE__', scriptNonce)
        .replace('__LOCAL_PROVIDER_METADATA__', JSON.stringify(metadata).replaceAll('<', '\\u003c')));
      return;
    }
    if (req.method === 'POST' && requestUrl.pathname === '/api/clear') {
      if (req.headers.origin !== origin) return json(res, 403, { error: 'Request origin was not accepted.' });
      if (submissionPending || (currentJob && !['completed', 'completed-with-errors', 'error'].includes(currentJob.status))) return json(res, 409, { error: 'A submission is running.' });
      currentJob = undefined;
      return json(res, 200, { cleared: true });
    }
    if (req.method === 'GET' && requestUrl.pathname === '/api/status') {
      const id = requestUrl.searchParams.get('id');
      const found = currentJob && (!id || currentJob.id === id);
      json(res, found ? 200 : 404, found ? currentJob : { error: 'Job not found.' });
      return;
    }
    if (req.method === 'POST' && requestUrl.pathname === '/api/submit') {
      if (req.headers.origin !== origin) return json(res, 403, { error: 'Request origin was not accepted.' });
      if (!String(req.headers['content-type']).startsWith('application/json')) return json(res, 415, { error: 'Expected JSON.' });
      if (submissionPending || (currentJob && !['completed', 'completed-with-errors', 'error'].includes(currentJob.status))) return json(res, 409, { error: 'A submission is already running.' });
      submissionPending = true;
      let submission;
      try { submission = validateSubmission(await body(req)); }
      catch (error) { error.statusCode ??= 400; throw error; }
      finally { submissionPending = false; }
      ensureRunning();
      currentJob = { id: randomUUID(), status: 'running', phase: 'queued', currentProvider: null, currentIndex: 0, results: submission.selected.map(({ id, label }) => ({ id, label, status: 'queued', submission: 'not_sent', capture: 'not_started', url: '', response: '', error: '' })) };
      json(res, 202, { id: currentJob.id });
      const job = currentJob;
      void processJob(job, submission).catch(error => failJob(job, error));
      return;
    }
    json(res, 404, { error: 'Not found.' });
  } catch (error) {
    json(res, error.statusCode ?? 500, { error: error.statusCode ? error.message : 'Internal server error.' });
  }
});

server.requestTimeout = 30000;
server.headersTimeout = 15000;

server.listen(port, host, () => {
  console.log(`Prompt Injector: ${origin}`);
  if (process.platform === 'win32' && process.env.PROMPT_INJECTOR_OPEN_BROWSER === '1') {
    const opener = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', origin], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    opener.on('error', () => console.error(`Could not open your browser. Open ${origin} manually.`));
    opener.unref();
  }
});

server.on('error', error => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Stop the earlier backend or choose PROMPT_INJECTOR_PORT.` : 'Could not start the local server: ' + error.message);
  process.exitCode = 1;
});

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (currentJob?.status === 'running') failJob(currentJob, new Error('Server is shutting down.'));
  server.close();
  server.closeAllConnections?.();
  if (client) await client.close().catch(() => {});
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
