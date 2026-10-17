import Anthropic from '@anthropic-ai/sdk';

// Each provider takes { model, system, prompt } and returns the reply text.
// Keys come only from environment variables (your local .env file).

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic (Claude)',
    defaultModel: 'claude-opus-5-5',
    keyEnv: 'ANTHROPIC_API_KEY',
    configured: (env) => Boolean(env.ANTHROPIC_API_KEY),
  },
  openai: {
    label: 'OpenAI-compatible',
    defaultModel: 'gpt-5',
    keyEnv: 'OPENAI_API_KEY',
    // Point OPENAI_BASE_URL at any OpenAI-compatible API: OpenRouter, Groq,
    // Together, a local Ollama (http://localhost:11434/v1)...
    configured: (env) => Boolean(env.OPENAI_API_KEY || env.OPENAI_BASE_URL),
  },
  demo: {
    label: 'Demo (no key needed)',
    defaultModel: 'demo',
    keyEnv: null,
    configured: () => true,
  },
};

export function providerStatus(env = process.env) {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    defaultModel: p.defaultModel,
    keyEnv: p.keyEnv,
    configured: p.configured(env),
  }));
}

export async function complete({ provider, model, system, prompt }, { env = process.env, fetch = globalThis.fetch, anthropic } = {}) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown provider "${provider}"`);
  if (!p.configured(env)) throw new Error(`${p.label} isn't set up: add ${p.keyEnv} to your .env file`);
  const useModel = model || p.defaultModel;

  if (provider === 'demo') return demoReply(system, prompt);

  if (provider === 'anthropic') {
    const client = anthropic ?? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const res = await client.beta.messages.create({
      model: useModel,
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content: prompt }],
      // If a safety check declines the request, let the API retry it on its
      // recommended fallback model instead of failing the task.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    if (res.stop_reason === 'refusal') throw new Error('The model declined this task');
    return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  }

  // OpenAI-compatible chat completions
  const base = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.OPENAI_API_KEY ? { Authorization: `Bearer ${env.OPENAI_API_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: useModel,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`${p.label} returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return String(data.choices?.[0]?.message?.content ?? '').trim();
}

// A canned reply so the office can be tried before any key is added.
function demoReply(system, prompt) {
  const role = system.match(/^You are (.+?)\./)?.[1] ?? 'an agent';
  return `[demo reply from ${role}]\n\nI'd start on "${prompt.split('\n')[0].slice(0, 80)}" like this:\n1. Clarify the goal and audience\n2. Draft the work\n3. Review it and hand it back\n\nAdd an API key in .env and pick a real provider to get real answers.`;
}
