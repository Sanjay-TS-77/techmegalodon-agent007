const STEP_TYPES = new Set(['template', 'prompt', 'approval', 'connector']);
const STEP_ID = /^[a-zA-Z][a-zA-Z\d_-]{0,63}$/;
const CONNECTOR_ID = /^[a-z][a-z\d]*(?:-[a-z\d]+)*$/;
const RESERVED_IDS = new Set(['constructor', 'prototype']);
const PLACEHOLDER = /{{\s*(input|steps\.([a-zA-Z][a-zA-Z\d_-]{0,63}))\s*}}/g;
const MAX_RENDERED_LENGTH = 48_000;
const advancing = new WeakSet();

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function requireText(value, label, maxLength, { optional = false, preserve = false } = {}) {
  if (optional && value === undefined) return '';
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  if (value.length > maxLength) throw new Error(`${label} must be at most ${maxLength} characters.`);
  if (!optional && !value.trim()) throw new Error(`${label} is required.`);
  return preserve ? value : value.trim();
}

function validateTemplate(template, earlierSteps, label) {
  const literalText = template.replace(PLACEHOLDER, (_token, _reference, id) => {
    if (id && !earlierSteps.has(id)) {
      throw new Error(`${label} can only reference earlier steps. Unknown reference: ${id}.`);
    }
    return '';
  });
  if (literalText.includes('{{')) {
    throw new Error(`${label} has an invalid placeholder. Use {{input}} or {{steps.stepId}}.`);
  }
}

function validateCondition(when, earlierSteps, label) {
  requireObject(when, `${label} condition`);
  if (!earlierSteps.has(when.step)) {
    throw new Error(`${label} condition must reference an earlier step.`);
  }
  const includes = requireText(when.includes, `${label} condition text`, 1_000, { preserve: true });
  if (when.negate !== undefined && typeof when.negate !== 'boolean') {
    throw new Error(`${label} condition negate must be true or false.`);
  }
  return { step: when.step, includes, negate: when.negate ?? false };
}

export function validateWorkflow(workflow) {
  requireObject(workflow, 'Workflow');
  const name = requireText(workflow.name, 'Workflow name', 120);
  const description = requireText(workflow.description, 'Workflow description', 2_000, { optional: true });
  if (!Array.isArray(workflow.steps) || workflow.steps.length < 1 || workflow.steps.length > 32) {
    throw new Error('A workflow must contain between 1 and 32 steps.');
  }

  const earlierSteps = new Set();
  const steps = workflow.steps.map((step, index) => {
    const label = `Step ${index + 1}`;
    requireObject(step, label);
    const { id, type } = step;
    if (typeof id !== 'string' || !STEP_ID.test(id) || RESERVED_IDS.has(id)) {
      throw new Error(`${label} ID must start with a letter and use letters, digits, dashes, or underscores.`);
    }
    if (earlierSteps.has(id)) throw new Error(`${label} uses a duplicate ID: ${id}.`);
    if (!STEP_TYPES.has(type)) throw new Error(`${label} must be a template, prompt, approval, or connector.`);
    const name = requireText(step.name, `${label} name`, 120);
    const template = requireText(step.template, `${label} template`, 12_000, { preserve: true });
    validateTemplate(template, earlierSteps, label);

    const normalizedStep = { id, name, type, template };
    if (type === 'connector') {
      const connector = requireText(step.connector, `${label} connector`, 64);
      if (!CONNECTOR_ID.test(connector)) throw new Error(`${label} connector must use lowercase letters, digits, and dashes.`);
      normalizedStep.connector = connector;
    }
    if (step.when !== undefined) normalizedStep.when = validateCondition(step.when, earlierSteps, label);
    earlierSteps.add(id);
    return normalizedStep;
  });

  return { name, description, steps };
}

export function createRun({ id, workflow, input = '', mode = 'preview' }) {
  const runId = requireText(id, 'Run ID', 128);
  if (mode !== 'preview' && mode !== 'live') throw new Error('Run mode must be preview or live.');
  const runInput = requireText(input, 'Run input', 20_000, { optional: true, preserve: true });
  const timestamp = new Date().toISOString();
  return {
    id: runId,
    workflow: validateWorkflow(workflow),
    input: runInput,
    mode,
    status: 'running',
    cursor: 0,
    outputs: {},
    events: [],
    pendingApproval: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    error: null,
  };
}

function recordEvent(run, type, details = {}) {
  const at = new Date().toISOString();
  run.events.push({ at, type, ...details });
  run.updatedAt = at;
}

function readOutput(run, id) {
  return Object.hasOwn(run.outputs, id) ? run.outputs[id] : undefined;
}

function conditionPasses(run, when) {
  if (!when) return true;
  const source = readOutput(run, when.step);
  if (source === undefined) return false;
  const match = source.includes(when.includes);
  return when.negate ? !match : match;
}

function renderTemplate(run, template) {
  let renderedLength = 0;
  let previousEnd = 0;
  const result = template.replace(PLACEHOLDER, (token, _reference, id, offset) => {
    const value = id ? readOutput(run, id) ?? '' : run.input;
    renderedLength += offset - previousEnd + value.length;
    previousEnd = offset + token.length;
    if (renderedLength > MAX_RENDERED_LENGTH) throw new Error(`Rendered step exceeds ${MAX_RENDERED_LENGTH} characters.`);
    return value;
  });
  if (result.length > MAX_RENDERED_LENGTH) {
    throw new Error(`Rendered step exceeds ${MAX_RENDERED_LENGTH} characters.`);
  }
  return result;
}

function previewResult(prompt) {
  const excerpt = prompt.length > 2_500 ? `${prompt.slice(0, 2_500)}\n…` : prompt;
  return { text: `Hosted model request preview\n\n${excerpt}` };
}

function normalizeUsage(usage) {
  const inputTokens = usage?.inputTokens;
  const outputTokens = usage?.outputTokens;
  if (!Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0) {
    return undefined;
  }
  return { inputTokens, outputTokens };
}

async function executeStep(run, step, { invoke, invokeConnector, onCheckpoint }) {
  let result;
  let rendered;
  const started = performance.now();
  try {
    rendered = renderTemplate(run, step.template);
    if (step.type === 'prompt') {
      if (run.mode === 'live' && typeof invoke !== 'function') throw new Error('A hosted model is required for a live prompt.');
      result = run.mode === 'preview' ? previewResult(rendered) : await invoke({ prompt: rendered, step, run });
      validateResult(result, 'Model');
    }
    if (step.type === 'connector') {
      if (typeof invokeConnector !== 'function') throw new Error(`Connector ${step.connector} requires a configured connector adapter.`);
      result = await invokeConnector({ connector: step.connector, input: rendered, step, run });
      validateResult(result, 'Connector', { allowEmpty: true });
    }
  } catch (error) {
    run.status = 'failed';
    run.error = error instanceof Error ? error.message.slice(0, 500) : 'Step execution failed.';
    recordEvent(run, 'run_failed', { stepId: step.id, message: run.error });
    await onCheckpoint(run);
    return;
  }

  if (step.type === 'approval') {
    run.status = 'awaiting_approval';
    run.pendingApproval = { stepId: step.id, message: rendered };
    recordEvent(run, 'approval_requested', { stepId: step.id, message: step.name });
  } else {
    run.outputs[step.id] = result?.text ?? rendered;
    run.cursor += 1;
    const durationMs = Math.round(performance.now() - started);
    const usage = normalizeUsage(result?.usage);
    const model = typeof result?.model === 'string' ? result.model.slice(0, 120) : undefined;
    recordEvent(run, 'step_completed', { stepId: step.id, durationMs, ...(usage && { usage }), ...(model && { model }) });
  }
  await onCheckpoint(run);
}

function validateResult(result, label, { allowEmpty = false } = {}) {
  if (typeof result?.text !== 'string' || (!allowEmpty && !result.text.trim()) || result.text.length > MAX_RENDERED_LENGTH) {
    throw new Error(`${label} response did not contain valid text within the result size limit.`);
  }
}

export async function advanceRun(run, { invoke, invokeConnector, onCheckpoint = async () => {} } = {}) {
  if (advancing.has(run)) throw new Error('This run is already advancing.');
  if (run.status !== 'running') return run;

  advancing.add(run);
  try {
    while (run.status === 'running' && run.cursor < run.workflow.steps.length) {
      const step = run.workflow.steps[run.cursor];
      if (!conditionPasses(run, step.when)) {
        run.cursor += 1;
        recordEvent(run, 'step_skipped', { stepId: step.id, message: 'Step condition did not match.' });
        await onCheckpoint(run);
        continue;
      }
      recordEvent(run, 'step_started', { stepId: step.id, message: step.name });
      await onCheckpoint(run);
      await executeStep(run, step, { invoke, invokeConnector, onCheckpoint });
    }
    if (run.status === 'running') {
      run.status = 'succeeded';
      recordEvent(run, 'run_succeeded');
      await onCheckpoint(run);
    }
    return run;
  } finally {
    advancing.delete(run);
  }
}

export function resolveApproval(run, { approve, note } = {}) {
  if (advancing.has(run) || run.status !== 'awaiting_approval' || !run.pendingApproval) {
    throw new Error('This run has no approval available to resolve.');
  }
  if (typeof approve !== 'boolean') throw new Error('Approval decision must be true or false.');
  const decisionNote = requireText(note, 'Approval note', 2_000, { optional: true });
  const { stepId } = run.pendingApproval;
  if (run.workflow.steps[run.cursor]?.id !== stepId) throw new Error('Approval does not match the current step.');

  run.pendingApproval = null;
  if (approve) {
    run.outputs[stepId] = decisionNote || 'Approved';
    run.cursor += 1;
    run.status = 'running';
    recordEvent(run, 'approval_granted', { stepId, message: decisionNote || 'Approved' });
  } else {
    run.status = 'rejected';
    recordEvent(run, 'approval_rejected', { stepId, message: decisionNote || 'Rejected' });
    recordEvent(run, 'run_rejected');
  }
  return run;
}
