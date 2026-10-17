# Review follow-up

The supplied reviews were compared with the current checkout rather than applied
as instructions. Their line numbers and test totals refer to different snapshots.
The following groups cover the reported correctness and hardening findings.

| Finding | Result in this change |
| --- | --- |
| Clear-results/job concurrency race | Not present in the reviewed checkout: Clear and Submit return 409 during body validation or an active job. Added an active-job regression test. Clear does not cancel a job. |
| DeepSeek/Kimi false successful send | Fixed: editor-read errors propagate; a cleared editor alone is insufficient. A new turn or independent generation/reply/conversation signal must acknowledge the single action. No automatic retry. |
| Premature response completion | Removed page-wide Copy counts and the eight-second shortcut. Completion requires turn-local evidence, no observed generation, and 30 seconds of stable text. Missing or ambiguous signals remain partial. |
| Browser connection lifecycle | Connect once per job. Ordinary action timeouts preserve the client and capture markers. Disconnects stop further browser work, mark affected captures uncertain, and clear the cached client for the next job. |
| ChatGPT attachment confirmation | Uses the same draft-scoped filename/metadata helper as other adapters, excluding conversation history. No page-wide old-filename matching. |
| Unsent draft overwrite | Preparation refuses a nonempty editor before filling or uploading. Normal runs open fresh provider tabs; continuation requires an explicit existing tab. |
| Tab titles containing square brackets | Centralized parser accepts nested brackets in titles and parentheses in URLs. Submitted-tab selection shares that parser and the guarded result decoder. |
| Broad Send matching | Removed page-wide generic submit matching. Specific controls are scoped to the composer form where available. Generic controls use exact labels/test IDs; Enter is only considered when there are no candidates, not multiple candidates. |
| Multiline prompt comparison | Editor line blocks are read structurally; only CRLF and outer whitespace are normalized. Internal indentation and blank lines must remain intact. |
| Framing and HTTP errors | Added frame denial, CSP frame-ancestors, and referrer policy. Invalid input is 400/413; unexpected failures are 500. Startup port errors are readable; shutdown closes HTTP connections. |
| Preparation timeout | One 90-second budget covers uploads and confirmation of all files, below the 120-second MCP call budget. Request header/body timeouts are configured. |
| MIME/credential validation | One MIME helper is used by web and CLI adapters. Added obvious credential names/extensions to the filename heuristic. Canonical base64 round-trip validation replaces the large redundant regex. |
| Kimi/Claude adapter definitions | Kimi opens the official `.com` site and retains `.ai` aliases. Claude no longer uses a page-wide `[data-is-streaming="false"]` reply selector. Both remain subject to live DOM verification. |
| Working directory/dependency drift | MCP executable and default outputs resolve from the repository/module location. Dependencies are exactly pinned. Explicit CLI input/output paths remain relative to the caller's directory. |
| Availability/capture configuration | Notices inside conversation regions are excluded. Web capture timeout defaults to ten minutes and is configurable. Removed the unused ChatGPT response prompt parameter. |

Kimi host evidence: both [kimi.com](https://www.kimi.com/) and
[kimi.ai](https://www.kimi.ai/) served the official Kimi chat page when checked.
This verifies the destinations, not signed-in selectors or provider reliability.

## Verification and remaining limits

Regression tests cover the reproduced editor-error and tab-title failures, draft
preservation, preparation budgets, conservative completion, client recovery, and
the existing security/submission invariants. The HTTP smoke script also exercises
a request containing 20 MB of decoded dummy files and a 100,000-character prompt;
it intentionally uses a blocked credential filename so no Chrome connection or
provider upload occurs.

That HTTP check does **not** prove provider acceptance of 20 MB uploads. Attachments
now use local file paths rather than base64 embedded in generated MCP code. Web
files are staged once in a per-job temporary directory, then removed in `finally`;
CLI files use original paths. Windows inherits the user temp directory ACL, while
POSIX uses 0700 directories and 0600 files. Forced termination can leave files behind.

Signed-in upload readiness, icon-only controls without recognizable attributes,
completion footers, localized limit messages, and provider-specific file support
still require live browser evidence. A stale nonempty file input is conservatively
refused in continuation mode; whether a provider leaves such inputs populated
after sending remains unverified. Cancellation is a separate feature request,
not a fix for the already-guarded Clear endpoint. No ToS or account-safety assurance
is inferred from passing tests.

## Follow-up review: 17 October 2026

- Capture now visits pending providers sequentially in rounds. Each has its own
  `lastChangeAt`, completion window, and deadline, so five completed replies share
  a 30-second observation window rather than taking five separate windows.
- Normal web connections explicitly forward extension-token access. Explicit ChatGPT
  continuation strips it and mixed/non-ChatGPT `--continue` is rejected.
- Reply diagnostics include selectors, raw matches, distinct turns, and new turns.
  Nested selector matches are deduplicated; stable provider IDs or text
  fingerprints distinguish new replies even if previous nodes are virtualized.
  Repeated identical replies without stable IDs can still be ambiguous.
- All five providers use one generated prepare/send/preflight/capture pipeline.
  ChatGPT configuration retains its composer IDs, upload menu, and 60-second
  preflight wait; its old module only delegates for compatibility.
- Text file content is checked for common credential markers before upload.
  Unexpected job errors finalize intermediate result states while preserving
  completed and partial replies.
- Five local HTML fixtures run in headless Chromium. They cover attachments,
  multiline contenteditable input, nested Gemini replies, virtualized history,
  send confirmation, and completion. A real-DOM failure exposed Chromium's
  extra `innerText` newline around empty editor blocks; structural text extraction
  fixed it without accepting damaged indentation.
- CI runs unit, localhost HTTP, and fixture DOM checks using pinned revisions of
  the official [checkout](https://github.com/actions/checkout) and
  [setup-node](https://github.com/actions/setup-node) actions. CI and these fixtures
  never access signed-in provider accounts.
- Repository renaming and moving the existing docs were left out of this
  reliability change. Live selectors remain unverified; fixture success proves
  the generated code works on those fixture layouts, not on current provider UIs.

## Follow-up review: parsing, shutdown, and local UI

- `toolValue` now prefers structured MCP output. Legacy JSON is parsed intact
  before considering trailing MCP headings; malformed output keeps the uncertain
  submission warning. Tests cover nested JSON, escaped headings, scalar values,
  and malformed responses.
- The localhost token is a cross-site request safeguard, not authentication
  against other local programs. The API executes fixed, JSON-escaped templates;
  it does not expose an arbitrary JavaScript input. README documents this trust
  boundary. The UI now requires script/style nonces through CSP.
- Shutdown stops subsequent job actions, closes a late-arriving connection, and
  preserves uncertainty for any send already in flight. Regression tests cover
  shutdown during browser work and pending connection completion.
- UI provider choices and conversation host checks come from the adapter
  definitions. Unchanged provider panels retain their nodes; updated panels
  preserve response scroll position. Headless checks load the actual local
  server and verify the CSP, choices, and unchanged response rendering.
- Full response text is still returned by status polling. A separate versioned
  response endpoint, a shared CLI/web runner, and optional type checking remain
  possible follow-ups. No license was selected on the author's behalf.
- Earlier review claims about serial capture, duplicated ChatGPT adapters,
  base64 transport per provider, invalid JSON returning 500, and unsupported
  `--continue` providers describe older code and are already covered by fixes.
- The 30-second completion quiet window remains conservative. Fixture tests do
  not justify shortening it or claiming current signed-in provider compatibility.

## Follow-up review: credential formats and unavailable controls

- Added credential MIME rejection for PEM, PKCS#12 and PKCS#8 formats, including
  ordinary filenames and parameterized/case-insensitive MIME labels. The check
  runs before extension-based MIME normalization can hide the supplied type.
  Filename and content checks remain heuristics; MIME labels are not trusted proof
  of file contents.
- Added non-HTTPS regression checks for every provider, covering HTTP, file, blob,
  and data URLs. The existing HTTPS allowlist already excludes these schemes.
- All five browser fixtures now test disabled Send controls and missing editors.
  They use short test-only timeouts and verify the unsent prompt remains intact.
- Added a troubleshooting matrix covering extension approval/token selection,
  continuation, missing controls, attachment confirmation, incomplete captures,
  intentional single-provider retries, and credential rejection.
- Review claims about connection-per-provider, duplicated ChatGPT logic, absent
  CSP restrictions, absent adapter tests, and absent partial warnings are stale.
  The CLI connects once per invocation; the web server also reuses its connection.
- The session token is not visible in the rendered UI. It remains in the local
  page source and saved HTML must be treated as sensitive while that server
  session is active. A cookie would change the CSRF/authentication model and
  would not protect against other local programs. Existing no-store headers,
  same-origin controls, nonces, and documented local trust boundary remain.
- Parallel tab operations are unsuitable without proving isolation of the MCP
  selected-tab state. Readiness waits return immediately when controls exist;
  caching them across navigation would risk stale state. Completion timing stays
  conservative until live provider evidence supports a shorter window.
- Optional verbose logging, configurable capture stability, separate provider
  config, type annotations, and shared error formatting are feature/refactor
  suggestions rather than reproduced defects. Manual single-provider retry is
  already possible; no automatic or one-click resend was added.

## Qwen and provider file policies

- Added Qwen (`https://chat.qwen.ai/`) to the common adapter definitions and CLI.
  Public inspection found `textarea.message-input-textarea`, `input#filesUpload`
  with `multiple`, and a button labelled Send. No message was submitted. Its
  response selectors remain experimental; synthetic fixture success is not live
  signed-in validation.
- Provider metadata now carries file policies to the UI. Qwen's user-reported
  free-tier limit is five files. DeepSeek and Qwen reject ZIP extensions and ZIP
  MIME labels. Unknown plan limits are labelled unverified rather than invented.
  The separate app limits remain five files, 10 MB each, 20 MB combined.
- Rules are enforced before any browser connection in the web API and CLI, with
  an additional preparation guard. The UI rejects incompatible selections before
  encoding attachments. Mixed-provider ZIP requests stop as a whole; no site's
  files are silently dropped. HTTP and CLI tests prove no browser action occurs.
- Attachment preparation now requires the full manifest at the same observation;
  earlier filenames cannot remain counted after their cards disappear. Preflight
  and Send both check expected attachment cards, and Send rechecks the expected
  prompt. Capture markers are assigned before attempting Send so uncertain tabs
  remain identifiable without resubmission.
- The CLI now stops remaining browser work on a confirmed transport disconnect.
  Ordinary provider timeouts can still continue; neither outcome retries Send.
- The expanded six-provider browser fixtures test five-file preparation, blocked
  controls, missing editors, and capture. Local UI checks cover the limits table,
  ZIP rejection for both sites, and Qwen's six-file rejection/five-file acceptance.
- Other review suggestions remain design options: existing Chrome extension
  sessions already retain authentication, and concurrent tab operations would
  race the shared selected-tab state. Automatic screenshots/DOM dumps of signed-in
  failures were not added because they could store conversation or account data.
  Existing dependency pins, CI, temporary-path transport, nonce CSP, and incremental
  result rendering already address several findings in the older review snapshots.

## Sourced free-tier file reference (17 October 2026)

- Replaced generic app-limit/provider-restriction table cells with upload
  allowances, file sizes, supported formats, source links and scope notes for
  every provider. Daily, per-prompt, per-chat and per-upload counts are separate.
- OpenAI Help states Free users have three uploads/day, with document, spreadsheet
  and image size limits. Google documents ten files/prompt and ZIP constraints.
  Current Claude upload help says twenty files/chat and 500 MB/chat file; this
  differs from project/code-execution workflow limits. Kimi's help documents
  fifty files/upload and 100 MB/file as general upload limits.
- DeepSeek's fifty-file/100-MB figures were visually checked in the original
  March 2025 Nanjing Audit University guide (PDF page 16). Its current public web
  page redirects to sign-in; these are labelled historical reported figures,
  not current official free-tier guarantees.
- Qwen's official 2025 announcement documents 20-MB text files. No current public
  numeric free-tier size cap was found. Its five-file limit and ZIP restriction
  remain the user's account report, labelled separately from the announcement.
- These reference figures do not raise app payload limits, change send behaviour,
  track a provider's remaining daily quota or claim signed-in live verification.
  Existing DeepSeek/Qwen ZIP guards and Qwen count validation are preserved.

## Submission-only workflow (user-requested simplification)

- Removed response extraction, round-robin capture, completion polling, response
  storage, Markdown output files, partial files and download controls from both
  web and CLI. Removed obsolete capture modules/tests and capture-only helpers.
- All six providers are selected by default. The same prompt and attachment
  manifest are submitted sequentially. Provider-specific file guards still apply;
  files are never silently omitted to make an incompatible provider succeed.
- Runs finish after submission acknowledgment. Status contains only each site's
  send state, conversation URL and errors. Replies remain in provider tabs.
- Submission acknowledgment counts DOM nodes and generation controls without
  reading assistant text. Browser fixtures make assistant-text reads throw and
  confirm the submission receipts contain only submitted/url fields.
- Existing prompt-integrity checks, attachment checks, unsent-draft protection,
  one-attempt Send, disconnect handling, local API security and cleanup remain.
- Removed CLI response/output options. Normal CLI runs now submit to all six;
  --continue still defaults to the existing ChatGPT conversation. Prepare-only
  and --dry-run remain available. Historical capture notes above are superseded.

## Background-use failures: fresh tabs, restored drafts and file uploads

- Investigated the user's screenshots showing three existing-draft refusals and
  three setInputFiles timeouts. These do not prove a requirement to keep the
  provider's window foreground. Fully invisible operation is not guaranteed:
  upstream extension tab selection explicitly calls bringToFront.
- Fresh-tab selection now compares pre/post tab listings and selects the new
  index. It no longer trusts an old tab's current marker. Ambiguous creation
  fails conservatively. Each new tab receives a Node-side one-use marker.
- Only a marked job-created tab may replace provider-restored draft text. The
  marker is consumed during preparation. Existing/continuation tabs and staged
  attachments stay protected; separate-tab fixture drafts remain intact.
- Upstream issue #1481 confirms an extension local-file access restriction.
  CLI/web uploads now use Playwright file buffers supplied by an ephemeral,
  token-protected loopback file transfer. No broader extension permission is
  enabled, no arbitrary filesystem URL is exposed, and no attachment base64 is
  embedded in tool code. The transfer is closed in every ordinary job exit path.
- Fixed two-step attachment menus, including Gemini's visible Upload files item.
  If the chooser or newly attached input allows multiple files, all remaining
  files are submitted together instead of replacing earlier selections.
- Regression tests cover VM-compatible buffer uploads, transfer authorization
  and cleanup, incorrect current-tab markers, restored drafts, untouched existing
  tabs, and Gemini's menu-created multi-file input. All six DOM fixtures run the
  production file-transfer path. This remains fixture evidence, not signed-in
  live success against the user's six current provider pages.
- The UI keeps the newly selected provider URL even on preparation failure so the
  failed tab can be opened. Background-use limitations are documented in the UI
  and README; response extraction remains removed.
- Fresh pages already selected by MCP no longer receive a redundant select call,
  which otherwise invokes bringToFront. Connection and tab creation may still
  activate Chrome; fully invisible execution is not claimed.

## Tab-list regression: reproduced against the installed MCP server

- Reproduced the user's exact "New tab identity is ambiguous" failure with the
  pinned MCP process and an isolated browser. Its new-tab response lists the
  same tabs under both Result and Open tabs. The previous parser combined both
  sections, counting one newly created tab twice. Simplified unit mocks and
  direct Playwright DOM checks did not exercise this protocol boundary.
- The parser now uses the latest Open tabs section (or Result when absent),
  deduplicates identical indices, and ignores page snapshots/code/console text.
  It retains crashed tab indices and refuses conflicting entries or genuinely
  multiple new tabs. Existing conversation drafts remain protected.
- Added a real-MCP integration check and CI step: all six local provider
  fixtures, repeated fresh runs, zero/five files, exact uploaded bytes, prompt
  integrity, one submission per tab, and preservation of an existing draft.
  This test failed with the previous bridge and passes with the correction.
- During the repository review, corrected a second upload-menu failure: a
  missing filechooser event now falls back to a newly revealed file input. The
  pending wait is also handled if clicking the menu fails first.
- Reviewed application sources, UI, launcher, scripts, tests, fixtures and
  configuration. Response extraction remains removed. These checks use local
  fixtures and the actual MCP protocol, not the user's signed-in provider UIs.
