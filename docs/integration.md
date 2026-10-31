# Pollinations integration

This page collects the evidence in one place: every request Stretch makes to
Pollinations, the exact code path, and a captured response.

## Code path

| Step | Where |
| --- | --- |
| Reader clicks a sentence | `src/content.src.js` → `chrome.runtime.sendMessage({ type: 'stretch:generate' })` |
| Service worker handles it | `src/background.js` → `handleGenerate()` |
| The HTTP call | `src/lib/pollinations.js` → `generate()` → `fetch('https://gen.pollinations.ai/v1/chat/completions')` |
| The reader's key | `src/lib/pollinations.js` → `startDeviceFlow()` / `pollDeviceFlow()` → `https://enter.pollinations.ai/api/device/*` |
| Result cached | `src/background.js`, keyed by `hash(model + level + sentence)` |

Direct links:

- <https://github.com/agapovpavel387-code/stretchtext-web/blob/main/src/lib/pollinations.js>
- <https://github.com/agapovpavel387-code/stretchtext-web/blob/main/src/background.js>
- <https://github.com/agapovpavel387-code/stretchtext-web/blob/main/src/config.js>

## The request

```bash
curl -X POST https://gen.pollinations.ai/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $SK_KEY" \
  -d '{
    "model": "openai/gpt-5.4-nano",
    "messages": [{"role": "user", "content": "Grow this sentence: The library opened in 1904."}],
    "temperature": 0.5,
    "max_tokens": 260
  }'
```

Response (trimmed):

```json
{
  "id": "pllns_98b0f503d00bf38531859c745d5d4a38",
  "object": "chat.completion",
  "model": "openai/gpt-5.4-nano",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "The library opened in 1904, in two rooms of the old town hall..."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 48, "completion_tokens": 71, "total_tokens": 119 }
}
```

The anonymous fallback (`src/config.js` → `allowAnonymous`) posts the same body to
`https://text.pollinations.ai/openai` with no `Authorization` header and no BYOP
key. It exists so the extension can be tested without Pollen and is off by
default.

## Captured live response

An actual call to the free endpoint, made with `curl`/PowerShell on 2026-10-31:

```json
{
  "id": "pllns_98b0f503d00bf38531859c745d5d4a38",
  "object": "chat.completion",
  "model": "gpt-oss",
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "The API key used for this request has reached its budget. Please raise the key budget, then try again."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0 },
  "user_tier": "anonymous"
}
```

The request succeeded at the HTTP level (`200 OK`) but the body is a notice, not
generated text. Stretch treats that as an error: `looksLikeProviderError()` in
`src/lib/pollinations.js` recognises credit/quota/budget/rate-limit notices and
`generate()` throws instead of returning them, so the notice is never inserted
into the page. Covered by `test/pollinations.test.js`.

## Verifying it in the browser

1. Load the extension unpacked (`chrome://extensions` → **Load unpacked**).
2. Open any article, click the Stretch icon → **Turn on for this site**.
3. Open DevTools → **Network**, filter by `pollinations`.
4. Click a sentence. A `POST` to `gen.pollinations.ai/v1/chat/completions` appears
   with the reader's `Authorization: Bearer sk_...` header and the sentence in the
   request body.

The key used in that header is the reader's own, issued by the BYOP device flow
and stored in `chrome.storage.local`; it is never in the repository.
