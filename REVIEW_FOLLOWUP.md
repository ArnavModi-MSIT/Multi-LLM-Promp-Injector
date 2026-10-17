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
