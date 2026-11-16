import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MINUTE = 60_000;
const RECEIPT_TTL = 24 * 60 * MINUTE;
const MAX_RECEIPTS = 50_000;
const RETRY_DELAY = 30_000;
const MAX_DUE_PER_POLL = 32;
const MAX_INTERVAL = 43_200;
const MAX_INPUT = 20_000;
const ID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function digest(text) {
  return createHash('sha256').update(text).digest();
}

function scheduledRunId(triggerId, time) {
  const bytes = digest(`${triggerId}/${time}`).subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validateInput(input) {
  if (typeof input !== 'string' || input.length > MAX_INPUT) {
    fail(400, `Trigger input must be text with up to ${MAX_INPUT.toLocaleString('en-US')} characters.`);
  }
  return input;
}

function validateConfig({ name, type, workflowId, mode = 'preview', enabled = true, input = '', intervalMinutes }) {
  if (typeof name !== 'string' || !name.trim() || name.length > 120) fail(400, 'Use a trigger name of 1 to 120 characters.');
  if (type !== 'schedule' && type !== 'webhook') fail(400, 'Choose a schedule or webhook trigger.');
  if (typeof workflowId !== 'string' || !ID.test(workflowId)) fail(400, 'Choose a workflow for this trigger.');
  if (mode !== 'preview' && mode !== 'live') fail(400, 'Choose preview or live mode.');
  if (typeof enabled !== 'boolean') fail(400, 'Enabled must be true or false.');
  if (type === 'schedule' && (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > MAX_INTERVAL)) {
    fail(400, `Choose an interval of 1 to ${MAX_INTERVAL.toLocaleString('en-US')} minutes.`);
  }
  if (type === 'webhook' && intervalMinutes != null) fail(400, 'Intervals apply to schedules.');
  return { name: name.trim(), type, workflowId, mode, enabled, input: validateInput(input), intervalMinutes: intervalMinutes ?? null };
}

function publicTrigger(row) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    workflowId: row.workflow_id,
    mode: row.mode,
    enabled: Boolean(row.enabled),
    input: row.input,
    intervalMinutes: row.interval_minutes,
    nextAt: row.next_at === null ? null : new Date(row.next_at).toISOString(),
    lastRunId: row.last_run_id,
    lastError: row.last_error,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export function openTriggers(directory, { now = Date.now } = {}) {
  if (directory !== ':memory:') mkdirSync(directory, { recursive: true });
  const database = new DatabaseSync(directory === ':memory:' ? directory : join(directory, 'triggers.sqlite'));
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS triggers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      mode TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      input TEXT NOT NULL,
      interval_minutes INTEGER,
      secret_hash BLOB,
      next_at INTEGER,
      retry_at INTEGER,
      last_run_id TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS triggers_by_schedule ON triggers (next_at) WHERE enabled = 1;
    CREATE TABLE IF NOT EXISTS webhook_receipts (
      trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
      key_hash BLOB NOT NULL,
      input_hash BLOB NOT NULL,
      run_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      delivered INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (trigger_id, key_hash)
    );
    CREATE INDEX IF NOT EXISTS webhook_receipts_by_expiry ON webhook_receipts (expires_at);
  `);

  const find = database.prepare('SELECT * FROM triggers WHERE id = ?');
  const due = database.prepare('SELECT id FROM triggers WHERE enabled = 1 AND next_at <= ? AND (retry_at IS NULL OR retry_at <= ?) ORDER BY next_at, id LIMIT ?');
  const saveSchedule = database.prepare('UPDATE triggers SET next_at = ?, retry_at = NULL, last_run_id = ?, last_error = NULL WHERE id = ?');
  const scheduleFailure = database.prepare('UPDATE triggers SET retry_at = ?, last_error = ? WHERE id = ?');
  const recordWebhook = database.prepare('UPDATE triggers SET last_run_id = ? WHERE id = ?');
  const findReceipt = database.prepare('SELECT * FROM webhook_receipts WHERE trigger_id = ? AND key_hash = ?');
  const grantProofs = new WeakMap();

  function write(action) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  function requireTrigger(id) {
    const row = find.get(id);
    if (!row) fail(404, 'Trigger not found.');
    return row;
  }

  function checkWebhook(id, proof) {
    const row = find.get(id);
    if (!row || row.type !== 'webhook' || !row.enabled) fail(404, 'Webhook not found.');
    if (!proof || !timingSafeEqual(row.secret_hash, proof)) fail(401, 'A valid webhook bearer token is required.');
    return row;
  }

  function reserveWebhook(grant, keyHash, inputHash) {
    write(() => {
      checkWebhook(grant.id, grant.proof);
      const time = now();
      database.prepare('DELETE FROM webhook_receipts WHERE expires_at <= ?').run(time);
      const receipt = findReceipt.get(grant.id, keyHash);
      if (receipt) {
        if (!timingSafeEqual(receipt.input_hash, inputHash)) fail(409, 'This idempotency key was used for a different input.');
        return;
      }
      const receiptCount = database.prepare('SELECT count(*) AS count FROM webhook_receipts').get().count;
      if (receiptCount >= MAX_RECEIPTS) fail(429, 'Webhook storage is busy. Retry with the same idempotency key later.');
      database.prepare('INSERT INTO webhook_receipts (trigger_id, key_hash, input_hash, run_id, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(grant.id, keyHash, inputHash, randomUUID(), time + RECEIPT_TTL);
    });
  }

  return {
    list: () => database.prepare('SELECT * FROM triggers ORDER BY created_at DESC, id').all().map(publicTrigger),
    get(id) {
      const row = find.get(id);
      return row && publicTrigger(row);
    },
    create(config) {
      const trigger = validateConfig(config);
      const id = randomUUID();
      const time = now();
      const secret = trigger.type === 'webhook' ? randomBytes(32).toString('base64url') : undefined;
      const nextAt = trigger.type === 'schedule' && trigger.enabled ? time + trigger.intervalMinutes * MINUTE : null;
      database.prepare(`INSERT INTO triggers (id, name, type, workflow_id, mode, enabled, input, interval_minutes, secret_hash, next_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, trigger.name, trigger.type, trigger.workflowId, trigger.mode, Number(trigger.enabled), trigger.input,
          trigger.intervalMinutes, secret ? digest(secret) : null, nextAt, time, time);
      return { trigger: publicTrigger(requireTrigger(id)), ...(secret ? { secret } : {}) };
    },
    update(id, patch) {
      return write(() => {
        const row = requireTrigger(id);
        if (patch.type !== undefined && patch.type !== row.type) fail(400, 'The trigger type cannot be changed.');
        const current = publicTrigger(row);
        const config = { ...current };
        for (const key of ['name', 'workflowId', 'mode', 'enabled', 'input', 'intervalMinutes']) {
          if (Object.hasOwn(patch, key)) config[key] = patch[key];
        }
        const trigger = validateConfig(config);
        const time = now();
        const resetSchedule = current.enabled !== trigger.enabled || current.intervalMinutes !== trigger.intervalMinutes;
        let nextAt = row.next_at;
        if (trigger.type === 'schedule' && resetSchedule) nextAt = trigger.enabled ? time + trigger.intervalMinutes * MINUTE : null;
        database.prepare(`UPDATE triggers SET name = ?, workflow_id = ?, mode = ?, enabled = ?, input = ?, interval_minutes = ?,
          next_at = ?, retry_at = NULL, last_error = NULL, updated_at = ? WHERE id = ?`)
          .run(trigger.name, trigger.workflowId, trigger.mode, Number(trigger.enabled), trigger.input, trigger.intervalMinutes, nextAt, time, id);
        return publicTrigger(requireTrigger(id));
      });
    },
    remove(id) {
      if (database.prepare('DELETE FROM triggers WHERE id = ?').run(id).changes === 0) fail(404, 'Trigger not found.');
    },
    rotate(id) {
      return write(() => {
        const row = requireTrigger(id);
        if (row.type !== 'webhook') fail(400, 'Only webhooks have a bearer token.');
        const secret = randomBytes(32).toString('base64url');
        database.prepare('UPDATE triggers SET secret_hash = ?, updated_at = ? WHERE id = ?').run(digest(secret), now(), id);
        return { trigger: publicTrigger(requireTrigger(id)), secret };
      });
    },
    authenticateWebhook(id, authorization) {
      const bearer = typeof authorization === 'string' && authorization.match(/^Bearer +([A-Za-z\d_-]{43})$/i);
      const proof = bearer ? digest(bearer[1]) : null;
      checkWebhook(id, proof);
      const grant = {};
      grantProofs.set(grant, { id, proof });
      return grant;
    },
    deliverWebhook(grant, { input, idempotencyKey }, startRun) {
      const credentials = grantProofs.get(grant);
      if (!credentials) fail(401, 'Webhook authentication is required.');
      if (input !== undefined) validateInput(input);
      let keyHash;
      let inputHash;
      if (idempotencyKey !== undefined) {
        if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 128 || /[^!-~]/.test(idempotencyKey)) {
          fail(400, 'Use an idempotency key of 1 to 128 visible ASCII characters.');
        }
        keyHash = digest(idempotencyKey);
        inputHash = digest(JSON.stringify(input ?? null));
        // Reserve the run ID before dispatch so a retry can reuse it after a process interruption.
        reserveWebhook(credentials, keyHash, inputHash);
      }
      return write(() => {
        const row = checkWebhook(credentials.id, credentials.proof);
        const receipt = keyHash ? findReceipt.get(row.id, keyHash) : null;
        if (keyHash && !receipt) fail(409, 'The webhook receipt expired. Retry with the same idempotency key.');
        if (receipt && !timingSafeEqual(receipt.input_hash, inputHash)) fail(409, 'This idempotency key was used for a different input.');
        if (receipt?.delivered) return { runId: receipt.run_id, duplicate: true };
        const runId = receipt?.run_id ?? randomUUID();
        startRun({ id: runId, workflowId: row.workflow_id, input: input ?? row.input, mode: row.mode,
          source: { type: 'webhook', triggerId: row.id } });
        if (receipt) database.prepare('UPDATE webhook_receipts SET delivered = 1 WHERE trigger_id = ? AND key_hash = ?').run(row.id, keyHash);
        recordWebhook.run(runId, row.id);
        return { runId, duplicate: false };
      });
    },
    runDue(startRun) {
      const time = now();
      let count = 0;
      for (const { id } of due.all(time, time, MAX_DUE_PER_POLL)) {
        const result = write(() => {
          const row = find.get(id);
          if (!row || !row.enabled || row.next_at === null || row.next_at > time || row.retry_at > time) return 'skipped';
          const runId = scheduledRunId(row.id, row.next_at);
          try {
            startRun({ id: runId, workflowId: row.workflow_id, input: row.input, mode: row.mode,
              source: { type: 'schedule', triggerId: row.id, scheduledAt: new Date(row.next_at).toISOString() } });
          } catch (error) {
            if (error?.status === 429) {
              scheduleFailure.run(null, 'Run capacity is busy. This schedule will retry.', id);
              return 'busy';
            }
            scheduleFailure.run(time + RETRY_DELAY, 'The run could not start. Check the workflow and runtime configuration.', id);
            return 'skipped';
          }
          const interval = row.interval_minutes * MINUTE;
          // Rejoin the original cadence after one late firing without replaying every missed interval.
          const nextAt = row.next_at + (Math.floor((time - row.next_at) / interval) + 1) * interval;
          saveSchedule.run(nextAt, runId, id);
          return 'started';
        });
        if (result === 'busy') break;
        if (result === 'started') count += 1;
      }
      return count;
    },
    close: () => database.close(),
  };
}
