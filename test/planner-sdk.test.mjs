import assert from 'node:assert/strict';
import test from 'node:test';
import { createPlan } from '../src/planner.mjs';
import { createClient, Agent007Error } from '../src/sdk.mjs';
import { advanceRun, createRun } from '../src/workflow.mjs';

test('preview planning generates an editable workflow from the goal', async () => {
  const goal = 'Triage customer support requests that include {{steps.unknown}}.';
  const invoke = () => assert.fail('Preview planning called a hosted model.');
  const plan = await createPlan({ goal }, { invoke });
  const expected = await createPlan({ goal });

  assert.deepEqual(plan, expected);
  assert.match(plan.workflow.steps[1].template, /urgency/);
  assert.equal(plan.workflow.description, goal);

  const run = createRun({ id: 'planned', workflow: plan.workflow, input: 'Ticket 147' });
  await advanceRun(run);
  assert.equal(run.status, 'awaiting_approval');
  assert.match(run.pendingApproval.message, /Ticket 147/);
});

test('hosted planning validates strict JSON and the workflow schema', async () => {
  const workflow = { name: 'Review', description: '', steps: [{ id: 'review', name: 'Review', type: 'approval', template: '{{input}}' }] };
  const plan = await createPlan({ goal: 'Review the request.', mode: 'live' }, {
    invoke: async ({ prompt }) => {
      assert.match(prompt, /Review the request\./);
      return { text: JSON.stringify({ workflow, summary: 'Review the request.' }) };
    },
  });
  assert.deepEqual(plan.workflow, workflow);
  await assert.rejects(createPlan({ goal: 'Review it.', mode: 'live' }), /hosted model/);
  await assert.rejects(createPlan({ goal: 'Review it.', mode: 'live' }, {
    invoke: async () => ({ text: '```json\n{}\n```' }),
  }), /return a JSON object/);
  await assert.rejects(createPlan({ goal: 'Review it.', mode: 'live' }, {
    invoke: async () => ({ text: JSON.stringify({ workflow: { name: 'Invalid', steps: [] }, summary: 'x' }) }),
  }), /between 1 and 32 steps/);
});

test('SDK encodes run identifiers and stops polling when review is needed', async () => {
  const calls = [];
  let status = 'running';
  const client = createClient('https://example.test/root', {
    headers: { 'x-test': 'example' },
    fetch: async (url, options) => {
      calls.push({ url: url.pathname, method: options.method, body: options.body, header: options.headers.get('x-test') });
      const response = Response.json({ run: { id: 'work/17', status } });
      status = 'awaiting_approval';
      return response;
    },
  });
  const run = await client.waitForRun('work/17', { intervalMs: 1, timeoutMs: 1_000 });
  assert.equal(run.status, 'awaiting_approval');
  assert.deepEqual(calls.map((call) => call.url), ['/root/api/runs/work%2F17', '/root/api/runs/work%2F17']);
  assert.equal(calls[0].header, 'example');
});

test('SDK preserves the server error message and status', async () => {
  const client = createClient(undefined, {
    fetch: async (url, options) => {
      assert.equal(url.pathname, '/api/runs/bad/decision');
      assert.deepEqual(JSON.parse(options.body), { approve: false, note: 'Defer' });
      return Response.json({ error: 'The run has already finished.' }, { status: 409 });
    },
  });
  await assert.rejects(client.decideRun('bad', { approve: false, note: 'Defer' }), (error) => {
    assert.ok(error instanceof Agent007Error);
    assert.equal(error.status, 409);
    assert.equal(error.message, 'The run has already finished.');
    return true;
  });
});
