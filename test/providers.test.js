import { test } from 'node:test';
import assert from 'node:assert/strict';
import { complete, providerStatus } from '../src/providers.js';

const ask = { system: 'You are Sky, the Social Media agent.', prompt: 'Write a launch post' };

test('reports which providers are configured, without exposing keys', () => {
  const status = providerStatus({ ANTHROPIC_API_KEY: 'k' });
  assert.deepEqual(status.map((s) => [s.id, s.configured]), [['anthropic', true], ['openai', false], ['demo', true]]);
  assert.ok(!JSON.stringify(status).includes('"k"'));
});

test('demo provider answers without a key', async () => {
  const { text } = await complete({ provider: 'demo', ...ask }, { env: { DEMO_DELAY_MS: '0' } });
  assert.match(text, /demo reply from Sky, the Social Media agent/);
});

test('refuses to call a provider that has no key', async () => {
  await assert.rejects(complete({ provider: 'anthropic', ...ask }, { env: {} }), /add ANTHROPIC_API_KEY/);
  await assert.rejects(complete({ provider: 'nope', ...ask }, { env: {} }), /Unknown provider/);
});

test('anthropic: sends system + prompt with fallbacks and joins text blocks', async () => {
  let sent;
  const anthropic = {
    beta: {
      messages: {
        create: async (body) => {
          sent = body;
          return { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Hello' }], usage: { input_tokens: 12, output_tokens: 34 } };
        },
      },
    },
  };
  const { text, usage } = await complete({ provider: 'anthropic', model: '', ...ask }, { env: { ANTHROPIC_API_KEY: 'k' }, anthropic });
  assert.equal(text, 'Hello');
  assert.deepEqual(usage, { input: 12, output: 34 });
  assert.equal(sent.model, 'claude-opus-5-5');
  assert.equal(sent.system, ask.system);
  assert.equal(sent.fallbacks, 'default');
});

test('anthropic: a refusal fails the task', async () => {
  const anthropic = { beta: { messages: { create: async () => ({ stop_reason: 'refusal', content: [] }) } } };
  await assert.rejects(complete({ provider: 'anthropic', ...ask }, { env: { ANTHROPIC_API_KEY: 'k' }, anthropic }), /declined/);
});

test('openai-compatible: uses the base URL and bearer key', async () => {
  let url, init;
  const fetch = async (u, i) => {
    url = u;
    init = i;
    return { ok: true, json: async () => ({ choices: [{ message: { content: ' Hi there ' } }], usage: { prompt_tokens: 5, completion_tokens: 7 } }) };
  };
  const env = { OPENAI_API_KEY: 'sk-test', OPENAI_BASE_URL: 'https://openrouter.ai/api/v1/' };
  const { text, usage } = await complete({ provider: 'openai', model: 'some/model', ...ask }, { env, fetch });
  assert.equal(text, 'Hi there');
  assert.deepEqual(usage, { input: 5, output: 7 });
  assert.equal(url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(init.headers.Authorization, 'Bearer sk-test');
  assert.equal(JSON.parse(init.body).messages[0].role, 'system');
});

test('openai-compatible: surfaces API errors', async () => {
  const fetch = async () => ({ ok: false, status: 401, text: async () => 'bad key' });
  await assert.rejects(complete({ provider: 'openai', ...ask }, { env: { OPENAI_API_KEY: 'x' }, fetch }), /returned 401: bad key/);
});

test('passes earlier turns to both providers', async () => {
  const history = [{ role: 'user', content: 'Q1' }, { role: 'assistant', content: 'A1' }];
  let sent;
  const anthropic = { beta: { messages: { create: async (b) => ((sent = b), { stop_reason: 'end_turn', content: [] }) } } };
  await complete({ provider: 'anthropic', ...ask, history }, { env: { ANTHROPIC_API_KEY: 'k' }, anthropic });
  assert.deepEqual(sent.messages.map((m) => m.content), ['Q1', 'A1', ask.prompt]);
  let body;
  const fetch = async (_, i) => ((body = JSON.parse(i.body)), { ok: true, json: async () => ({ choices: [] }) });
  await complete({ provider: 'openai', ...ask, history }, { env: { OPENAI_API_KEY: 'x' }, fetch });
  assert.deepEqual(body.messages.map((m) => m.role), ['system', 'user', 'assistant', 'user']);
});
