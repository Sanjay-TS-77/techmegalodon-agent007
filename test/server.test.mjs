import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readdir, rmdir, unlink } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import test from 'node:test';
import { createApp } from '../src/server.mjs';

const fixtureWorkflow = {
  name: 'Support handoff',
  description: 'Review a draft before handoff.',
  steps: [
    { id: 'draft', name: 'Draft', type: 'template', template: 'Draft for {{input}}' },
    { id: 'review', name: 'Review', type: 'approval', template: 'Review {{steps.draft}}' },
    { id: 'handoff', name: 'Handoff', type: 'template', template: '{{steps.review}} / {{steps.draft}}' },
  ],
};

async function startServer(options = {}) {
  const { env, ...rest } = options;
  const app = createApp({ dataDir: ':memory:', seed: false, ...rest, env: { AGENT007_AUTH: 'disabled', ...env } });
  app.server.listen(0, '127.0.0.1');
  try {
    await once(app.server, 'listening');
  } catch (error) {
    await app.close();
    throw error;
  }
  const url = `http://127.0.0.1:${app.server.address().port}`;
  return { url, close: app.close };
}

async function call(url, pathname, { method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${url}${pathname}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(4_000),
  });
  return { status: response.status, body: await response.json() };
}

function headerStatus(url, headers) {
  return new Promise((resolve, reject) => {
    const request = get(new URL('/api/config', url), { headers, signal: AbortSignal.timeout(4_000) }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
  });
}

async function waitForStatus(url, runId, expected) {
  const deadline = performance.now() + 4_000;
  while (performance.now() < deadline) {
    const { status, body } = await call(url, `/api/runs/${runId}`);
    assert.equal(status, 200);
    if (body.run.status === expected) return body.run;
    if (body.run.status === 'failed') assert.fail(body.run.error);
    await pause(25);
  }
  assert.fail(`Run ${runId} did not reach ${expected}.`);
}

test('approval state survives a restart and accepts one decision', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent007-http-'));
  let active;
  try {
    active = await startServer({ dataDir });
    const created = await call(active.url, '/api/workflows', { method: 'POST', body: fixtureWorkflow });
    assert.equal(created.status, 201);
    const initiated = await call(active.url, '/api/runs', {
      method: 'POST', body: { workflowId: created.body.workflow.id, input: 'Ticket 147', mode: 'preview' },
    });
    assert.equal(initiated.status, 202);
    const { id } = initiated.body.run;
    const waiting = await waitForStatus(active.url, id, 'awaiting_approval');
    assert.deepEqual(waiting.pendingApproval, { stepId: 'review', message: 'Review Draft for Ticket 147' });
    assert.equal(Object.hasOwn(waiting.outputs, 'handoff'), false);

    await active.close();
    active = undefined;
    active = await startServer({ dataDir });
    const restored = await waitForStatus(active.url, id, 'awaiting_approval');
    assert.equal(restored.workflowRevision, 1);
    assert.equal(restored.pendingApproval.message, waiting.pendingApproval.message);

    const approve = () => call(active.url, `/api/runs/${id}/decision`, {
      method: 'POST', body: { approve: true, note: 'Ready to hand off' },
    });
    const results = await Promise.all([approve(), approve()]);
    assert.deepEqual(results.map(({ status }) => status).sort(), [200, 409]);
    const finished = await waitForStatus(active.url, id, 'succeeded');
    assert.equal(finished.outputs.handoff, 'Ready to hand off / Draft for Ticket 147');
    assert.equal(finished.events.filter(({ type }) => type === 'approval_granted').length, 1);
  } finally {
    if (active) await active.close();
    for (const filename of await readdir(dataDir)) await unlink(join(dataDir, filename));
    await rmdir(dataDir);
  }
});

test('versions reject stale updates and retain both saved revisions', async (t) => {
  const app = await startServer();
  t.after(app.close);
  const original = await call(app.url, '/api/workflows', { method: 'POST', body: fixtureWorkflow });
  assert.equal(original.status, 201);
  const pathname = `/api/workflows/${original.body.workflow.id}`;

  const updated = await call(app.url, pathname, {
    method: 'PUT', body: { ...original.body.workflow, name: 'Updated handoff' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.workflow.revision, 2);
  const stale = await call(app.url, pathname, {
    method: 'PUT', body: { ...original.body.workflow, name: 'Outdated handoff' },
  });
  assert.equal(stale.status, 409);

  const history = await call(app.url, `${pathname}/versions`);
  assert.equal(history.status, 200);
  assert.deepEqual(history.body.versions.map(({ revision, name }) => [revision, name]), [
    [2, 'Updated handoff'], [1, 'Support handoff'],
  ]);
});

test('live planning and prompt runs require a configured hosted model', async (t) => {
  const app = await startServer();
  t.after(app.close);
  const config = await call(app.url, '/api/config');
  assert.equal(config.status, 200);
  assert.equal(config.body.liveConfigured, false);
  const created = await call(app.url, '/api/workflows', {
    method: 'POST',
    body: { ...fixtureWorkflow, steps: [{ id: 'draft', name: 'Draft', type: 'prompt', template: 'Read {{input}}' }] },
  });
  assert.equal(created.status, 201);
  const liveRun = await call(app.url, '/api/runs', {
    method: 'POST', body: { workflowId: created.body.workflow.id, input: 'Draft the handoff', mode: 'live' },
  });
  assert.equal(liveRun.status, 409);
  const livePlan = await call(app.url, '/api/plans', {
    method: 'POST', body: { goal: 'Plan a handoff', mode: 'live' },
  });
  assert.equal(livePlan.status, 409);
});

test('seeded examples are available without a model and configuration hides the key', async (t) => {
  const hiddenKey = 'private-test-value-7d0b41';
  const model = 'test-model';
  const app = await startServer({
    seed: true,
    env: {
      AGENT007_PROVIDER: 'openai', AGENT007_MODEL: model,
      OPENAI_API_KEY: hiddenKey,
    },
    transport: () => assert.fail('This test must never make an external request.'),
  });
  t.after(app.close);
  const config = await call(app.url, '/api/config');
  assert.equal(config.status, 200);
  assert.equal(config.body.liveConfigured, true);
  assert.equal(config.body.model, model);
  assert.equal(JSON.stringify(config.body).includes(hiddenKey), false);
  const examples = await call(app.url, '/api/workflows');
  assert.equal(examples.status, 200);
  assert.ok(examples.body.workflows.length >= 3);
  const example = examples.body.workflows.find(({ steps }) => steps.every(({ type }) => type !== 'connector'));
  assert.ok(example, 'Expected a seeded workflow with no connector steps.');
  const preview = await call(app.url, '/api/runs', {
    method: 'POST', body: { workflowId: example.id, input: 'Example input', mode: 'preview' },
  });
  assert.equal(preview.status, 202);
});

test('the local console admits its own origin and refuses unrelated hosts and origins', async (t) => {
  const app = await startServer();
  t.after(app.close);
  const valid = await call(app.url, '/api/workflows', { method: 'POST', body: fixtureWorkflow, headers: { origin: app.url } });
  assert.equal(valid.status, 201);
  const foreignOrigin = await call(app.url, '/api/workflows', {
    method: 'POST', body: fixtureWorkflow, headers: { origin: 'https://unrelated.invalid' },
  });
  assert.equal(foreignOrigin.status, 403);
  assert.equal(await headerStatus(app.url, { host: 'unrelated.invalid' }), 403);
  assert.equal(await headerStatus(app.url, { 'sec-fetch-site': 'cross-site' }), 403);
  const workflows = await call(app.url, '/api/workflows');
  assert.equal(workflows.body.workflows.length, 1);
});
