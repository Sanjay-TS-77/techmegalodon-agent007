import { createGraph } from "./graph.js";
import { createWorkspaceTools } from "./workspace.js";

const byId = (id) => document.getElementById(id);
const types = {
  template: { label: "Template", marker: "T", field: "Template" },
  prompt: { label: "Model prompt", marker: "P", field: "Prompt" },
  approval: { label: "Human approval", marker: "✓", field: "Review instructions" },
  connector: { label: "Connector", marker: "↔", field: "Connector input" },
};
const statusNames = {
  running: "Running",
  awaiting_approval: "Awaiting approval",
  succeeded: "Succeeded",
  failed: "Failed",
  rejected: "Rejected",
};
const state = {
  library: new Map(),
  runs: [],
  selected: null,
  selectedRunId: null,
  run: null,
  connectors: [],
  config: null,
  session: null,
  sessionVersion: 0,
  ready: false,
  busy: false,
  polling: false,
  localNumber: 0,
  lastHistoryRefresh: 0,
  lastRunRefresh: 0,
};

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, className, listener) {
  const node = element("button", className, label);
  node.type = "button";
  node.addEventListener("click", listener);
  return node;
}

async function request(url, method = "GET", body) {
  const version = state.sessionVersion;
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (version !== state.sessionVersion) throw new Error("The workspace session changed.");
  if (!response.ok || data === null) {
    const message = typeof data?.error === "string" ? data.error : data?.error?.message;
    if (response.status === 401 && !url.startsWith("/api/auth/")) workspaceTools.expire();
    throw new Error(message || "Request failed (" + response.status + ").");
  }
  return data;
}

function notify(message = "", kind = "info") {
  const notice = byId("notice");
  notice.textContent = message;
  notice.dataset.kind = kind;
  notice.hidden = !message;
}

function showError(error) {
  notify(error.message || "Something went wrong.", "error");
}

function shortDate(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function currentEntry() {
  return state.library.get(state.selected);
}

function editableWorkflow(workflow) {
  if (!workflow || typeof workflow.name !== "string" || !Array.isArray(workflow.steps)) {
    throw new Error("This file does not contain a workflow name and steps.");
  }
  return {
    name: workflow.name,
    description: typeof workflow.description === "string" ? workflow.description : "",
    steps: workflow.steps.map((step) => {
      if (!step || typeof step.id !== "string" || typeof step.name !== "string" ||
        !Object.hasOwn(types, step.type) || typeof step.template !== "string") {
        throw new Error("Each step needs an ID, name, supported type and template.");
      }
      const editable = { id: step.id, name: step.name, type: step.type, template: step.template };
      if (step.type === "connector" && typeof step.connector === "string") editable.connector = step.connector;
      if (step.when && typeof step.when === "object") {
        editable.when = {
          step: typeof step.when.step === "string" ? step.when.step : "",
          includes: typeof step.when.includes === "string" ? step.when.includes : "",
          negate: step.when.negate === true,
        };
      }
      return editable;
    }),
  };
}

function addEntry(workflow, id = null) {
  const draft = editableWorkflow(workflow);
  const key = id || "draft-" + (++state.localNumber);
  const entry = { key, id, revision: workflow.revision, workflow: draft, dirty: !id, openSteps: new Set() };
  state.library.set(key, entry);
  return entry;
}

function renderHeading() {
  const workflow = currentEntry()?.workflow;
  byId("workflow-title").textContent = workflow?.name.trim() || "Untitled workflow";
  byId("workflow-subtitle").textContent = workflow?.description.trim() || "Build a workflow and inspect each run.";
  const count = workflow?.steps.length ?? 0;
  byId("step-count").textContent = count + (count === 1 ? " step" : " steps");
}

function refreshControls() {
  const active = currentEntry();
  const canEdit = workspaceTools.canEdit();
  const needsModel = active?.workflow.steps.some((step) => step.type === "prompt");
  const canRunLive = Boolean(state.config) && (!needsModel || state.config.liveConfigured);
  const live = byId("live-mode");
  byId("workflow-fields").disabled = !canEdit || !active || state.busy;
  byId("run-fields").disabled = !canEdit || !active || state.busy;
  byId("save-workflow").disabled = !canEdit || !active || state.busy || !active.dirty;
  byId("export-workflow").disabled = !active || state.busy;
  byId("open-planner").disabled = !canEdit || state.busy;
  byId("new-workflow").disabled = !canEdit || state.busy;
  byId("import-button").disabled = !canEdit || state.busy;
  byId("add-step").disabled = (active?.workflow.steps.length ?? 0) >= 32;
  live.disabled = !canRunLive;
  if (live.checked && !canRunLive) byId("run-form").elements.mode.value = "preview";
  byId("run-help").textContent = !canEdit ? "An editor or admin can start a run." : needsModel && !canRunLive
    ? "Preview works without a model key. Configure a provider for a live run."
    : "Rehearse in preview or run with the configured services.";
  byId("live-option").title = canRunLive ? "Use configured services" : "Configure a model provider for this workflow";
  byId("plan-live").disabled = !state.config?.liveConfigured;
  byId("start-run").disabled = !active?.workflow.steps.length || state.busy;
}

function renderLibrary() {
  const list = byId("workflow-list");
  list.replaceChildren();
  if (state.library.size === 0) list.append(element("p", "rail-empty", "No workflows yet."));
  for (const entry of state.library.values()) {
    const item = button("", "rail-item", () => {
      if (state.busy) return;
      selectWorkflow(entry.key);
      byId("workflow-name").focus();
    });
    item.setAttribute("aria-current", String(entry.key === state.selected));
    const icon = element("span", "rail-icon", "▤");
    icon.setAttribute("aria-hidden", "true");
    const count = entry.workflow.steps.length;
    const description = entry.dirty ? "Unsaved changes" : count + (count === 1 ? " step" : " steps");
    const title = element("strong", "", entry.workflow.name.trim() || "Untitled workflow");
    const subtitle = element("small", "", description);
    const text = element("span", "rail-text");
    text.append(title, subtitle);
    item.append(icon, text);
    list.append(item);
  }
}

function markDirty(entry) {
  entry.dirty = true;
  renderHeading();
  renderLibrary();
  graph.showWorkflow(entry);
  refreshControls();
}

function idForStep(workflow, type) {
  let suffix = 1;
  while (workflow.steps.some((s) => s.id === type + "_" + suffix)) suffix++;
  return type + "_" + suffix;
}

function field(id, text, binding, { multiline = false, max = 120, rows = 4 } = {}) {
  const label = element("label", "", text);
  label.htmlFor = id;
  const input = element(multiline ? "textarea" : "input");
  input.id = id;
  input.maxLength = max;
  input.value = binding.value;
  if (multiline) input.rows = rows;
  input.addEventListener("input", () => binding.change(input.value));
  return { label, input };
}

function changeOrder(entry, index, direction) {
  const steps = entry.workflow.steps;
  const target = index + direction;
  if (target < 0 || target >= steps.length) return;
  const step = steps[index];
  steps.splice(index, 1);
  steps.splice(target, 0, step);
  renderSteps(entry);
  markDirty(entry);
  document.getElementById("step-name-" + target)?.focus();
}

function connectorControl(step, index, entry) {
  const label = element("label", "", "Connector");
  const select = element("select");
  select.id = "step-connector-" + index;
  label.htmlFor = select.id;
  const hint = element("p", "step-hint");
  select.append(new Option("Choose a connector", ""));
  for (const connector of state.connectors) {
    select.append(new Option(connector.name + (connector.configured ? "" : " (not configured)"), connector.id));
  }
  if (step.connector && !state.connectors.some((connector) => connector.id === step.connector)) {
    select.append(new Option("Unavailable: " + step.connector, step.connector));
  }
  select.value = step.connector || "";

  function renderHint() {
    const selected = state.connectors.find((connector) => connector.id === select.value);
    hint.textContent = selected?.inputHint || "Connector inputs support the same variables as templates.";
  }

  select.addEventListener("change", () => {
    step.connector = select.value;
    renderHint();
    markDirty(entry);
  });
  renderHint();
  return [label, select, hint];
}

function conditionControl(step, index, entry) {
  const wrapper = element("div", "condition-control");
  const label = element("label", "check-label");
  const enabled = element("input");
  enabled.type = "checkbox";
  enabled.checked = Boolean(step.when);
  enabled.disabled = index === 0 && !step.when;
  label.append(enabled, document.createTextNode("Run only when a condition matches"));
  const fields = element("div", "condition-fields");
  fields.hidden = !step.when;
  const earlierLabel = element("label", "", "Earlier step");
  const earlier = element("select");
  earlier.id = "step-condition-" + index;
  earlierLabel.htmlFor = earlier.id;
  earlier.append(new Option("Select an earlier step", ""));
  const preceding = entry.workflow.steps.slice(0, index);
  for (const candidate of preceding) earlier.append(new Option(candidate.name, candidate.id));
  if (step.when?.step && !preceding.some((candidate) => candidate.id === step.when.step)) {
    earlier.append(new Option("Moved or missing: " + step.when.step, step.when.step));
  }
  earlier.value = step.when?.step || "";
  const operator = element("select");
  operator.setAttribute("aria-label", "Match operator");
  operator.append(new Option("Contains", "contains"), new Option("Does not contain", "excludes"));
  operator.value = step.when?.negate ? "excludes" : "contains";
  const search = element("input");
  search.setAttribute("aria-label", "Text to match");
  search.maxLength = 1000;
  search.placeholder = "Text to match";
  search.value = step.when?.includes || "";
  const match = element("div", "condition-input");
  match.append(operator, search);
  fields.append(earlierLabel, earlier, match);
  wrapper.append(label, fields);
  function matchChanged() {
    if (enabled.checked) step.when = { step: earlier.value, includes: search.value, negate: operator.value === "excludes" };
    else delete step.when;
    fields.hidden = !enabled.checked;
    markDirty(entry);
  }
  enabled.addEventListener("change", matchChanged);
  earlier.addEventListener("change", matchChanged);
  operator.addEventListener("change", matchChanged);
  search.addEventListener("input", matchChanged);
  return wrapper;
}

function renderSteps(entry) {
  const list = byId("steps");
  list.replaceChildren();
  const { steps } = entry.workflow;
  if (steps.length === 0) list.append(element("li", "step-empty", "Add a step to start building."));
  steps.forEach((step, index) => {
    const type = types[step.type];
    const row = element("li", "step");
    const details = element("details", "step-detail");
    const summary = element("summary", "step-summary");
    summary.id = "step-summary-" + index;
    const number = element("span", "step-index", String(index + 1).padStart(2, "0"));
    number.setAttribute("aria-hidden", "true");
    const icon = element("span", "step-icon " + step.type, type.marker);
    icon.setAttribute("aria-hidden", "true");
    const title = element("span", "step-summary-title");
    const stepName = element("span", "step-title", step.name.trim() || "Untitled step");
    title.append(stepName, element("span", "step-kind", type.label));
    summary.append(number, icon, title);
    const edits = element("div", "step-fields");
    const name = field("step-name-" + index, "Step name", {
      value: step.name,
      change(value) {
        step.name = value;
        stepName.textContent = value.trim() || "Untitled step";
        markDirty(entry);
      },
    });
    const template = field("step-template-" + index, type.field, {
      value: step.template,
      change(value) {
        step.template = value;
        markDirty(entry);
      },
    }, { multiline: true, max: 12000 });
    edits.append(name.label, name.input);
    if (step.type === "connector") edits.append(...connectorControl(step, index, entry));
    edits.append(template.label, template.input);
    edits.append(element("code", "", "Output variable: {{steps." + step.id + "}}"));
    edits.append(conditionControl(step, index, entry));
    const actions = element("div", "step-actions");
    const up = button("↑ Move up", "small-button", () => changeOrder(entry, index, -1));
    const down = button("↓ Move down", "small-button", () => changeOrder(entry, index, 1));
    up.disabled = index === 0;
    down.disabled = index === steps.length - 1;
    const remove = button("Remove", "small-button", () => {
      steps.splice(index, 1);
      entry.openSteps.delete(step.id);
      renderSteps(entry);
      markDirty(entry);
      byId("add-step").focus();
    });
    remove.setAttribute("aria-label", "Remove " + (step.name.trim() || "step " + (index + 1)));
    actions.append(up, down, remove);
    edits.append(actions);
    details.append(summary, edits);
    details.open = entry.openSteps.has(step.id);
    details.addEventListener("toggle", () => {
      if (details.open) entry.openSteps.add(step.id);
      else entry.openSteps.delete(step.id);
    });
    row.append(details);
    list.append(row);
  });
}

function selectWorkflow(key, showDraft = true) {
  const entry = state.library.get(key);
  if (!entry) return;
  state.selected = key;
  byId("workflow-name").value = entry.workflow.name;
  byId("workflow-description").value = entry.workflow.description;
  notify();
  renderHeading();
  renderLibrary();
  renderSteps(entry);
  graph.showWorkflow(entry, showDraft);
  refreshControls();
}

function newWorkflow() {
  const entry = addEntry({ name: "Untitled workflow", description: "", steps: [] });
  selectWorkflow(entry.key);
  byId("workflow-name").focus();
  byId("workflow-name").select();
}

async function persistWorkflow(entry) {
  if (entry.id && !entry.dirty) return entry.id;
  const target = entry.id ? "/api/workflows/" + encodeURIComponent(entry.id) : "/api/workflows";
  const body = entry.id ? { ...entry.workflow, revision: entry.revision } : entry.workflow;
  const result = await request(target, entry.id ? "PUT" : "POST", body);
  entry.workflow = editableWorkflow(result.workflow);
  entry.id = result.workflow.id || entry.id;
  entry.revision = result.workflow.revision;
  if (!entry.id) throw new Error("The server did not return a workflow ID.");
  entry.dirty = false;
  selectWorkflow(entry.key);
  return entry.id;
}

function renderRuntime() {
  const config = state.config;
  const demo = state.session?.enabled === false;
  const label = config?.liveConfigured ? (config.model || "Live model ready") : config ? "Preview ready" : "Runtime unavailable";
  byId("model-state").dataset.kind = demo ? "demo" : config ? "ready" : "error";
  byId("model-label").textContent = demo ? "Demo · " + label : label;
  refreshControls();
}

function renderConnectors() {
  const list = byId("connector-list");
  const search = byId("connector-search").value.toLowerCase().trim();
  const filtered = state.connectors.filter((connector) => [connector.name, connector.id, connector.description].join(" ").toLowerCase().includes(search));
  byId("connector-count").textContent = String(state.connectors.length);
  list.replaceChildren();
  if (!filtered.length) list.append(element("li", "muted", search ? "No connectors match your search." : "No connectors available."));
  for (const connector of filtered) {
    const item = element("li");
    const name = element("div", "connector-name");
    name.append(element("strong", "", connector.name), element("span", "", connector.configured ? "Configured" : "Needs setup"));
    item.append(name, element("p", "", connector.description));
    list.append(item);
  }
}

function runSource(source) {
  if (source?.type === "schedule") return "Scheduled";
  if (source?.type === "webhook") return "Webhook";
  return source?.username ? "Started by " + source.username : "";
}

function renderHistory() {
  const list = byId("run-list");
  list.replaceChildren();
  if (!state.runs.length) list.append(element("p", "rail-empty", "No runs yet."));
  for (const run of state.runs) {
    const item = button("", "rail-item", async () => {
      if (state.busy) return;
      try {
        await openRun(run.id);
      } catch (error) {
        showError(error);
      }
    });
    item.setAttribute("aria-current", String(state.selectedRunId === run.id));
    const label = run.workflowName || "Workflow run";
    const status = statusNames[run.status] || run.status;
    const mode = run.mode === "live" ? "Live" : "Preview";
    item.title = label + ": " + status + " · " + shortDate(run.createdAt);
    const dot = element("span", "history-dot " + run.status);
    dot.setAttribute("aria-hidden", "true");
    const text = element("span", "rail-text");
    text.append(element("strong", "", label), element("small", "", [status, runSource(run.source) || mode].join(" · ")));
    item.append(dot, text);
    list.append(item);
  }
}

function renderMetrics(metrics) {
  const format = new Intl.NumberFormat();
  const fraction = typeof metrics.successRate === "number" ? metrics.successRate : null;
  const values = [
    ["Total runs", metrics.runs],
    ["Awaiting review", metrics.awaitingApproval],
    ["Success rate", fraction === null ? "—" : new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 1 }).format(fraction)],
    ["Model tokens", metrics.totalTokens],
  ];
  const grid = byId("run-metrics");
  grid.replaceChildren();
  for (const [label, value] of values) {
    const metric = element("div");
    const displayed = typeof value === "number" ? format.format(value) : value ?? "—";
    metric.append(element("dt", "", label), element("dd", "", displayed));
    grid.append(metric);
  }
}

async function refreshHistory() {
  const [history, metrics] = await Promise.allSettled([request("/api/runs"), request("/api/metrics")]);
  if (history.status === "fulfilled") {
    state.runs = history.value.runs;
    state.lastHistoryRefresh = Date.now();
    renderHistory();
  } else {
    throw history.reason;
  }
  if (metrics.status === "fulfilled") renderMetrics(metrics.value);
}

function outputText(output) {
  if (typeof output === "string") return output;
  if (typeof output?.text === "string") return output.text;
  return JSON.stringify(output, null, 2);
}

function approvalBox(run) {
  const block = element("div", "approval-box");
  block.append(element("h3", "", "Approval requested"), element("p", "", run.pendingApproval.message));
  if (!workspaceTools.canEdit()) {
    block.append(element("p", "muted", "An editor or admin can review this step."));
    return block;
  }
  const notes = field("review-note", "Reviewer note (optional)", {
    value: "", change() {},
  }, { multiline: true, rows: 2, max: 2000 });
  const actions = element("div", "approval-actions");
  const approve = button("Approve", "button primary", () => decide(true));
  const reject = button("Reject", "button danger", () => decide(false));
  actions.append(approve, reject);
  block.append(notes.label, notes.input, actions);

  async function decide(approved) {
    if (state.busy || state.selectedRunId !== run.id) return;
    approve.disabled = true;
    reject.disabled = true;
    state.busy = true;
    refreshControls();
    try {
      const data = await request("/api/runs/" + encodeURIComponent(run.id) + "/decision", "POST", {
        approve: approved, note: notes.input.value,
      });
      showRun(data.run);
      await refreshHistory();
    } catch (error) {
      showError(error);
      approve.disabled = false;
      reject.disabled = false;
    } finally {
      state.busy = false;
      refreshControls();
    }
  }
  return block;
}

function timeline(run, stepNames) {
  const section = element("section", "run-section");
  section.append(element("h3", "", "Timeline"));
  const list = element("ol", "timeline");
  for (const event of run.events || []) {
    const item = element("li");
    const title = (event.type || "event").replace(/_/g, " ");
    const step = stepNames.get(event.stepId);
    item.append(element("span", "event-title", (step ? step + " · " : "") + title.charAt(0).toUpperCase() + title.slice(1)));
    const detail = [event.message, Number.isFinite(event.durationMs) ? Math.round(event.durationMs) + " ms" : null];
    if (event.usage) {
      const { inputTokens, outputTokens } = event.usage;
      if (Number.isFinite(inputTokens)) detail.push(inputTokens + " input tokens");
      if (Number.isFinite(outputTokens)) detail.push(outputTokens + " output tokens");
    }
    const actor = event.actor?.username || event.username;
    if (actor) detail.push(actor);
    const description = detail.filter(Boolean).join(" · ");
    if (description) item.append(element("span", "event-details", description));
    const time = element("time", "", shortDate(event.at));
    if (event.at) time.dateTime = event.at;
    item.append(time);
    list.append(item);
  }
  if (list.childElementCount) section.append(list);
  else section.append(element("p", "muted", "Waiting for the first event."));
  return section;
}

function showRun(run, showTrace = false) {
  if (state.selectedRunId !== run.id) return;
  const prior = state.run;
  if (prior?.id === run.id && prior.updatedAt === run.updatedAt &&
    prior.status === run.status && prior.events?.length === run.events?.length) {
    if (showTrace) graph.showRun(run, true);
    return;
  }
  state.run = run;
  graph.showRun(run, showTrace);
  const content = byId("run-content");
  const previouslyOpen = new Set([...content.querySelectorAll(".output[open]")].map((item) => item.dataset.step));
  const pill = byId("run-status");
  pill.hidden = false;
  pill.textContent = statusNames[run.status] || run.status;
  pill.className = "state-pill " + run.status;
  const mode = run.mode === "live" ? "Live" : "Preview";
  byId("inspector-meta").textContent = [run.workflow?.name, mode, runSource(run.source), shortDate(run.createdAt)].filter(Boolean).join(" · ");
  content.replaceChildren();
  if (run.pendingApproval) content.append(approvalBox(run));
  if (run.error) content.append(element("p", "run-error", typeof run.error === "string" ? run.error : run.error.message));
  const stepNames = new Map((run.workflow?.steps || []).map((step) => [step.id, step.name]));
  const outputs = Object.entries(run.outputs || {});
  if (outputs.length) {
    const section = element("section", "run-section");
    section.append(element("h3", "", "Outputs"));
    outputs.forEach(([id, value], index) => {
      const item = element("details", "output");
      item.dataset.step = id;
      item.open = previouslyOpen.has(id) || (!previouslyOpen.size && index === outputs.length - 1);
      item.append(element("summary", "", stepNames.get(id) || id), element("pre", "", outputText(value)));
      section.append(item);
    });
    content.append(section);
  }
  content.append(timeline(run, stepNames));
}

async function openRun(id) {
  state.selectedRunId = id;
  renderHistory();
  const data = await request("/api/runs/" + encodeURIComponent(id));
  showRun(data.run, true);
}

async function pollRuns() {
  if (!state.ready || state.polling || state.busy || document.hidden) return;
  const current = state.run;
  const watchingRun = current?.id === state.selectedRunId && (current?.status === "running" || current?.status === "awaiting_approval");
  const readRun = watchingRun && (current.status === "running" || Date.now() - state.lastRunRefresh >= 3500);
  const otherRunning = state.runs.some((run) => run.status === "running");
  const readHistory = Date.now() - state.lastHistoryRefresh >= (otherRunning ? 3500 : 7500);
  if (!readRun && !readHistory) return;
  state.polling = true;
  let changed = false;
  try {
    if (readRun) {
      const data = await request("/api/runs/" + encodeURIComponent(current.id));
      state.lastRunRefresh = Date.now();
      if (!state.busy) showRun(data.run);
      changed = data.run.status !== current.status;
    }
    if (readHistory || changed) await refreshHistory();
  } catch (error) {
    showError(error);
  } finally {
    state.polling = false;
  }
}

byId("new-workflow").addEventListener("click", newWorkflow);
byId("connector-search").addEventListener("input", renderConnectors);
byId("workflow-name").addEventListener("input", (event) => {
  const entry = currentEntry();
  entry.workflow.name = event.target.value;
  markDirty(entry);
});
byId("workflow-description").addEventListener("input", (event) => {
  const entry = currentEntry();
  entry.workflow.description = event.target.value;
  markDirty(entry);
});
byId("add-step").addEventListener("click", () => {
  const entry = currentEntry();
  const type = byId("step-type").value;
  const id = idForStep(entry.workflow, type);
  const template = type === "approval" ? "Review the workflow output and record your decision." : "{{input}}";
  const step = { id, name: types[type].label, type, template };
  if (type === "connector") step.connector = state.connectors.find((connector) => connector.configured)?.id || "";
  entry.workflow.steps.push(step);
  entry.openSteps.add(id);
  renderSteps(entry);
  markDirty(entry);
  byId("step-name-" + (entry.workflow.steps.length - 1)).focus();
});
byId("workflow-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.busy) return;
  state.busy = true;
  refreshControls();
  try {
    await persistWorkflow(currentEntry());
    notify("Workflow saved.");
  } catch (error) {
    showError(error);
  } finally {
    state.busy = false;
    refreshControls();
  }
});
byId("run-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.busy) return;
  const brief = byId("run-input").value;
  const mode = new FormData(event.currentTarget).get("mode");
  notify();
  state.busy = true;
  refreshControls();
  try {
    const workflowId = await persistWorkflow(currentEntry());
    const data = await request("/api/runs", "POST", { workflowId, input: brief, mode });
    state.selectedRunId = data.run.id;
    showRun(data.run, true);
    await refreshHistory();
    if (matchMedia("(max-width: 885px)").matches) byId("inspector").scrollIntoView({ block: "start" });
  } catch (error) {
    showError(error);
  } finally {
    state.busy = false;
    refreshControls();
  }
});
byId("refresh-history").addEventListener("click", async () => {
  try {
    await refreshHistory();
    if (state.selectedRunId) await openRun(state.selectedRunId);
  } catch (error) {
    showError(error);
  }
});
byId("import-button").addEventListener("click", () => byId("import-file").click());
byId("import-file").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  event.target.value = "";
  if (!file) return;
  try {
    if (file.size > 2_000_000) throw new Error("Choose a JSON file under 2 MB.");
    const entry = addEntry(JSON.parse(await file.text()));
    selectWorkflow(entry.key);
    notify("Imported an editable draft.");
  } catch (error) {
    showError(error);
  }
});
byId("export-workflow").addEventListener("click", () => {
  const { workflow } = currentEntry();
  const content = JSON.stringify(workflow, null, 2) + "\n";
  const href = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const link = element("a");
  link.href = href;
  link.download = (workflow.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workflow") + ".json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
});
byId("open-planner").addEventListener("click", () => byId("planner-dialog").showModal());
byId("close-planner").addEventListener("click", () => byId("planner-dialog").close());
byId("planner-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = byId("generate-plan");
  const status = byId("plan-status");
  const goal = byId("plan-goal").value.trim();
  if (!goal) return;
  submit.disabled = true;
  status.textContent = "Preparing a draft…";
  try {
    const mode = byId("plan-mode").value;
    const result = await request("/api/plans", "POST", { goal, mode });
    const entry = addEntry(result.workflow);
    selectWorkflow(entry.key);
    byId("planner-dialog").close();
    status.textContent = "";
    notify(typeof result.summary === "string" ? result.summary : "The plan is ready to edit.");
    byId("workflow-name").focus();
  } catch (error) {
    status.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

const snippet = [
  'import { createClient } from "./src/sdk.mjs";',
  "",
  'const client = createClient("http://127.0.0.1:4387");',
  "const [workflow] = await client.listWorkflows();",
  'const run = await client.startRun({ workflowId: workflow.id, input: "Review this brief" });',
  "const result = await client.waitForRun(run.id);",
  "console.log(result.status, result.outputs);",
].join("\n");
byId("sdk-code").textContent = snippet;
byId("open-sdk").addEventListener("click", () => {
  const enabled = state.session?.enabled;
  byId("sdk-help").textContent = enabled ? "Programmatic requests must include a valid session cookie. See the SDK setup in the repository README." : "With Agent007 running, save this snippet as a JavaScript module in the project root and run it with Node.js 24.";
  byId("sdk-dialog").showModal();
});
byId("close-sdk").addEventListener("click", () => byId("sdk-dialog").close());
byId("copy-sdk").addEventListener("click", async () => {
  const status = byId("sdk-status");
  try {
    await navigator.clipboard.writeText(snippet);
    status.textContent = "Copied.";
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(byId("sdk-code"));
    selection.removeAllRanges();
    selection.addRange(range);
    status.textContent = "Snippet selected for copying.";
  }
});
window.addEventListener("beforeunload", (event) => {
  if ([...state.library.values()].some((entry) => entry.dirty)) event.preventDefault();
});

const graph = createGraph({
  types,
  inspect(stepId, trace) {
    if (trace) {
      const content = byId("run-content");
      const output = [...content.querySelectorAll(".output")].find((item) => item.dataset.step === stepId);
      const target = output?.querySelector("summary") || byId("inspector-title");
      if (output) output.open = true;
      if (!output) target.tabIndex = -1;
      target.focus();
      return;
    }
    const entry = currentEntry();
    const index = entry?.workflow.steps.findIndex((step) => step.id === stepId);
    const summary = byId("step-summary-" + index);
    if (!summary) return;
    summary.parentElement.open = true;
    summary.focus();
  },
});

function clearWorkspace() {
  state.sessionVersion++;
  state.ready = false;
  state.library.clear();
  state.runs = [];
  state.selected = null;
  state.selectedRunId = null;
  state.run = null;
  state.connectors = [];
  state.config = null;
  state.session = null;
  state.busy = false;
  state.lastHistoryRefresh = 0;
  state.lastRunRefresh = 0;
  byId("workflow-form").reset();
  byId("run-form").reset();
  byId("planner-form").reset();
  byId("steps").replaceChildren();
  byId("run-content").replaceChildren(element("p", "muted", "Start a run or select one from history."));
  byId("inspector-meta").textContent = "Output and decisions appear here.";
  byId("run-status").hidden = true;
  byId("connector-search").value = "";
  notify();
  renderHeading();
  renderLibrary();
  renderHistory();
  renderConnectors();
  renderMetrics({});
  graph.showRun(null);
  graph.showWorkflow(null, true);
}

async function initialize(session) {
  state.session = session;
  const version = state.sessionVersion;
  const [config, workflows, connectors, history] = await Promise.allSettled([
    request("/api/config"),
    request("/api/workflows"),
    request("/api/connectors"),
    refreshHistory(),
  ]);
  if (version !== state.sessionVersion) return;
  if (config.status === "fulfilled") state.config = config.value;
  if (connectors.status === "fulfilled") state.connectors = connectors.value.connectors;
  renderRuntime();
  renderConnectors();
  if (workflows.status === "fulfilled") {
    for (const workflow of workflows.value.workflows) addEntry(workflow, workflow.id);
    const first = state.library.values().next().value;
    if (first) selectWorkflow(first.key);
    else if (workspaceTools.canEdit()) newWorkflow();
  } else {
    renderLibrary();
    showError(workflows.reason);
  }
  if (history.status === "rejected") byId("run-list").replaceChildren(element("p", "rail-empty", "Run history unavailable."));
  state.ready = true;
}

const workspaceTools = createWorkspaceTools({
  request, element, button, formatDate: shortDate,
  getWorkflows: () => [...state.library.values()].filter((entry) => entry.id),
  canRunLive(workflowId) {
    const entry = [...state.library.values()].find((candidate) => candidate.id === workflowId);
    return Boolean(state.config && entry && (state.config.liveConfigured || !entry.workflow.steps.some((step) => step.type === "prompt")));
  },
  onReady: initialize,
  onLock: clearWorkspace,
});
setInterval(pollRuns, 1300);
workspaceTools.start();
