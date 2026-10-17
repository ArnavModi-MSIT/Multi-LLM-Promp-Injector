# Prompt Injector

Send the same prompt and optional files to ChatGPT, Gemini, DeepSeek, Kimi,
Claude and Qwen through Microsoft's Playwright Extension in your signed-in
Chrome. All six sites are selected by default. Each gets a separate tab, and
submissions run one at a time on the shared connection.

The run ends after sending. Read generated answers directly in the provider
sites. The app does not extract, copy, save or download their responses.

This is a local prototype. Provider layouts and account limits can change;
fixture tests do not prove current signed-in compatibility. Check each provider's
automation rules and account limits before use.

## Setup and local page

Install Node.js 20 or newer. Open your regular Chrome profile, sign in to the
sites you want, and install the official [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm).

On Windows, double-click **start.cmd**. Or run in PowerShell:

```powershell
npm ci
npm run web
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). Enter your prompt, select
files if needed, and click **Send to selected sites**. Deselect any sites you
do not want. Approve the Playwright connection in Chrome if asked.

**Prepare only** fills drafts without sending. The page reports each site's
submission status and links to its conversation. **Clear status** clears a
finished run; it cannot interrupt an active submission. Keep the terminal open
and press **Ctrl+C** to stop the server.

Set `PROMPT_INJECTOR_PORT` to change the local port. Set
`PLAYWRIGHT_MCP_PROFILE_DIR_NAME` to the directory name shown in Chrome's
`chrome://version` Profile Path if you need a specific profile.

If extension approval never appears, set the token from its status page in the
same PowerShell session, then start the server or CLI:

```powershell
$env:PLAYWRIGHT_MCP_EXTENSION_TOKEN = Read-Host 'Extension token'
npm run web
# After stopping the server:
Remove-Item Env:\PLAYWRIGHT_MCP_EXTENSION_TOKEN
```

Do not commit the token or put it in source files.

## CLI

The CLI uses all six providers by default. `--auto` confirms sending without a
separate question for each site:

```powershell
npm start -- --prompt "Review these notes" --file .\notes.md --auto
```

Use `--prompt-file` for a multiline prompt and repeat `--file` for multiple files:

```powershell
npm start -- --prompt-file .\prompt.txt --file .\notes.md --file .\data.csv --auto
```

Choose a subset with `--provider qwen` or `--providers chatgpt,gemini`. Use
`--dry-run` to prepare without sending, or `--check` to check provider composers.
Without `--auto`, the CLI asks before sending to each site. With no prompt flag,
it asks for the prompt and file paths interactively. `/quit` exits; `/skip` skips
interactive attachments.

For an existing ChatGPT conversation:

```powershell
npm start -- --continue --prompt "Expand on the previous answer" --auto
```

`--continue` selects ChatGPT by default and rejects other providers. It removes
automatic token-based tab selection so you can choose the intended conversation
in the extension dialog. Other runs open fresh tabs. No output path, response
wait timeout or send-only flag is needed; response extraction has been removed.

## Provider attachment rules

The UI lists the known file rules beside the provider choices. The app allows
at most **5 files, 10 MB per file, 20 MB combined**; these are local app limits,
not a claim about each provider's plan or message quota.

File limits researched on **17 October 2026**. The UI includes the source link,
size limits, supported formats, and whether a figure is current documentation,
an older observation, or an account-specific rule.

| Provider | Upload allowance | Provider file sizes and source |
| --- | --- | --- |
| ChatGPT Free | 3 uploads/day; may be reduced at peak times | 512 MB documents, about 50 MB spreadsheets, 20 MB images. [OpenAI Help](https://help.openai.com/en/articles/8555545-uploading-files-and-audio-to-chatgpt). |
| Gemini | Up to 10 files/prompt, subject to availability | 100 MB most files, 2 GB videos. ZIP up to 10 files/100 MB without audio/video. [Google Help](https://support.google.com/gemini/answer/14903178?hl=en). |
| Claude | Up to 20 files/chat; Free usage/context caps also apply | 500 MB for chat uploads. Project and code-execution limits differ. [Claude Help](https://support.claude.com/en/articles/8241126-upload-files-to-claude). |
| Kimi | Up to 50 files/upload; general published limit | 100 MB/file. [Kimi Help](https://www.kimi.com/en/help/new-user-guide/overview). |
| DeepSeek | Reported 50 files/prompt | Reported 100 MB/file in a [March 2025 university UI guide](https://sea.nau.edu.cn/_upload/article/files/9f/48/0664056241d39174c060c10d3ec7/84a746e6-c8d1-4869-bd9e-246aa117040f.pdf#page=16); not confirmed as a current official cap. ZIP blocked for this account. |
| Qwen | Up to 5 files/prompt from the user's account report | 20 MB text files in Qwen's [2025 announcement](https://www.linkedin.com/posts/qwen_introducing-the-enhanced-qwen-chat-we-activity-7305263420348514305-vVZ8); current free-tier size cap not established. ZIP blocked for this account. |

Provider allowances in the table are informational and do not raise this app's
5-file/10-MB/20-MB limits. Daily/rolling quotas include other conversations and
cannot be tracked here. Published general upload counts are not promises of a
fixed daily free-tier allowance. No current official numeric web quota could be
confirmed for DeepSeek; Qwen's five-file policy remains account-reported.

Qwen's file count and the two ZIP restrictions are configured from the user's
reported account behaviour. The UI, HTTP API, CLI, and preparation generator
check these rules. A mixed-provider request containing a ZIP and either Qwen or
DeepSeek stops before opening Chrome. Remove the archive or deselect those sites;
files are never silently omitted for an individual provider.

Use `npm start -- --provider qwen --prompt "Review these notes" --file notes.md`
for Qwen alone. Its public textarea, upload input, and labelled Send control were
inspected without submitting a message. Signed-in upload processing and submission still need live verification.

## Submission safeguards

The tool protects existing unsent drafts and staged attachments, checks the
whole expected attachment set, and rechecks the prompt immediately before Send.
It waits for submission evidence such as a new user turn or a cleared composer
with generation evidence. It counts response nodes for acknowledgment without
reading their text. It does not wait for generation to finish.

A provider error can skip that site and continue. A confirmed browser disconnect
stops subsequent browser actions. Send is never automatically retried: a failed
click or acknowledgment may still mean the prompt was submitted. Inspect that
tab before intentionally trying again.

## Local security and files

The server binds to `127.0.0.1`, checks Host and Origin, and requires a random API
session token. Nonce-based CSP, anti-framing headers, request-size limits and HTTP
timeouts protect the page. The token protects against other websites, not local
programs that can read the page. Run on a trusted computer.

The API accepts prompts and attachments, not JavaScript; browser actions use
fixed templates with JSON-escaped inputs. Submission metadata stays in memory
until cleared or shutdown. Provider response text is never stored by this tool.

Web files are copied once into a job-specific temporary directory and removed
in `finally`. CLI files use their original paths. POSIX temp permissions are
0700/0600; Windows inherits the user's temp-directory ACL. A forced kill can
leave temporary files behind. Credential filename, MIME and text-marker checks
are heuristics; review files yourself before sending.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Extension approval never appears | Check the intended Chrome profile and extension; use the session-token workflow above. |
| Composer not found | Sign in and dismiss dialogs, then check whether the site's layout changed. |
| Send button not ready | Check unfinished uploads, account limits and model availability. Inspect or clear the staged draft before preparing again. |
| Attachment not confirmed | Check supported file types and upload processing. A selected file is not proof of successful upload. |
| Uncertain submission | Open the provider tab before retrying. The prompt may already have been sent. |
| One provider failed | Check its tab, then select only that provider for a deliberate new attempt. |

## Local checks

```powershell
npm test
npm run test:http
npm run test:dom:install
npm run test:dom
```

Unit tests cover validation, defaults, submission order, uncertainty, disconnects,
server access controls and shutdown. HTTP checks start a temporary loopback
server without connecting to Chrome. DOM checks use six local provider fixtures
in a separate headless browser and assert that assistant text is not read. They
also verify all six default selections, the file-limits table and status-only UI.
Windows can use installed Chrome as a fallback for these isolated fixtures.
GitHub Actions runs these checks after `npm ci` with pinned dependencies.

See [REVIEW_FOLLOWUP.md](REVIEW_FOLLOWUP.md) for historical review notes. Earlier
capture/output designs in that log have been superseded by submission-only runs.
