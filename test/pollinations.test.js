import test from 'node:test';
import assert from 'node:assert/strict';
import { PollinationsError, generate, looksLikeProviderError } from '../src/lib/pollinations.js';

const originalFetch = globalThis.fetch;

function mockFetch(body, status = 200, headers = {}) {
  globalThis.fetch = async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
}

function completion(text) {
  return { choices: [{ message: { role: 'assistant', content: text } }], usage: { total_tokens: 42 } };
}

const request = {
  token: 'sk_test_this_is_a_fake_key',
  model: 'openai/gpt-5.4-nano',
  messages: [{ role: 'user', content: 'grow this sentence' }],
};

test.after(() => {
  globalThis.fetch = originalFetch;
});

test('a normal answer comes back as text', async () => {
  mockFetch(completion('The library grew in stages, adding rooms as the town filled in.'));
  const result = await generate(request);
  assert.match(result.text, /library grew/);
  assert.equal(result.usage.total_tokens, 42);
});

test('an out-of-credits message returned with 200 is rejected, not shown', async () => {
  mockFetch(
    completion(
      "The account behind this API key doesn't have enough credits. Please [top up](https://enter.pollinations.ai/top-up) or complete a quest, then try again.",
    ),
  );
  await assert.rejects(generate(request), (error) => {
    assert.ok(error instanceof PollinationsError);
    assert.equal(error.code, 'no_pollen');
    assert.match(error.message, /Out of Pollen/);
    return true;
  });
});

test('HTTP error statuses map to readable codes', async () => {
  for (const [status, code] of [
    [401, 'auth_required'],
    [402, 'no_pollen'],
    [429, 'rate_limited'],
    [403, 'forbidden'],
  ]) {
    mockFetch({ error: { message: 'nope' } }, status);
    await assert.rejects(generate(request), (error) => error.code === code, `status ${status}`);
  }
});

test('a JSON error body with 200 is rejected', async () => {
  mockFetch({ error: 'insufficient_quota' });
  await assert.rejects(generate(request), (error) => error.code === 'no_pollen');
});

test('provider error detection is strict enough for prose', () => {
  assert.equal(looksLikeProviderError('This key is out of credits.'), true);
  assert.equal(looksLikeProviderError('see enter.pollinations.ai/quests'), true);
  assert.equal(looksLikeProviderError('The librarian kept a ledger of every loan.'), false);
  assert.equal(looksLikeProviderError(''), false);
});
