import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openTriggers } from '../src/triggers.mjs';

const WORKFLOW_ID = '54755690-53b1-4aef-8355-9b26a48d5154';
const START = Date.parse('2026-01-30T23:45:00.000Z');
const MINUTE = 60_000;

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'agent007-trigger-test-'));
  let now = START;
  let database = openTriggers(directory, { now: () => now });
  t.after(() => {
    database.close();
    for (const file of readdirSync(directory)) unlinkSync(join(directory, file));
    rmdirSync(directory);
  });
  return {
    get database() { return database; },
    advance(ms) { now += ms; },
    reopen() {
      database.close();
      database = openTriggers(directory, { now: () => now });
    },
    directory,
  };
}

function createSchedule(database, overrides = {}) {
  return database.create({ name: 'Hourly review', type: 'schedule', workflowId: WORKFLOW_ID, intervalMinutes: 60, ...overrides }).trigger;
}

function createWebhook(database) {
  return database.create({ name: 'Intake', type: 'webhook', workflowId: WORKFLOW_ID, input: 'Default request' });
}

test('schedules persist, coalesce downtime in UTC, and retain original cadence', t => {
  const state = fixture(t);
  const schedule = createSchedule(state.database, { input: 'Status', mode: 'live' });
  const starts = [];
  const recordStart = run => starts.push(run);
  assert.equal(schedule.nextAt, '2026-01-31T00:45:00.000Z');
  assert.equal(state.database.runDue(recordStart), 0);
  assert.equal(starts.length, 0);

  state.advance(198 * MINUTE);
  state.reopen();
  assert.equal(state.database.runDue(recordStart), 1);
  assert.deepEqual(starts[0], {
    id: state.database.get(schedule.id).lastRunId,
    workflowId: WORKFLOW_ID,
    input: 'Status',
    mode: 'live',
    source: { type: 'schedule', triggerId: schedule.id, scheduledAt: '2026-01-31T00:45:00.000Z' },
  });
  assert.match(starts[0].id, /^[a-f\d-]{36}$/);
  assert.equal(state.database.get(schedule.id).nextAt, '2026-01-31T03:45:00.000Z');
  state.reopen();
  assert.equal(state.database.runDue(recordStart), 0);
  const disabled = state.database.update(schedule.id, { enabled: false });
  assert.equal(disabled.nextAt, null);
  state.advance(90 * MINUTE);
  assert.equal(state.database.runDue(recordStart), 0);
  assert.equal(starts.length, 1);
  const resumed = state.database.update(schedule.id, { enabled: true, intervalMinutes: 2 });
  assert.equal(resumed.nextAt, '2026-01-31T04:35:00.000Z');
});

test('a busy scheduler keeps the same run ID, then accepts the occurrence on retry', t => {
  const state = fixture(t);
  const schedule = createSchedule(state.database, { intervalMinutes: 1 });
  createSchedule(state.database, { intervalMinutes: 1 });
  state.advance(MINUTE);
  let blocked;
  let attempts = 0;
  assert.equal(state.database.runDue(run => {
    attempts += 1;
    blocked = run;
    throw Object.assign(new Error('capacity'), { status: 429 });
  }), 0);
  assert.equal(attempts, 1);
  const busy = state.database.get(blocked.source.triggerId);
  assert.match(busy.lastError, /capacity/);
  assert.equal(busy.nextAt, schedule.nextAt);

  state.advance(5000);
  state.reopen();
  const accepted = [];
  assert.equal(state.database.runDue(run => accepted.push(run)), 2);
  assert.equal(accepted[0].id, blocked.id);
  assert.equal(state.database.get(blocked.source.triggerId).lastError, null);
});

test('a failed scheduled start backs off and stores a generic error', t => {
  const state = fixture(t);
  const schedule = createSchedule(state.database, { intervalMinutes: 1 });
  state.advance(MINUTE);
  let firstId;
  assert.equal(state.database.runDue(({ id }) => {
    firstId = id;
    throw Object.assign(new Error('Example private runtime detail'), { status: 409 });
  }), 0);
  const pending = state.database.get(schedule.id);
  assert.match(pending.lastError, /Check the workflow/);
  assert.doesNotMatch(pending.lastError, /private runtime detail/);
  assert.equal(pending.nextAt, schedule.nextAt);
  const starts = [];
  const recordStart = run => starts.push(run.id);
  state.advance(29_999);
  assert.equal(state.database.runDue(recordStart), 0);
  assert.deepEqual(starts, []);
  state.advance(1);
  assert.equal(state.database.runDue(recordStart), 1);
  assert.deepEqual(starts, [firstId]);
});

test('webhook secrets are one-time, rotated secrets invalidate old grants, and disabled webhooks are closed', t => {
  const state = fixture(t);
  const { trigger, secret } = createWebhook(state.database);
  assert.match(secret, /^[\w-]{43}$/);
  assert.deepEqual(state.database.list(), [trigger]);
  assert.equal(state.database.get(trigger.id).secret, undefined);
  assert.throws(() => state.database.authenticateWebhook(trigger.id), { status: 401 });
  assert.throws(() => state.database.authenticateWebhook(WORKFLOW_ID, `Bearer ${secret}`), { status: 404 });
  assert.throws(() => state.database.deliverWebhook({}, {}, assert.fail), { status: 401 });

  const oldGrant = state.database.authenticateWebhook(trigger.id, `Bearer ${secret}`);
  const rotated = state.database.rotate(trigger.id);
  assert.notEqual(rotated.secret, secret);
  assert.throws(() => state.database.authenticateWebhook(trigger.id, `Bearer ${secret}`), { status: 401 });
  assert.throws(() => state.database.deliverWebhook(oldGrant, {}, assert.fail), { status: 401 });

  const grant = state.database.authenticateWebhook(trigger.id, `bearer ${rotated.secret}`);
  const accepted = state.database.deliverWebhook(grant, {}, run => {
    assert.equal(run.workflowId, WORKFLOW_ID);
    assert.equal(run.input, 'Default request');
    assert.equal(run.mode, 'preview');
    assert.deepEqual(run.source, { type: 'webhook', triggerId: trigger.id });
  });
  assert.equal(accepted.runId, state.database.get(trigger.id).lastRunId);
  assert.equal(accepted.duplicate, false);
  state.database.update(trigger.id, { enabled: false });
  assert.throws(() => state.database.deliverWebhook(grant, {}, assert.fail), { status: 404 });
  state.reopen();
  const persisted = readFileSync(join(state.directory, 'triggers.sqlite'));
  assert.equal(persisted.includes(Buffer.from(secret)), false);
  assert.equal(persisted.includes(Buffer.from(rotated.secret)), false);
  state.database.remove(trigger.id);
  assert.equal(state.database.get(trigger.id), undefined);
});

test('webhook receipt holds the run ID across retries and detects changed input', t => {
  const state = fixture(t);
  const { trigger, secret } = createWebhook(state.database);
  const auth = () => state.database.authenticateWebhook(trigger.id, `Bearer ${secret}`);
  const request = { input: '', idempotencyKey: 'ticket-18' };
  let firstId;
  assert.throws(() => state.database.deliverWebhook(auth(), request, run => {
    assert.equal(run.input, '');
    firstId = run.id;
    throw Object.assign(new Error('capacity'), { status: 429 });
  }), { status: 429 });

  state.reopen();
  const accepted = state.database.deliverWebhook(auth(), request, run => assert.equal(run.id, firstId));
  assert.deepEqual(accepted, { runId: firstId, duplicate: false });
  assert.deepEqual(state.database.deliverWebhook(auth(), request, assert.fail), { runId: firstId, duplicate: true });
  assert.throws(() => state.database.deliverWebhook(auth(), { ...request, input: 'different' }, assert.fail), { status: 409 });

  state.advance(24 * 60 * MINUTE);
  const fresh = state.database.deliverWebhook(auth(), { ...request, input: 'different' }, () => {});
  assert.notEqual(fresh.runId, firstId);
  assert.equal(fresh.duplicate, false);
});

test('trigger validation bounds intervals, webhook keys, and workflow input', t => {
  const { database } = fixture(t);
  for (const intervalMinutes of [0, 43_201, 1.5, '10']) {
    assert.throws(() => createSchedule(database, { intervalMinutes }), { status: 400 });
  }
  assert.throws(() => createSchedule(database, { input: 'a'.repeat(20_001) }), { status: 400 });
  const { trigger, secret } = createWebhook(database);
  const grant = database.authenticateWebhook(trigger.id, `Bearer ${secret}`);
  assert.throws(() => database.update(trigger.id, { type: 'schedule' }), { status: 400 });
  assert.throws(() => database.update(trigger.id, { intervalMinutes: 30 }), { status: 400 });
  assert.throws(() => database.deliverWebhook(grant, { idempotencyKey: 'a b' }, assert.fail), { status: 400 });
  assert.throws(() => database.deliverWebhook(grant, { idempotencyKey: 'request\n' }, assert.fail), { status: 400 });
  assert.throws(() => database.deliverWebhook(grant, { input: 'a'.repeat(20_001) }, assert.fail), { status: 400 });
});
