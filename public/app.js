import { renderMarkdown } from './markdown.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let office = { agents: [], tasks: [], providers: [], company: {} };
let editingAgent = null;
let lastJson = '';
let filter = '';

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

async function refresh() {
  const next = await api('GET', '/api/office');
  const json = JSON.stringify(next);
  if (json === lastJson) return; // nothing changed: don't redraw (keeps animations smooth)
  lastJson = json;
  office = next;
  render();
}

function render() {
  const { company, providers, agents, tasks } = office;
  $('#company').textContent = company.name ? `${company.name} · AI team` : 'Your AI team';
  $('#providers').innerHTML = providers
    .map((p) => `<span class="pill ${p.configured ? 'on' : 'off'}" title="${p.keyEnv ? (p.configured ? `${p.keyEnv} is set` : `Add ${p.keyEnv} to .env`) : 'Works without a key'}">${esc(p.label)}</span>`)
    .join('');

  const busy = new Set(tasks.filter((t) => t.status === 'working').map((t) => t.agentId));
  $('#desks').innerHTML =
    agents
      .map((a, i) => {
        const open = tasks.filter((t) => t.agentId === a.id && t.status !== 'done').length;
        const provider = providers.find((p) => p.id === a.provider);
        return `<article class="desk ${busy.has(a.id) ? 'working' : 'idle'}" data-agent="${esc(a.id)}" style="animation-delay:${i * 60}ms" tabindex="0" aria-label="${esc(a.name)}, ${esc(a.role)}">
          <span class="status" title="${busy.has(a.id) ? 'Working' : 'Available'}"></span>
          <div class="station">
            <div class="monitor"><div class="lines"><span></span><span></span><span></span></div></div>
            <div class="avatar">${esc(a.emoji || '🤖')}</div>
            <div class="table"></div>
            <div class="bubble"><b>•</b><b>•</b><b>•</b></div>
          </div>
          <h3>${esc(a.name)}</h3>
          <div class="role">${esc(a.role)}</div>
          <div class="meta"><span class="tag">${esc(provider?.label.split(' ')[0] ?? a.provider)}${a.model ? ` · ${esc(a.model)}` : ''}</span><span>${open} open</span></div>
        </article>`;
      })
      .join('') + `<button class="desk add" id="add-agent">+ Hire an agent</button>`;

  for (const col of document.querySelectorAll('.col')) {
    const list = tasks.filter((t) => t.status === col.dataset.status && (!filter || t.agentId === filter));
    $('.count', col).textContent = list.length || '';
    $('.list', col).innerHTML = list.length
      ? list.map(card).join('')
      : `<div class="empty">${{ todo: 'Nothing waiting', working: 'Everyone is free', done: 'No finished work yet', failed: 'All good' }[col.dataset.status]}</div>`;
  }

  const f = $('#filter');
  f.innerHTML = '<option value="">Everyone</option>' + agents.map((a) => `<option value="${esc(a.id)}">${esc(a.emoji)} ${esc(a.name)}</option>`).join('');
  if (!agents.some((a) => a.id === filter)) filter = '';
  f.value = filter;

  // Don't touch the form lists while someone is filling a form in.
  if (document.querySelector('dialog[open]')) return;
  $('#task-agent').innerHTML = agents.map((a) => `<option value="${esc(a.id)}">${esc(a.emoji)} ${esc(a.name)} · ${esc(a.role)}</option>`).join('');
  $('#agent-provider').innerHTML = providers.map((p) => `<option value="${esc(p.id)}">${esc(p.label)}${p.configured ? '' : ' (no key yet)'}</option>`).join('');
}

function card(t) {
  const a = office.agents.find((x) => x.id === t.agentId);
  const buttons = {
    todo: `<button class="btn small" data-run="${t.id}">▶ Start</button>`,
    working: `<span class="who">Working on it…</span>`,
    done: `<button class="btn small" data-view="${t.id}">View result</button><button class="btn small" data-run="${t.id}">↻ Redo</button>`,
    failed: `<button class="btn small" data-run="${t.id}">↻ Retry</button>`,
  }[t.status];
  return `<div class="card">
    <div class="who">${esc(a?.emoji ?? '❔')} ${esc(a?.name ?? 'Removed agent')}</div>
    <div class="title">${esc(t.title)}</div>
    ${t.error ? `<div class="err">${esc(t.error)}</div>` : ''}
    <div class="buttons">${buttons}${t.status !== 'working' ? `<button class="btn small" data-delete="${t.id}" title="Delete">✕</button>` : ''}</div>
  </div>`;
}

function openAgent(agent) {
  editingAgent = agent;
  const f = $('#agent-form');
  $('#agent-title').textContent = agent ? `${agent.name}'s desk` : 'Hire an agent';
  $('#agent-delete').hidden = !agent;
  $('#template-row').hidden = Boolean(agent);
  $('#agent-template').innerHTML =
    '<option value="">Blank agent</option>' +
    (office.templates ?? []).map((t, i) => `<option value="${i}">${esc(t.emoji)} ${esc(t.role)}</option>`).join('');
  const values = agent ?? { emoji: '🤖', name: '', role: '', provider: 'demo', model: '', instructions: '' };
  for (const k of ['emoji', 'name', 'role', 'provider', 'model', 'instructions']) f.elements[k].value = values[k] ?? '';
  $('#agent-dialog').showModal();
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-run],[data-view],[data-delete],[data-agent],#add-agent,#new-task');
  if (!t) return;
  try {
    if (t.id === 'new-task') return $('#task-dialog').showModal();
    if (t.id === 'add-agent') return openAgent(null);
    if (t.dataset.agent) return openAgent(office.agents.find((a) => a.id === t.dataset.agent));
    if (t.dataset.run) await api('POST', `/api/tasks/${t.dataset.run}/run`);
    if (t.dataset.delete) await api('DELETE', `/api/tasks/${t.dataset.delete}`);
    if (t.dataset.view) {
      const task = office.tasks.find((x) => x.id === t.dataset.view);
      $('#output-title').textContent = task.title;
      $('#output-body').innerHTML = renderMarkdown(task.output);
      $('#output-body').dataset.raw = task.output;
      $('#output-body').dataset.title = task.title;
      return $('#output-dialog').showModal();
    }
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.dataset?.agent) openAgent(office.agents.find((a) => a.id === e.target.dataset.agent));
});

$('#task-dialog').addEventListener('close', async () => {
  const d = $('#task-dialog');
  const f = $('#task-form');
  if (d.returnValue === 'ok') {
    try {
      const task = await api('POST', '/api/tasks', { title: f.elements.title.value, details: f.elements.details.value, agentId: f.elements.agentId.value });
      if (f.elements.run.checked) await api('POST', `/api/tasks/${task.id}/run`);
      f.reset();
      await refresh();
    } catch (err) {
      alert(err.message);
    }
  }
});

$('#agent-dialog').addEventListener('close', async () => {
  const d = $('#agent-dialog');
  const f = $('#agent-form');
  const body = Object.fromEntries(['emoji', 'name', 'role', 'provider', 'model', 'instructions'].map((k) => [k, f.elements[k].value]));
  try {
    if (d.returnValue === 'ok') await (editingAgent ? api('PATCH', `/api/agents/${editingAgent.id}`, body) : api('POST', '/api/agents', body));
    if (d.returnValue === 'delete' && confirm(`Remove ${editingAgent.name} from the office?`)) await api('DELETE', `/api/agents/${editingAgent.id}`);
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

$('#filter').addEventListener('change', (e) => {
  filter = e.target.value;
  render();
});

$('#agent-template').addEventListener('change', (e) => {
  const t = office.templates?.[e.target.value];
  const f = $('#agent-form');
  for (const k of ['emoji', 'name', 'role', 'instructions']) f.elements[k].value = t ? t[k] : k === 'emoji' ? '🤖' : '';
});

$('#download-output').addEventListener('click', () => {
  const body = $('#output-body');
  const name = (body.dataset.title || 'result').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'result';
  const url = URL.createObjectURL(new Blob([`# ${body.dataset.title}\n\n${body.dataset.raw}\n`], { type: 'text/markdown' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${name}.md` });
  a.click();
  URL.revokeObjectURL(url);
});

$('#copy-output').addEventListener('click', () => navigator.clipboard?.writeText($('#output-body').dataset.raw ?? ''));

const tick = () => ($('#clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
tick();
setInterval(tick, 10_000);
// Poll so finished work shows up without a reload.
setInterval(() => refresh().catch(() => {}), 2000);
refresh().catch((err) => ($('#desks').textContent = `Can't reach the office server: ${err.message}`));
