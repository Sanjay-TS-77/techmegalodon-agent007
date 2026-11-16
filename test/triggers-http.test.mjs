import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createApp } from '../src/server.mjs';
import { createClient } from '../src/sdk.mjs';

const setupToken = 'test-token-for-trigger-http-integration-only';

test('bearer webhooks and schedules use the normal run path, with authentication and attribution', async (t) => {
  let time = Date.parse('2026-01-01T12:00:00Z');
  const app = createApp({ env: { AGENT007_SETUP_TOKEN: setupToken }, dataDir: ':memory:', now: () => time, schedulePollMs: 25 });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(app.close);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(`${base}${path}`, {
      method, headers: { ...(body && { 'content-type': 'application/json' }), ...headers },
      ...(body && { body: JSON.stringify(body) }), signal: AbortSignal.timeout(4_000),
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const setup = await request('/api/auth/setup', { method: 'POST', body: { setupToken, username: 'fixture.admin', password: 'fixture access for integration only' } });
  assert.equal(setup.status, 200);
  const headers = { cookie: setup.cookie };

  const { data: { workflow } } = await request('/api/workflows', {
    method: 'POST', headers, body: { name: 'Trigger sample', steps: [{ type: 'template', id: 'echo', name: 'Read input', template: '{{input}}' }] },
  });
  const create = (type, config = {}) => request('/api/triggers', {
    method: 'POST', headers, body: { name: `Fixture ${type}`, type, workflowId: workflow.id, ...config },
  });
  const webhook = await create('webhook', { input: 'Webhook default' });
  assert.equal(webhook.status, 201);
  const webhookPath = `/api/webhooks/${webhook.data.trigger.id}`;
  const send = (body, token, key) => request(webhookPath, {
    method: 'POST', body, headers: { ...(token && { authorization: `Bearer ${token}` }), ...(key && { 'idempotency-key': key }) },
  });
  assert.equal((await request(webhookPath, { method: 'POST', headers })).status, 401);
  const event = { type: 'support.requested', ticket: { id: 9 } };
  const initial = await send(event, webhook.data.secret, 'event-9');
  assert.equal(initial.status, 202);
  assert.equal((await request(`/api/runs/${initial.data.runId}`)).status, 401);
  const replay = await send(event, webhook.data.secret, 'event-9');
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, { runId: initial.data.runId, duplicate: true });
  assert.equal((await send({ input: 'changed' }, webhook.data.secret, 'event-9')).status, 409);
  const { data: { run } } = await request(`/api/runs/${initial.data.runId}`, { headers });
  assert.equal(run.input, JSON.stringify(event));
  assert.deepEqual(run.source, { type: 'webhook', triggerId: webhook.data.trigger.id });

  const rotated = await request(`/api/triggers/${webhook.data.trigger.id}/rotate`, { method: 'POST', body: {}, headers });
  assert.equal(rotated.status, 200);
  assert.equal((await send({}, webhook.data.secret)).status, 401);
  assert.equal((await send({}, rotated.data.secret)).status, 202);

  const schedule = await create('schedule', { intervalMinutes: 1, input: 'Scheduled input' });
  assert.equal(schedule.status, 201);
  assert.equal(schedule.data.trigger.nextAt, '2026-01-01T12:01:00.000Z');
  time += 3 * 60_000;
  let scheduleRun;
  const deadline = performance.now() + 4_000;
  do {
    const { data } = await request('/api/runs', { headers });
    scheduleRun = data.runs.find(candidate => candidate.source?.type === 'schedule');
    if (!scheduleRun) await delay(20);
  } while (!scheduleRun && performance.now() < deadline);
  assert.deepEqual(scheduleRun?.source, { type: 'schedule', triggerId: schedule.data.trigger.id, scheduledAt: '2026-01-01T12:01:00.000Z' });
  const client = createClient(base, { headers });
  const savedTriggers = await client.listTriggers();
  assert.equal(savedTriggers.find(item => item.id === schedule.data.trigger.id).nextAt, '2026-01-01T12:04:00.000Z');
  assert.ok(savedTriggers.every(item => !Object.hasOwn(item, 'secret') && !Object.hasOwn(item, 'secret_hash')));
  const created = await client.createTrigger({ name: 'SDK schedule', type: 'schedule', workflowId: workflow.id, intervalMinutes: 30 });
  const paused = await client.updateTrigger(created.trigger.id, { enabled: false });
  assert.equal(paused.nextAt, null);
  await client.removeTrigger(created.trigger.id);
  assert.equal((await client.listTriggers()).length, 2);
});
