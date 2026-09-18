import './register-typescript.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { review } from './fixtures/review.mjs';
const { requestReviewWithRetry } = await import('../app/lib/review-client.ts');
const input = { problem: { title: '나무높이' }, code: 'class Main {}' };
const flush = () => new Promise((resolve) => setImmediate(resolve));
function setup(t, responses) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: new Date('2026-09-08T00:00:00Z') });
  t.mock.method(Math, 'random', () => 0);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (...args) => {
    const response = responses[Math.min(calls++, responses.length - 1)];
    return typeof response === 'function' ? response(...args) : response.clone();
  });
  return () => calls;
}
test('automatically recovers after a 502 with a bounded delay', async (t) => {
  const calls = setup(t, [new Response('Bad Gateway', { status: 502 }), Response.json({ review })]);
  const notices = [];
  const pending = requestReviewWithRetry(input, { onRetry: (notice) => notices.push(notice) });
  await flush();
  assert.equal(calls(), 1);
  assert.equal(notices.at(-1).attempt, 2);
  t.mock.timers.tick(1999);
  await flush();
  assert.equal(calls(), 1);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, review);
  assert.equal(calls(), 2);
});
test('honors a 429 Retry-After before sending another request', async (t) => {
  const calls = setup(t, [new Response('', { status: 429, headers: { 'Retry-After': '5' } }), Response.json({ review })]);
  const pending = requestReviewWithRetry(input);
  await flush();
  t.mock.timers.tick(4999);
  await flush();
  assert.equal(calls(), 1);
  t.mock.timers.tick(1);
  await pending;
  assert.equal(calls(), 2);
});
test('accepts HTTP-date cooldowns', async (t) => {
  const calls = setup(t, [new Response('', { status: 429, headers: { 'Retry-After': 'Tue, 08 Sep 2026 00:00:06 GMT' } }), Response.json({ review })]);
  const pending = requestReviewWithRetry(input);
  await flush();
  t.mock.timers.tick(5999);
  await flush();
  assert.equal(calls(), 1);
  t.mock.timers.tick(1);
  await pending;
  assert.equal(calls(), 2);
});
test('stops after three total requests on repeated gateway failures', async (t) => {
  const calls = setup(t, [new Response('', { status: 502 })]);
  const result = assert.rejects(requestReviewWithRetry(input), /자동 재시도/);
  await flush();
  t.mock.timers.tick(2000);
  await flush();
  t.mock.timers.tick(4000);
  await result;
  assert.equal(calls(), 3);
});
for (const status of [400, 401, 403]) {
  test(`does not retry a ${status}`, async (t) => {
    const calls = setup(t, [Response.json({ error: '요청 확인' }, { status })]);
    await assert.rejects(requestReviewWithRetry(input), /요청 확인/);
    assert.equal(calls(), 1);
  });
}
test('does not retry app rate limits', async (t) => {
  const calls = setup(t, [Response.json({ error: '앱 제한', retryable: false, retryAfterSeconds: 3600 }, { status: 429 })]);
  await assert.rejects(requestReviewWithRetry(input), (error) => error.retryAt > Date.now() && /앱 제한/.test(error.message));
  assert.equal(calls(), 1);
});
test('does not retry a non-retryable 503 configuration failure', async (t) => {
  const calls = setup(t, [Response.json({ error: '모델 설정 필요', retryable: false }, { status: 503 })]);
  await assert.rejects(requestReviewWithRetry(input), /모델 설정 필요/);
  assert.equal(calls(), 1);
});
test('stops with a cooldown when the server requires more than 30 seconds', async (t) => {
  const calls = setup(t, [new Response('', { status: 429, headers: { 'Retry-After': '120' } })]);
  await assert.rejects(requestReviewWithRetry(input), (error) => error.retryAt === Date.now() + 120_000);
  assert.equal(calls(), 1);
});
test('cancels a pending backoff without sending another request', async (t) => {
  const calls = setup(t, [new Response('', { status: 502 })]);
  const controller = new AbortController();
  const result = assert.rejects(requestReviewWithRetry(input, { signal: controller.signal }), { name: 'AbortError' });
  await flush();
  controller.abort();
  await result;
  t.mock.timers.tick(60_000);
  assert.equal(calls(), 1);
});
test('recovers from a network error', async (t) => {
  const calls = setup(t, [() => { throw new TypeError('fetch failed'); }, Response.json({ review })]);
  const pending = requestReviewWithRetry(input);
  await flush();
  t.mock.timers.tick(2000);
  await pending;
  assert.equal(calls(), 2);
});
test('times out an API request and can recover on the next attempt', async (t) => {
  let signal;
  const calls = setup(t, [(_url, init) => {
    signal = init.signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }, Response.json({ review })]);
  const pending = requestReviewWithRetry(input);
  await flush();
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(signal.aborted, true);
  t.mock.timers.tick(2000);
  await pending;
  assert.equal(calls(), 2);
});
test('aborts an in-flight request without retrying', async (t) => {
  let signal;
  const calls = setup(t, [(_url, init) => {
    signal = init.signal;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  }]);
  const controller = new AbortController();
  const result = assert.rejects(requestReviewWithRetry(input, { signal: controller.signal }), { name: 'AbortError' });
  await flush();
  controller.abort();
  await result;
  assert.equal(signal.aborted, true);
  t.mock.timers.tick(60_000);
  assert.equal(calls(), 1);
});
test('recovers from an invalid successful response instead of displaying it', async (t) => {
  const calls = setup(t, [Response.json({ review: {} }), Response.json({ review })]);
  const pending = requestReviewWithRetry(input);
  await flush();
  t.mock.timers.tick(2000);
  assert.deepEqual(await pending, review);
  assert.equal(calls(), 2);
});

test('retries an old review response without scores', async (t) => {
  const withoutScore = { ...review };
  delete withoutScore.score;
  const calls = setup(t, [Response.json({ review: withoutScore }), Response.json({ review })]);
  const pending = requestReviewWithRetry(input);
  await flush();
  t.mock.timers.tick(2000);
  assert.deepEqual(await pending, review);
  assert.equal(calls(), 2);
});
