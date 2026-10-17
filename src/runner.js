import { complete } from './providers.js';

// Turns an agent + task into a prompt, calls the agent's provider and
// records the result on the task.
export function buildPrompt(agent, task, company = {}) {
  const about = company.name ? ` at ${company.name}${company.about ? ` (${company.about})` : ''}` : '';
  const system = `You are ${agent.name}, the ${agent.role} agent${about}.\n\n${agent.instructions}`.trim();
  const prompt = task.details ? `${task.title}\n\n${task.details}` : task.title;
  return { system, prompt };
}

export function createRunner(store, { complete: call = complete, company = {} } = {}) {
  const running = new Set();

  return {
    isRunning: (taskId) => running.has(taskId),

    async run(taskId) {
      const task = store.task(taskId);
      if (!task) throw new Error('task not found');
      if (running.has(taskId)) throw new Error('task is already running');
      const agent = store.agent(task.agentId);
      if (!agent) throw new Error('the agent for this task was removed');

      running.add(taskId);
      store.updateTask(taskId, { status: 'working', error: '', startedAt: new Date().toISOString(), finishedAt: '' });
      try {
        const { text, usage } = await call({ provider: agent.provider, model: agent.model, ...buildPrompt(agent, task, company) });
        store.addUsage(taskId, usage);
        return store.updateTask(taskId, { status: 'done', output: text, finishedAt: new Date().toISOString() });
      } catch (err) {
        return store.updateTask(taskId, { status: 'failed', error: err.message, finishedAt: new Date().toISOString() });
      } finally {
        running.delete(taskId);
      }
    },
  };
}
