// Posts a short message to Slack or Discord when a task finishes.
// Set NOTIFY_WEBHOOK_URL in .env to an incoming-webhook URL to turn it on.
export function createNotifier({ env = process.env, fetch = globalThis.fetch, log = console } = {}) {
  const url = env.NOTIFY_WEBHOOK_URL?.trim();
  if (!url) return async () => {};
  const discord = /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\//.test(url);

  return async function notify(task, agent) {
    const who = agent ? `${agent.emoji ?? ''} ${agent.name} (${agent.role})`.trim() : 'An agent';
    const head = task.status === 'failed' ? `❌ ${who} couldn't finish "${task.title}": ${task.error}` : `✅ ${who} finished "${task.title}"`;
    const preview = task.status === 'done' && task.output ? `\n\n${task.output.slice(0, 1500)}${task.output.length > 1500 ? '…' : ''}` : '';
    const text = head + preview;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(discord ? { content: text.slice(0, 1990) } : { text }),
      });
      if (!res.ok) log.warn(`Notification webhook returned ${res.status}`);
    } catch (err) {
      // A broken webhook should never break the office.
      log.warn(`Notification webhook failed: ${err.message}`);
    }
  };
}
