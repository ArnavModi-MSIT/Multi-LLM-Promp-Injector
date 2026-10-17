# Prompt Injector

A free local prototype that sends one prompt and optional files to selected web LLMs in your
existing signed-in Chrome profile. It connects through Microsoft's Playwright Extension.
It does not use an LLM API or paid hosting. Check each provider's automation rules
and account limits before use; this prototype does not guarantee unattended delivery.

**Status:** ChatGPT prompt and Markdown attachment submission was observed in a
signed-in browser. A user-supplied screenshot showed Gemini submission and response capture completing.
The latest fixes and dependable behavior across all five providers still need live verification. Site layouts and free-plan limits may
change.

## Local web page

On Windows, double-click **start.cmd** in this folder. It installs dependencies if
needed, starts the backend, and opens the interface once the server is listening.
Keep its terminal window open; press **Ctrl+C** to stop it. Node.js 20 or newer
must already be installed. Use your signed-in Chrome with the Playwright Extension
for provider connections.

Open your regular signed-in Chrome, then in PowerShell run:

```powershell
npm ci
npm run web
```

Open [http://127.0.0.1:4173](http://127.0.0.1:4173). Enter a prompt, optionally
choose up to five files (10 MB each, 20 MB combined), select ChatGPT, Gemini, DeepSeek, Kimi, or Claude, and
click **Send to selected sites**. The tool submits to selected providers one at a time,
then polls their replies round-robin on the shared browser connection. In the Playwright Extension
dialog, approve the connection. Each normal run opens a fresh tab for each provider
within the connection's accessible tab group. The page shows separate status, conversation link, response,
and download button for each site.

**Prepare only** fills the prompt and attachment without sending. When using `--continue`, send or clear any existing text draft and remove staged
attachments before preparing another prompt; the
tool refuses to reuse an attachment draft. Response capture follows the original
submission tab even when other conversations for that provider are open. The site also
shows separate submission and response-capture states. If capture fails after
Send, any partial text remains visible and can be downloaded with an incomplete
warning. **Clear results** removes a finished job from server memory. It returns an error
while a job is running and does not cancel or detach that job. Repeated status connection
failures stop polling and restore the controls; inspect provider tabs before retrying
a submission whose status is uncertain.

The web capture timeout defaults to ten minutes. Set
`PROMPT_INJECTOR_CAPTURE_TIMEOUT_SECONDS` before startup to change it (up to one
hour). A browser disconnect stops the remaining operations, preserves any partial
text, and clears the cached connection for the next job. Ordinary action timeouts
do not reset that connection.

The page runs only on `127.0.0.1`. The backend checks the request Host and Origin
and requires a random local session token for API calls. Framing is blocked with
`X-Frame-Options` and a Content Security Policy. Request headers and bodies have
server timeouts. Prompts and responses remain in memory until cleared or the
server stops. Web attachments are copied once to a job-specific local temporary
directory and deleted in `finally`, including ordinary failures. POSIX permissions
are 0700/0600; Windows files inherit the user temp directory ACL. A forced process
kill can leave temporary files behind. CLI attachments use their original paths.

The token protects against requests from other websites, not programs running on
your computer: a local process can read the page and its token. Run this only on
a trusted machine. The API accepts prompts and attachment data, not JavaScript;
browser actions use fixed templates with JSON-escaped inputs. The page uses a
nonce-based script and style policy. Stopping the server prevents subsequent job
actions and closes its browser connection; an action already in flight may have
submitted, so check provider tabs before retrying.
Neither flow embeds attachment bytes in generated browser code. If browser observation fails after submission, inspect Chrome before clicking
Send again; the tool does not automatically retry a send.

## Setup

1. Install Node.js 20 or newer and Google Chrome.
2. Run `npm ci` in this folder.
3. In your regular Chrome profile, sign in normally to each site you want to use.
4. Install the official [Playwright Extension](https://chromewebstore.google.com/detail/playwright-extension/mmlmfjhmonkocbjadbfplnigmagldckm) in that same Chrome profile.
5. Run `npm start -- --check`. When Chrome asks to approve the Playwright connection,
   allow it and select a ChatGPT tab. The tool does not save an extension access token;
   Chrome can ask for approval on later runs.

Run the command in a normal PowerShell window in this folder. If no connection page
appears, set the token shown on the extension's status page for that PowerShell session:

```powershell
$env:PLAYWRIGHT_MCP_EXTENSION_TOKEN = Read-Host 'Extension token'
npm start -- --check
Remove-Item Env:\PLAYWRIGHT_MCP_EXTENSION_TOKEN
```

The same token workaround applies to `npm run web`: set the variable before
starting the server, and clear it after stopping. Only `--continue` deliberately
strips the token so you can choose the existing conversation.

If Chrome has multiple profiles, set `PLAYWRIGHT_MCP_PROFILE_DIR_NAME` to the
directory name shown at `chrome://version` under **Profile Path**. Do not put the
token in source files or commit it.

The extension connection can control tabs in your signed-in Chrome. Approve it only when
you intend to run this local script. No Google sign-in is attempted inside an automated
browser.

## Run

```powershell
npm start
```

Enter the prompt and optional file paths separated by semicolons. Review the result in Chrome, then type `yes`
in the terminal to send. Any other answer leaves it unsubmitted.

For a dry run that fills the prompt without sending:

```powershell
npm start -- --prompt "Your test prompt" --dry-run
```

Repeat `--file` for multiple attachments, for example `--file .\plan.md --file .\notes.txt`.
You can also read the prompt from a text file with `--prompt-file "C:\path\to\prompt.txt"`.

## Automatic submission and response capture

To attach a file and save ChatGPT's response:

```powershell
npm start -- --prompt "Summarize this document" --file .\plan.md --auto --output .\outputs\chatgpt-response.md
```

`--auto` skips the terminal send confirmation. Unknown flags, missing option values,
and conflicting provider or prompt options are rejected before connecting to Chrome. `--dry-run` always prevents sending,
even when combined with `--auto`. The extension can still require connection approval.
The script checks that every attachment is shown and waits for an enabled Send
button before submitting. After one Send or Enter attempt, a new user turn or a cleared editor plus
a generation/reply signal must confirm submission. An editor-read failure remains
uncertain. Capture requires a new assistant reply, a completion signal inside its
turn, no active generation, and 30 seconds of stable text. If these signals are
missing, the capture remains partial. Pending providers share the same capture
phase timeout and are polled in rounds. Each keeps its own last-change timestamp
and 30-second quiet window; providers do not each add a separate ten-minute wait. It saves the visible reply text and conversation URL to the output
file; exact rich-text formatting and downloadable files generated by ChatGPT are not
exported by this version.

Without `--output`, each response gets a timestamped filename under `outputs`.
Default output paths are anchored to this repository, so invoking the CLI from
another directory works. Explicit file and output paths remain relative to your
current directory. Existing output files are not overwritten; the CLI checks for an existing target
before submitting. For several providers, `--output review.md` produces
`review-chatgpt.md`, `review-gemini.md`, and so on. `--timeout 600` controls the response wait
in seconds (default: ten minutes). If completion cannot be confirmed or the browser connection fails, any extracted
text is saved with a `.partial.md` suffix and the program reports an error. It never
automatically resends a submitted prompt.

To target multiple sites from PowerShell:

```powershell
npm start -- --providers chatgpt,gemini,deepseek,kimi,claude --prompt "Summarize this document" --file .\plan.md --auto
```

Use `--provider gemini` for one site. The CLI submits to every selected provider
before collecting their replies, selecting the original submission tab for each
capture. Each provider has its own output file. A failure
for one site is reported separately and processing continues to the next. Chrome must
be signed in to each chosen site. ChatGPT submission and a Gemini completed capture have been observed in earlier
runs. These observations do not verify the latest adapters against your current
signed-in pages. If a site's editor, upload, or Send control cannot be identified, that site
is marked skipped and the run moves to the next site. Visible usage-limit messages,
including Claude's "out of usage credits" notice, also cause a skip before Send.
Site layouts, file support, and provider file count limits can
change. Inspect Chrome after any submission error before rerunning.

## Continue the open conversation

Use `--continue` for a follow-up in the existing ChatGPT conversation. It accepts
only the single provider `chatgpt`; mixed-provider continuation is rejected. It disables
token-based automatic tab selection for that connection, so choose the **existing
review conversation tab** in the Playwright Extension dialog. The script checks
that the selected tab is a ChatGPT conversation and does not navigate away from it.
If several conversations are accessible and none is selected, it refuses to guess.

To send a follow-up without waiting for response capture:

```powershell
npm start -- --continue --prompt "Please expand on your previous answer" --auto --send-only
```

`--send-only` returns after submission, leaving ChatGPT's reply and any downloadable
file in the selected tab. It avoids opening a new conversation for the follow-up.
Each separate command makes a new extension connection, so the existing tab must be
selected again. The extension limits each client to its own tab group.

## Local checks

Run `npm test` to check CLI argument handling and submission order, attachment
validation, tab identity, API access controls, polling recovery, and partial-response
preservation. These local regression checks do not validate live editors or Send
controls. The tool waits for a usable Send button before
clicking; DeepSeek and Kimi can use Enter if no unambiguous Send button is found.

Run `npm run test:http` for an actual loopback HTTP check. It starts and stops a
temporary server on port 4189, checks API access controls and invalid request
recovery, and never connects to Chrome. Set `PROMPT_INJECTOR_TEST_PORT` to another
free port if needed.

ChatGPT account access, free-plan limits, file availability, and site automation policies
are controlled by their providers and may change.

Dependencies are pinned in `package.json` and `package-lock.json`; use `npm ci`
for reproducible installs. The credential filename blocklist is a heuristic:
review the files yourself before sending. See [REVIEW_FOLLOWUP.md](REVIEW_FOLLOWUP.md)
for the review findings, corrections, and remaining live-verification work.

`npm run test:dom` runs all five adapters against local HTML fixtures in a separate
headless browser. Run `npm run test:dom:install` first to install the Chromium
binary matching the pinned Playwright version. Windows can also use installed
Chrome as a fallback. Every fixture request is intercepted locally; no provider
accounts or live responses are used. GitHub Actions runs unit, HTTP, and DOM
checks after `npm ci`.

Text attachments are checked for common private-key and token markers before
staging or connecting to Chrome. This is a heuristic, not a guarantee that a file
is safe to share. Missing reply selectors report node and turn counts to help
diagnose adapter drift. ChatGPT and the other providers use one shared pipeline
with provider-specific selectors and upload-menu configuration.
