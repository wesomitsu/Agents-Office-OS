import { renderMarkdown } from './markdown.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let office = { agents: [], tasks: [], providers: [], company: {} };
let editingAgent = null;
let lastJson = '';
let filter = '';
let search = '';
const matches = (t) => !search || `${t.title}\n${t.details}\n${t.output}`.toLowerCase().includes(search);

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
  announceChanges(office.tasks, next.tasks);
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
        const open = tasks.filter((t) => t.agentId === a.id && (t.status === 'todo' || t.status === 'working')).length;
        const st = office.stats?.[a.id];
        const spent = st?.cost !== null && st?.cost !== undefined ? ` · ~$${st.cost > 0 && st.cost < 0.01 ? '<0.01' : st.cost.toFixed(2)}` : '';
        const record = st?.done ? `${st.done} done${st.avgSeconds !== null ? ` · ~${st.avgSeconds < 60 ? `${Math.round(st.avgSeconds)}s` : `${Math.round(st.avgSeconds / 60)}m`}` : ''}${spent}` : 'No tasks yet';
        const provider = providers.find((p) => p.id === a.provider);
        return `<article class="desk ${busy.has(a.id) ? 'working' : a.offDuty === 'true' ? 'off' : 'idle'}" data-agent="${esc(a.id)}" style="animation-delay:${i * 60}ms" tabindex="0" aria-label="${esc(a.name)}, ${esc(a.role)}">
          <span class="status" title="${busy.has(a.id) ? 'Working' : 'Available'}"></span>
          <div class="station">
            <div class="monitor"><div class="lines"><span></span><span></span><span></span></div></div>
            <div class="avatar">${esc(a.emoji || '🤖')}</div>
            <div class="table"></div>
            <div class="bubble"><b>•</b><b>•</b><b>•</b></div>
          </div>
          <h3>${esc(a.name)}</h3>
          <div class="role">${esc(a.role)}${a.offDuty === 'true' ? ' · 😴 Off duty' : ''}</div>
          <div class="record">${esc(record)}</div>
          <div class="meta"><span class="tag">${esc(provider?.label.split(' ')[0] ?? a.provider)}${a.model ? ` · ${esc(a.model)}` : ''}</span><span>${open} open</span></div>
        </article>`;
      })
      .join('') + `<button class="desk add" id="add-agent">+ Hire an agent</button>`;

  for (const col of document.querySelectorAll('.col')) {
    const list = tasks
      .filter((t) => t.status === col.dataset.status && (!filter || t.agentId === filter) && matches(t))
      .sort((a, b) => (RANK[a.priority] ?? 1) - (RANK[b.priority] ?? 1) || (a.due || '9999').localeCompare(b.due || '9999'));
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

// Tells screen-reader users when a task finishes or fails, since the board
// updates on its own without a page reload.
function announceChanges(before, after) {
  if (!before.length) return;
  const old = new Map(before.map((t) => [t.id, t.status]));
  const notes = [];
  for (const t of after) {
    const was = old.get(t.id);
    if (was === 'working' && t.status === 'done') notes.push(`${agentName(t.agentId)} finished "${t.title}".`);
    if (was === 'working' && t.status === 'failed') notes.push(`${agentName(t.agentId)} couldn't finish "${t.title}".`);
  }
  if (notes.length) $('#announcer').textContent = notes.join(' ');
}
const agentName = (id) => office.agents.find((a) => a.id === id)?.name ?? 'An agent';

const RANK = { high: 0, normal: 1, low: 2 };
const today = () => new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
function dueLabel(t) {
  if (!t.due) return '';
  const open = t.status === 'todo' || t.status === 'working';
  const late = open && t.due < today();
  const when = t.due === today() ? 'today' : new Date(`${t.due}T00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `<div class="due${late ? ' late' : ''}">${late ? 'Overdue · ' : 'Due '}${esc(when)}</div>`;
}
const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function card(t) {
  const a = office.agents.find((x) => x.id === t.agentId);
  const buttons = {
    todo: `<button class="btn small" data-run="${t.id}">▶ Start</button>`,
    working: `<span class="who">Working on it…</span>`,
    done: `<button class="btn small" data-view="${t.id}">View result</button><button class="btn small" data-run="${t.id}">↻ Redo</button>`,
    failed: `<button class="btn small" data-run="${t.id}">↻ Retry</button>`,
  }[t.status];
  return `<div class="card">
    <div class="who">${esc(a?.emoji ?? '❔')} ${esc(a?.name ?? 'Removed agent')}${t.priority === 'high' ? ' <span class="prio high">High</span>' : t.priority === 'low' ? ' <span class="prio low">Low</span>' : ''}</div>
    <div class="title">${esc(t.title)}</div>
    ${dueLabel(t)}${t.repeat ? `<div class="due">↻ Repeats ${esc(t.repeat)}</div>` : ''}
    ${t.usage && t.usage.input + t.usage.output ? `<div class="tokens">${fmtTokens(t.usage.input + t.usage.output)} tokens</div>` : ''}
    ${t.error ? `<div class="err">${esc(t.error)}</div>` : ''}
    <div class="buttons">${buttons}<button class="btn small" data-dup="${t.id}" title="Make a copy to edit">⧉</button>${t.status !== 'working' ? `<button class="btn small" data-delete="${t.id}" title="Delete">✕</button>` : ''}</div>
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
  const values = agent ?? { emoji: '🤖', name: '', role: '', provider: 'demo', model: '', instructions: '', priceIn: '', priceOut: '' };
  for (const k of ['emoji', 'name', 'role', 'provider', 'model', 'instructions', 'priceIn', 'priceOut']) f.elements[k].value = values[k] ?? '';
  f.elements.offDuty.checked = values.offDuty === 'true';
  $('#agent-dialog').showModal();
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-run],[data-view],[data-delete],[data-dup],[data-agent],#add-agent,#new-task');
  if (!t) return;
  try {
    if (t.id === 'new-task') return $('#task-dialog').showModal();
    if (t.id === 'add-agent') return openAgent(null);
    if (t.dataset.dup) {
      // Opens the new-task form pre-filled from this task, so it can be tweaked first.
      const src = office.tasks.find((x) => x.id === t.dataset.dup);
      const f = $('#task-form');
      f.elements.title.value = src.title;
      f.elements.details.value = src.details;
      f.elements.priority.value = src.priority || 'normal';
      f.elements.due.value = '';
      f.elements.repeat.value = '';
      $('#task-dialog').showModal();
      f.elements.agentId.value = src.agentId;
      return;
    }
    if (t.dataset.agent) return openAgent(office.agents.find((a) => a.id === t.dataset.agent));
    if (t.dataset.run) await api('POST', `/api/tasks/${t.dataset.run}/run`);
    if (t.dataset.delete) await api('DELETE', `/api/tasks/${t.dataset.delete}`);
    if (t.dataset.view) {
      const task = office.tasks.find((x) => x.id === t.dataset.view);
      $('#output-title').textContent = task.title;
      const turns = task.thread?.length > 2 ? task.thread.slice(1) : [{ role: 'assistant', content: task.output }];
      $('#output-body').innerHTML = turns
        .map((m) => (m.role === 'user' ? `<div class="you">You: ${esc(m.content)}</div>` : renderMarkdown(m.content)))
        .join('<hr>');
      $('#output-body').dataset.id = task.id;
      $('#reply-text').value = '';
      $('#handoff-note').value = '';
      $('#handoff-agent').innerHTML = office.agents
        .filter((a) => a.id !== task.agentId)
        .map((a) => `<option value="${esc(a.id)}">${esc(a.emoji)} ${esc(a.name)} · ${esc(a.role)}</option>`)
        .join('');
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
  if (e.key === 'Enter' && e.target.dataset?.agent) return openAgent(office.agents.find((a) => a.id === e.target.dataset.agent));
  // Single-key shortcuts, ignored while typing or when a dialog is open.
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  if (typing || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return;
  if (e.key === 'n') {
    e.preventDefault();
    $('#task-dialog').showModal();
  } else if (e.key === 'h') {
    e.preventDefault();
    openAgent(null);
  } else if (e.key === '/') {
    e.preventDefault();
    $('#search').focus();
  } else if (e.key === 'f') {
    e.preventDefault();
    $('#filter').focus();
  } else if (/^[1-9]$/.test(e.key) && office.agents[Number(e.key) - 1]) {
    // 1-9: show only that agent's tasks (press 0 for everyone)
    filter = office.agents[Number(e.key) - 1].id;
    render();
  } else if (e.key === '0') {
    filter = '';
    render();
  } else if (e.key === '?') {
    $('#keys').hidden = !$('#keys').hidden;
  }
});

$('#task-dialog').addEventListener('close', async () => {
  const d = $('#task-dialog');
  const f = $('#task-form');
  if (d.returnValue === 'ok') {
    try {
      const task = await api('POST', '/api/tasks', { title: f.elements.title.value, details: f.elements.details.value, agentId: f.elements.agentId.value, priority: f.elements.priority.value, due: f.elements.due.value, repeat: f.elements.repeat.value });
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
  const body = Object.fromEntries(['emoji', 'name', 'role', 'provider', 'model', 'instructions', 'priceIn', 'priceOut'].map((k) => [k, f.elements[k].value]));
  body.offDuty = f.elements.offDuty.checked ? 'true' : '';
  try {
    if (d.returnValue === 'ok') await (editingAgent ? api('PATCH', `/api/agents/${editingAgent.id}`, body) : api('POST', '/api/agents', body));
    if (d.returnValue === 'delete' && confirm(`Remove ${editingAgent.name} from the office?`)) await api('DELETE', `/api/agents/${editingAgent.id}`);
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

$('#export-team').addEventListener('click', async () => {
  const data = await api('GET', '/api/export');
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  Object.assign(document.createElement('a'), { href: url, download: 'agents-office-team.json' }).click();
  URL.revokeObjectURL(url);
});

$('#import-team').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!confirm(`Replace your current agents with the ${data.agents?.length ?? 0} in this file? Tasks are kept.`)) return;
    await api('POST', '/api/import', data);
    await refresh();
  } catch (err) {
    alert(`Couldn't import: ${err.message}`);
  }
});

$('#clear-done').addEventListener('click', async () => {
  const who = filter ? office.agents.find((a) => a.id === filter)?.name : null;
  const count = office.tasks.filter((t) => t.status === 'done' && (!filter || t.agentId === filter)).length;
  if (!count || !confirm(`Delete ${count} finished task${count === 1 ? '' : 's'}${who ? ` for ${who}` : ''}? Download anything you want to keep first.`)) return;
  try {
    await api('POST', '/api/tasks/clear-done', { agentId: filter });
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

$('#search').addEventListener('input', (e) => {
  search = e.target.value.trim().toLowerCase();
  render();
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

$('#handoff-btn').addEventListener('click', async () => {
  try {
    await api('POST', `/api/tasks/${$('#output-body').dataset.id}/handoff`, { agentId: $('#handoff-agent').value, note: $('#handoff-note').value, run: true });
    $('#output-dialog').close('handoff');
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

$('#output-dialog').addEventListener('close', async () => {
  const message = $('#reply-text').value.trim();
  if ($('#output-dialog').returnValue !== 'reply' || !message) return;
  try {
    await api('POST', `/api/tasks/${$('#output-body').dataset.id}/reply`, { message });
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

$('#copy-output').addEventListener('click', () => navigator.clipboard?.writeText($('#output-body').dataset.raw ?? ''));

const tick = () => ($('#clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
tick();
setInterval(tick, 10_000);
// Poll so finished work shows up without a reload.
setInterval(() => refresh().catch(() => {}), 2000);
refresh().catch((err) => ($('#desks').textContent = `Can't reach the office server: ${err.message}`));
