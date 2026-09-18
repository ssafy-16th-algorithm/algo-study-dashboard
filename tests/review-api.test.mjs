import './register-typescript.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { review } from './fixtures/review.mjs';
const { POST } = await import('../app/api/review/route.ts');
let client = 0;
function setup(t, respond, { groq = true, ollama = true, openai = false, openaiBaseUrl = '', openaiModel = '' } = {}) {
  for (const [name, value] of Object.entries({ OPEN_AI_API_KEY: openai ? 'test-openai' : '', OPEN_AI_BASE_URL: openaiBaseUrl, OPEN_AI_REVIEW_MODEL: openaiModel, OLLAMA_API_KEY: ollama ? 'test' : '', OLLAMA_REVIEW_MODEL: ollama ? 'test-ollama' : '', LLM_API_KEY: groq ? 'test' : '', LLM_REVIEW_MODEL: groq ? 'test-groq' : '' })) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  t.mock.method(globalThis, 'fetch', respond);
}
function request(ip = `review-test-${++client}`) {
  return new Request('http://localhost/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify({ problem: { title: '테스트' }, code: 'class Main {}' }) });
}

test('uses GPT first with OpenAI-compatible parameters', async (t) => {
  const calls = [];
  setup(t, async (url, init) => {
    calls.push(url);
    const body = JSON.parse(init.body);
    assert.equal(init.headers.Authorization, 'Bearer test-openai');
    assert.equal(body.model, 'gpt-5.4-mini');
    assert.equal(body.response_format.type, 'json_object');
    assert.equal(body.citation_options, undefined);
    assert.equal(body.tool_choice, undefined);
    return Response.json({ choices: [{ message: { content: JSON.stringify(review) } }] });
  }, { openai: true });
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Review-Provider'), 'openai');
  assert.deepEqual(calls, ['https://gms.ssafy.io/gmsapi/api.openai.com/v1/chat/completions']);
});

test('supports GPT alone with a custom endpoint and model', async (t) => {
  let actualUrl;
  let actualModel;
  setup(t, async (url, init) => {
    actualUrl = url;
    actualModel = JSON.parse(init.body).model;
    return Response.json({ choices: [{ message: { content: JSON.stringify(review) } }] });
  }, { openai: true, ollama: false, groq: false, openaiBaseUrl: 'https://gateway.example/v1/', openaiModel: 'gpt-custom' });
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.equal(actualUrl, 'https://gateway.example/v1/chat/completions');
  assert.equal(actualModel, 'gpt-custom');
});

test('falls back in GPT, Ollama, Groq order', async (t) => {
  const calls = [];
  setup(t, async (url) => {
    calls.push(url);
    return calls.length < 3 ? new Response('', { status: 503 })
      : Response.json({ choices: [{ message: { content: JSON.stringify(review) } }] });
  }, { openai: true });
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Review-Provider'), 'groq');
  assert.deepEqual(calls.map((url) => new URL(url).hostname), ['gms.ssafy.io', 'ollama.com', 'api.groq.com']);
});

test('falls back after 429 and exposes the successful provider', async (t) => {
  setup(t, async (url) => String(url).includes('ollama.com')
    ? new Response('', { status: 429, headers: { 'Retry-After': '20' } })
    : Response.json({ choices: [{ message: { content: JSON.stringify(review) } }] }));
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Review-Provider'), 'groq');
  assert.equal((await response.json()).review.verdict, '✅ 정상');
});

test('returns the longest provider cooldown so a retry cannot call either provider too soon', async (t) => {
  setup(t, async (url) => new Response('', { status: 429, headers: { 'Retry-After': String(url).includes('ollama.com') ? '20' : '5' } }));
  const response = await POST(request());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '20');
  const body = await response.json();
  assert.equal(body.retryable, true);
  assert.equal(body.retryAfterSeconds, 20);
});

test('recovers from a malformed HTTP body through the next provider', async (t) => {
  setup(t, async (url) => String(url).includes('ollama.com')
    ? new Response('<html>gateway error</html>')
    : Response.json({ choices: [{ message: { content: JSON.stringify(review) } }] }));
  const response = await POST(request());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Review-Provider'), 'groq');
});

test('does not convert an empty model object into a successful review', async (t) => {
  setup(t, async () => Response.json({ message: { content: '{}' } }), { groq: false });
  const response = await POST(request());
  assert.equal(response.status, 502);
  assert.equal((await response.json()).retryable, true);
});

test('marks authentication failures as non-retryable', async (t) => {
  setup(t, async () => new Response('', { status: 401 }));
  const response = await POST(request());
  assert.equal((await response.json()).retryable, false);
});

test('marks gateway failures as retryable', async (t) => {
  setup(t, async () => new Response('', { status: 502 }));
  const response = await POST(request());
  assert.equal(response.status, 502);
  assert.equal((await response.json()).retryable, true);
});

test('stops a stalled provider after 15 seconds and falls back', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let entered;
  const started = new Promise((resolve) => { entered = resolve; });
  let providerSignal;
  setup(t, async (url, init) => {
    if (!String(url).includes('ollama.com')) return Response.json({ choices: [{ message: { content: JSON.stringify(review) } }] });
    providerSignal = init.signal;
    entered();
    return new Promise((resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  });
  const pending = POST(request());
  await started;
  assert.ok(providerSignal, 'provider fetch must have a timeout signal');
  t.mock.timers.tick(15_000);
  const response = await pending;
  assert.equal(providerSignal.aborted, true);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Review-Provider'), 'groq');
});

test('app rate limit supplies a cooldown and stops automatic retries', async (t) => {
  setup(t, async () => Response.json({ message: { content: JSON.stringify(review) } }));
  const ip = `rate-limit-${++client}`;
  for (let index = 0; index < 20; index++) await POST(request(ip));
  const response = await POST(request(ip));
  assert.equal(response.status, 429);
  const body = await response.json();
  assert.equal(body.code, 'APP_RATE_LIMIT');
  assert.equal(body.retryable, false);
  assert.ok(Number(response.headers.get('Retry-After')) > 3500);
});
test('canceling a provider request does not start the fallback', async (t) => {
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  let calls = 0;
  setup(t, async (_url, init) => {
    calls++;
    started();
    return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
  });
  const controller = new AbortController();
  const pending = POST(new Request(request(), { signal: controller.signal }));
  await entered;
  controller.abort();
  const response = await pending;
  assert.equal(response.status, 499);
  assert.equal((await response.json()).retryable, false);
  assert.equal(calls, 1);
});
test('provider timeout includes reading the response body', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  setup(t, async (url, init) => {
    if (!String(url).includes('ollama.com')) return Response.json({ choices: [{ message: { content: JSON.stringify(review) } }] });
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
        init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
        started();
      },
    }));
  });
  const pending = POST(request());
  await entered;
  t.mock.timers.tick(15_000);
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Review-Provider'), 'groq');
});

test('calculates total and grade from category points rather than trusting the model total', async (t) => {
  const scored = structuredClone(review);
  scored.score.total = 100;
  scored.score.grade = 'S';
  setup(t, async () => Response.json({ message: { content: JSON.stringify(scored) } }));
  const response = await POST(request());
  assert.equal(response.status, 200);
  const actual = (await response.json()).review.score;
  assert.equal(actual?.total, 85);
  assert.equal(actual.grade, 'A');
  assert.deepEqual(actual.criteria, review.score.criteria);
});

for (const invalid of [undefined, null, '40', 41, -1, 1.5]) {
  test(`rejects invalid correctness points (${String(invalid)}) and uses the fallback`, async (t) => {
    const invalidReview = structuredClone(review);
    invalidReview.score.criteria.correctness.points = invalid;
    setup(t, async (url) => String(url).includes('ollama.com')
      ? Response.json({ message: { content: JSON.stringify(invalidReview) } })
      : Response.json({ choices: [{ message: { content: JSON.stringify(review) } }] }));
    const response = await POST(request());
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Review-Provider'), 'groq');
    assert.equal((await response.json()).review.score.total, 85);
  });
}

test('does not invent a score when the model omits it', async (t) => {
  const withoutScore = { ...review };
  delete withoutScore.score;
  setup(t, async () => Response.json({ message: { content: JSON.stringify(withoutScore) } }), { groq: false });
  const response = await POST(request());
  assert.equal(response.status, 502);
  assert.equal((await response.json()).retryable, true);
});

test('requires an explanation for every score category', async (t) => {
  const invalidReview = structuredClone(review);
  invalidReview.score.criteria.efficiency.reason = ' ';
  setup(t, async () => Response.json({ message: { content: JSON.stringify(invalidReview) } }), { groq: false });
  assert.equal((await POST(request())).status, 502);
});
