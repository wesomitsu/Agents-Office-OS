import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_TEMPLATES } from './defaults.js';
import { providerStatus } from './providers.js';
import { createRunner } from './runner.js';
import { createStore } from './store.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC = join(root, 'public');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };

export function createApp({ store, runner, env = process.env }) {
  const company = { name: env.COMPANY_NAME ?? '', about: env.COMPANY_ABOUT ?? '' };

  const routes = [
    ['GET', /^\/api\/office$/, () => ({ company, providers: providerStatus(env), templates: AGENT_TEMPLATES, agents: store.agents(), stats: store.stats(), tasks: store.tasks() })],
    ['GET', /^\/api\/export$/, () => ({ app: 'agents-office-os', version: 1, agents: store.agents() })],
    ['POST', /^\/api\/import$/, (_, body) => ({ agents: store.importAgents(body.agents) })],
    ['POST', /^\/api\/agents$/, (_, body) => [201, store.addAgent(body)]],
    ['PATCH', /^\/api\/agents\/([\w-]+)$/, ([id], body) => store.updateAgent(id, body)],
    ['DELETE', /^\/api\/agents\/([\w-]+)$/, ([id]) => (store.removeAgent(id) ? { ok: true } : null)],
    ['POST', /^\/api\/tasks$/, (_, body) => [201, store.addTask(body)]],
    ['PATCH', /^\/api\/tasks\/([\w-]+)$/, ([id], body) => store.updateTask(id, body)],
    ['DELETE', /^\/api\/tasks\/([\w-]+)$/, ([id]) => (store.removeTask(id) ? { ok: true } : null)],
    [
      'POST',
      /^\/api\/tasks\/([\w-]+)\/run$/,
      ([id]) => {
        if (!store.task(id)) return null;
        runner.run(id).catch(() => {}); // runs in the background; the UI polls for the result
        return [202, store.task(id)];
      },
    ],
    [
      'POST',
      /^\/api\/tasks\/([\w-]+)\/handoff$/,
      ([id], body) => {
        const created = store.handoff(id, body);
        if (!created) return null;
        if (body.run) runner.run(created.id).catch(() => {});
        return [201, created];
      },
    ],
    [
      'POST',
      /^\/api\/tasks\/([\w-]+)\/reply$/,
      ([id], body) => {
        const t = store.task(id);
        if (!t) return null;
        if (!String(body.message ?? '').trim()) throw new Error('message is required');
        if (t.status !== 'done' || !t.thread?.length) throw new Error('you can reply once the task is done');
        runner.reply(id, body.message).catch(() => {});
        return [202, store.task(id)];
      },
    ],
  ];

  return async function handle(req, res) {
    if (env.OFFICE_PASSWORD && !authorized(req, env.OFFICE_PASSWORD)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Agents Office", charset="UTF-8"' });
      return res.end('Login required');
    }
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) {
        for (const [method, pattern, fn] of routes) {
          const m = url.pathname.match(pattern);
          if (!m || req.method !== method) continue;
          const body = ['POST', 'PATCH'].includes(method) ? await readJson(req) : {};
          let result = await fn(m.slice(1), body);
          let status = 200;
          if (Array.isArray(result)) [status, result] = result;
          if (result === null) return send(res, 404, { error: 'not found' });
          return send(res, status, result);
        }
        return send(res, 404, { error: 'not found' });
      }
      return serveStatic(url.pathname, res);
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
  };
}

// HTTP Basic auth: any username, the password must match OFFICE_PASSWORD.
function authorized(req, password) {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const given = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':');
  const a = Buffer.from(given);
  const b = Buffer.from(password);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('request too large');
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('invalid JSON');
  }
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function serveStatic(pathname, res) {
  const rel = normalize(pathname === '/' ? '/index.html' : pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'forbidden' });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': `${TYPES[extname(file)] ?? 'application/octet-stream'}; charset=utf-8` });
    res.end(data);
  } catch {
    send(res, 404, { error: 'not found' });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const store = createStore(process.env.OFFICE_DATA ?? join(root, 'data', 'office.json'));
  const runner = createRunner(store, { company: { name: process.env.COMPANY_NAME, about: process.env.COMPANY_ABOUT } });
  const port = Number(process.env.PORT ?? 3000);
  // Bind to localhost only: the office can spend your API credit, so it
  // shouldn't be reachable from your network unless you put auth in front.
  const host = process.env.HOST ?? '127.0.0.1';
  createServer(createApp({ store, runner })).listen(port, host, () => {
    console.log(`Agents Office OS is open at http://${host === '127.0.0.1' ? 'localhost' : host}:${port}`);
  });
}
