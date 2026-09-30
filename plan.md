# Prompt Injector plan

## Goal and constraints

Run a free, local website that sends one prompt and optionally multiple files to selected
signed-in web LLMs. The backend runs on `127.0.0.1`; Playwright controls an
extension-approved tab in the user's Chrome profile. There are no paid APIs,
hosting, analytics, or attempts to bypass provider limits.

## Current implementation

- The website and CLI support ChatGPT, Gemini, DeepSeek, Kimi, and Claude.
- The website submits to providers sequentially before collecting replies.
  Each provider gets its own tab within the Playwright connection's accessible
  tab group. The tool selects that tab before acting and leaves conversations open.
- Each result records submission (`not_sent`, `uncertain`, `sent`) separately
  from response capture (`not_started`, `streaming`, `complete`, `partial`,
  `uncertain`). A send action is never retried automatically.
- A provider with a visible usage-limit message or missing input is skipped.
- The page shows partial text and the conversation URL if capture fails after
  sending, and marks incomplete downloads accordingly.
- The local API checks `Host`, `Origin`, and a random token generated at server
  startup. Browser navigation accepts only hardcoded provider URLs. Prompt,
  attachment, and response data remain in process memory until cleared or the
  server stops. The upload limit is five files, 10 MB each and 20 MB combined.
- **Prepare only** fills selected providers without sending.

## Verified evidence

- ChatGPT accepted a prompt and Markdown attachment in the regular signed-in
  Chrome profile and returned `WEB_TEST_OK`.
- The user reports that ChatGPT and DeepSeek submissions work. A Gemini
  screenshot shows a staged Markdown attachment and prompt but no submission.
  Kimi was not reached while the old flow waited for earlier replies.
- That proves submission and one visible reply. It does not prove dependable
  response extraction, generated-file download, or the other providers.

## Capability matrix

| Capability | ChatGPT | Gemini | DeepSeek | Kimi | Claude |
| --- | --- | --- | --- | --- | --- |
| Prompt and Markdown attachment reaches site | Observed | Staged only | User reported | Unverified | Unverified |
| Complete response captured by local app | Unverified | Unverified | Unverified | Unverified | Unverified |
| Multiple files in one prompt | Unverified | Unverified | Unverified | Unverified | Unverified |
| PDF and other file types | Unverified | Unverified | Unverified | Unverified | Unverified |
| Generated files downloaded | Deferred | Deferred | Deferred | Deferred | Deferred |

## Next work, in order

1. Verify new-turn detection and completion on ChatGPT. Snapshot the assistant
   turn count before Send; accept only a new turn afterward. Require no active
   generation indicator and stable text. Treat ambiguous completion as partial
   or uncertain; never silently call it complete.
2. Check the new local security controls in a browser: reject foreign Host and
   Origin, reject missing session token, and keep the UI usable after refresh.
3. Validate one provider at a time in the signed-in Chrome profile: composer,
   multiple attachments, upload completion, exactly one Send, new reply, completion,
   response extraction, and failure states. Record evidence before marking a
   capability verified.
4. Improve upload readiness and supported-file reporting per provider. Keep
   provider-specific file limits visible when observed live.
5. Add local fixture checks for selectors and completion logic when requested.
   Fixtures can catch regressions but do not prove live provider behavior.

## Operating rules

- Never retry Send after an uncertain error or response-capture failure.
- Never print prompts, responses, uploaded content, cookies, or extension tokens
  in logs. Keep conversation links private.
- Do not navigate to user-supplied URLs. The provider allowlist is fixed in
  code. Keep the server bound to loopback and require a same-origin local token
  for API calls.
- Respect authentication, CAPTCHAs, usage caps, and unsupported file types.
  Skip or report the condition; do not automate bypasses.
- A separate Chrome profile containing only the intended LLM logins is safer
  when granting the Playwright Extension access.
