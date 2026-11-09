import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier } from '../src/notify.js';

const agent = { name: 'Sky', role: 'Social Media', emoji: '📣' };
const capture = () => {
  const calls = [];
  return { calls, fetch: async (url, init) => (calls.push({ url, body: JSON.parse(init.body) }), { ok: true }) };
};

test('does nothing without a webhook URL', async () => {
  const { calls, fetch } = capture();
  await createNotifier({ env: {}, fetch })({ status: 'done', title: 't', output: 'x' }, agent);
  assert.equal(calls.length, 0);
});

test('sends Slack-style text with a preview', async () => {
  const { calls, fetch } = capture();
  await createNotifier({ env: { NOTIFY_WEBHOOK_URL: 'https://hooks.slack.com/services/T/B/X' }, fetch })(
    { status: 'done', title: 'Launch post', output: 'Hello world' },
    agent,
  );
  assert.equal(calls[0].body.text, '✅ 📣 Sky (Social Media) finished "Launch post"\n\nHello world');
});

test('uses Discord content and reports failures', async () => {
  const { calls, fetch } = capture();
  await createNotifier({ env: { NOTIFY_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc' }, fetch })(
    { status: 'failed', title: 'Fix bug', error: 'rate limited' },
    agent,
  );
  assert.equal(calls[0].body.content, '❌ 📣 Sky (Social Media) couldn\'t finish "Fix bug": rate limited');
});

test('a failing webhook never throws', async () => {
  const warnings = [];
  const notify = createNotifier({
    env: { NOTIFY_WEBHOOK_URL: 'https://hooks.slack.com/x' },
    fetch: async () => { throw new Error('offline'); },
    log: { warn: (m) => warnings.push(m) },
  });
  await notify({ status: 'done', title: 't', output: '' }, agent);
  assert.match(warnings[0], /offline/);
});
