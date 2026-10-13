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
| Multiline prompt comparison | Shared normalization handles CRLF, nonbreaking spaces, indentation, and duplicated editor paragraph breaks while still comparing the entire text in line order. |
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

That HTTP check does **not** verify 20 MB payload delivery through MCP or acceptance
by a provider. The generated code still transfers base64 through stdio. Moving
attachments to temporary files is a possible future change, not part of this
patch, because it changes the current memory-only handling of web attachments.

Signed-in upload readiness, icon-only controls without recognizable attributes,
completion footers, localized limit messages, and provider-specific file support
still require live browser evidence. A stale nonempty file input is conservatively
refused in continuation mode; whether a provider leaves such inputs populated
after sending remains unverified. Cancellation is a separate feature request,
not a fix for the already-guarded Clear endpoint. No ToS or account-safety assurance
is inferred from passing tests.
