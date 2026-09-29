# Prompt Injector plan

## Goal and constraints

Run a free, local website that sends one prompt and optionally one file to selected
signed-in web LLMs. The backend runs on `127.0.0.1`; Playwright controls an
extension-approved tab in the user's Chrome profile. There are no paid APIs,
hosting, analytics, or attempts to bypass provider limits.

## Current implementation

- The website and CLI support ChatGPT, Gemini, DeepSeek, Kimi, and Claude.
- The website processes providers sequentially through one approved tab. This
  avoids needing extension approval for five separate tabs. Navigating to the
  next provider means the current tab ends on the last selected site.
- Each result records submission (`not_sent`, `uncertain`, `sent`) separately
  from response capture (`not_started`, `streaming`, `complete`, `partial`,
  `uncertain`). A send action is never retried automatically.
- A provider with a visible usage-limit message or missing input is skipped.
- The page shows partial text and the conversation URL if capture fails after
  sending, and marks incomplete downloads accordingly.
- The local API checks `Host`, `Origin`, and a random token generated at server
  startup. Browser navigation accepts only hardcoded provider URLs. Prompt,
  attachment, and response data remain in process memory until cleared or the
  server stops. The upload limit is 10 MB.
- **Prepare only** fills one provider without sending. It accepts one site
  because the approved tab is shared.

## Verified evidence

- ChatGPT accepted a prompt and Markdown attachment in the regular signed-in
  Chrome profile and returned `WEB_TEST_OK`.
- That proves submission and one visible reply. It does not prove dependable
  response extraction, generated-file download, or the other providers.

## Capability matrix

| Capability | ChatGPT | Gemini | DeepSeek | Kimi | Claude |
| --- | --- | --- | --- | --- | --- |
| Prompt and Markdown attachment reaches site | Observed | Unverified | Unverified | Unverified | Unverified |
| Complete response captured by local app | Unverified | Unverified | Unverified | Unverified | Unverified |
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
   one attachment, upload completion, exactly one Send, new reply, completion,
   response extraction, and failure states. Record evidence before marking a
   capability verified.
4. Improve upload readiness and supported-file reporting per provider. Add
   multiple files only after single-file behavior is dependable.
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

## Deliberate design choice

Two reviews recommend one tab per provider. The extension currently grants
the project one selected tab, and the user reported that the other tabs were
inaccessible. The shared approved-tab design remains until multi-tab approval
is demonstrated in the user's browser. It keeps submissions sequential and
avoids relying on inaccessible tabs.
