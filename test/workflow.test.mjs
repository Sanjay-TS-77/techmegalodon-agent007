import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceRun, createRun, resolveApproval, validateWorkflow } from '../src/workflow.mjs';

function workflow(...steps) {
  return { name: 'Service request', description: 'Review a request before preparing a handoff.', steps };
}

function step(id, type, template, extra = {}) {
  return { id, name: id, type, template, ...extra };
}

test('conditional steps and approvals are held at durable checkpoints', async () => {
  const definition = workflow(
    step('triage', 'template', 'Request: {{ input }}'),
    step('routine', 'template', 'Routine queue', {
      when: { step: 'triage', includes: 'urgent', negate: true },
    }),
    step('review', 'approval', 'Review {{steps.triage}}', {
      when: { step: 'triage', includes: 'urgent' },
    }),
    step('handoff', 'template', '{{steps.review}}: {{steps.triage}}'),
  );
  const run = createRun({ id: 'approval-flow', workflow: definition, input: 'urgent' });
  const checkpoints = [];
  const onCheckpoint = (state) => checkpoints.push(structuredClone(state));

  await advanceRun(run, { onCheckpoint });

  assert.equal(run.status, 'awaiting_approval');
  assert.deepEqual(run.pendingApproval, { stepId: 'review', message: 'Review Request: urgent' });
  assert.equal(run.cursor, 2);
  assert.equal(Object.hasOwn(run.outputs, 'routine'), false);
  assert.equal(Object.hasOwn(run.outputs, 'handoff'), false);
  assert.ok(run.events.some((event) => event.type === 'step_skipped' && event.stepId === 'routine'));
  assert.equal(checkpoints.at(-1).status, 'awaiting_approval');

  const restoredRun = JSON.parse(JSON.stringify(checkpoints.at(-1)));
  resolveApproval(restoredRun, { approve: true, note: 'Prioritize' });
  await advanceRun(restoredRun, { onCheckpoint });

  assert.equal(restoredRun.status, 'succeeded');
  assert.equal(restoredRun.pendingApproval, null);
  assert.equal(restoredRun.outputs.handoff, 'Prioritize: Request: urgent');
  assert.equal(restoredRun.events.at(-1).type, 'run_succeeded');
  assert.equal(checkpoints.at(-1).status, 'succeeded');
  assert.equal(run.status, 'awaiting_approval');
});

test('a rejected approval prevents downstream hosted model calls', async () => {
  const run = createRun({
    id: 'reject-flow',
    workflow: workflow(step('review', 'approval', 'Approve?'), step('draft', 'prompt', 'Draft a reply.')),
    mode: 'live',
  });
  const invoke = () => assert.fail('The hosted model was called.');

  await advanceRun(run, { invoke });
  resolveApproval(run, { approve: false, note: 'Insufficient context' });
  await advanceRun(run, { invoke });

  assert.equal(run.status, 'rejected');
  assert.equal(run.cursor, 0);
  assert.equal(run.pendingApproval, null);
  assert.equal(run.events.at(-2).message, 'Insufficient context');
  assert.throws(() => resolveApproval(run, { approve: true }), /no approval available/);
});

test('workflow validation catches unsafe and forward references before a run is created', () => {
  assert.throws(() => validateWorkflow(workflow(step('first', 'template', '{{steps.last}}'), step('last', 'template', 'x'))), /earlier steps/);
  assert.throws(() => validateWorkflow(workflow(step('item', 'template', '{{process.env.KEY}}'))), /invalid placeholder/);
  assert.throws(() => validateWorkflow(workflow(step('item', 'template', 'x'), step('item', 'template', 'y'))), /duplicate ID/);
  assert.throws(() => validateWorkflow(workflow(step('__proto__', 'template', 'x'))), /ID must start/);
  assert.throws(() => validateWorkflow(workflow(step('item', 'shell', 'command'))), /must be a template/);
  assert.throws(() => validateWorkflow(workflow(step('item', 'connector', 'x'))), /connector must be text/);
  assert.throws(() => validateWorkflow(workflow(step('item', 'template', 'x', {
    when: { step: 'later', includes: 'x' },
  }))), /earlier step/);
});

test('preview runs rehearse hosted prompts and treat substituted values as literal text', async () => {
  const definition = workflow(step('draft', 'prompt', 'Prepare a response to {{input}}'));
  const input = '$& {{steps.unknown}}';
  const first = createRun({ id: 'first', workflow: definition, input });
  const second = createRun({ id: 'second', workflow: definition, input });
  const invoke = () => assert.fail('Preview attempted to call a hosted model.');

  await advanceRun(first, { invoke });
  await advanceRun(second, { invoke });

  assert.equal(first.status, 'succeeded');
  assert.equal(first.outputs.draft, 'Hosted model request preview\n\nPrepare a response to $& {{steps.unknown}}');
  assert.equal(second.outputs.draft, first.outputs.draft);
  assert.notStrictEqual(second.outputs, first.outputs);
});

test('connector adapters receive rendered input and can feed hosted prompts', async () => {
  const definition = workflow(
    step('fetch', 'connector', '{{input}}', { connector: 'read-record' }),
    step('draft', 'prompt', 'Draft an update using {{steps.fetch}}'),
  );
  const run = createRun({ id: 'live-flow', workflow: definition, input: 'ticket-17', mode: 'live' });
  const calls = [];

  await advanceRun(run, {
    invokeConnector: async ({ connector, input, step: activeStep, run: activeRun }) => {
      calls.push([connector, input, activeStep.id, activeRun.mode]);
      return { text: 'Waiting for customer' };
    },
    invoke: async ({ prompt }) => {
      calls.push(prompt);
      return { text: 'Request an update', model: 'hosted-test-model', usage: { inputTokens: 12, outputTokens: 4 } };
    },
  });

  assert.deepEqual(calls, [['read-record', 'ticket-17', 'fetch', 'live'], 'Draft an update using Waiting for customer']);
  assert.equal(run.status, 'succeeded');
  assert.equal(run.outputs.draft, 'Request an update');
  assert.deepEqual(run.events.at(-2).usage, { inputTokens: 12, outputTokens: 4 });
  assert.equal(run.events.at(-2).model, 'hosted-test-model');

  const preview = createRun({ id: 'preview-with-adapter', workflow: definition });
  await advanceRun(preview, {
    invokeConnector: async ({ run }) => {
      assert.equal(run.mode, 'preview');
      return { text: '' };
    },
  });
  assert.equal(preview.status, 'succeeded');
  assert.equal(preview.outputs.fetch, '');

  const unconfigured = createRun({ id: 'preview-flow', workflow: definition });
  await advanceRun(unconfigured);
  assert.equal(unconfigured.status, 'failed');
  assert.match(unconfigured.error, /requires a configured connector adapter/);
});

test('failed checkpoints are reported and a run cannot advance twice at once', async () => {
  const definition = workflow(step('model', 'prompt', 'Go'));
  const blocked = createRun({ id: 'blocked-flow', workflow: definition, mode: 'live' });
  await assert.rejects(advanceRun(blocked, {
    onCheckpoint: () => { throw new Error('Store unavailable'); },
    invoke: () => assert.fail('The step started before its checkpoint was saved.'),
  }), /Store unavailable/);

  const run = createRun({ id: 'concurrent-flow', workflow: definition, mode: 'live' });
  const response = Promise.withResolvers();
  const execution = advanceRun(run, { invoke: () => response.promise });
  await assert.rejects(advanceRun(run), /already advancing/);
  response.resolve({ text: 'Completed once' });
  await execution;
  assert.equal(run.status, 'succeeded');
});
