const stepStates = {
  step_started: "Running",
  step_completed: "Completed",
  step_skipped: "Skipped",
  run_failed: "Failed",
  approval_requested: "Awaiting approval",
  approval_granted: "Approved",
  approval_rejected: "Rejected",
};

function node(tag, className, text) {
  const result = document.createElement(tag);
  result.className = className;
  if (text) result.textContent = text;
  return result;
}

function dependencies(steps) {
  const positions = new Map(steps.map((step, index) => [step.id, index + 1]));
  return steps.flatMap((step, index) => {
    const to = index + 1;
    const sources = new Set(Array.from(step.template.matchAll(/{{\s*(input|steps\.([a-zA-Z][a-zA-Z\d_-]{0,63}))\s*}}/g), (match) => match[2]));
    const dataEdges = Array.from(sources, (source) => ({ from: source === undefined ? 0 : positions.get(source), to, kind: "data" }))
      .filter((edge) => edge.from !== undefined && edge.from < to);
    const from = positions.get(step.when?.step);
    return from !== undefined && from < to ? [...dataEdges, { from, to, kind: "condition" }] : dataEdges;
  });
}

function drawLinks(canvas, row, cards, edges) {
  const { width, height } = row.parentElement.getBoundingClientRect();
  if (!width || !height || cards.length === 0) return;
  const density = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * density);
  canvas.height = Math.round(height * density);
  const context = canvas.getContext("2d");
  if (!context) return;
  context.scale(density, density);
  const origin = row.parentElement.getBoundingClientRect();
  const points = cards.map((card) => {
    const bounds = card.getBoundingClientRect();
    const x = bounds.left - origin.left;
    const y = bounds.top - origin.top;
    return { x, y, right: x + bounds.width, cx: x + bounds.width / 2, cy: y + bounds.height / 2 };
  });

  function wire(startX, startY, endX, endY, lane) {
    context.beginPath();
    context.moveTo(startX, startY);
    if (lane === undefined) context.lineTo(endX, endY);
    else context.bezierCurveTo(startX + 12, lane, endX - 12, lane, endX, endY);
    context.stroke();
    context.beginPath();
    context.arc(endX, endY, 2.4, 0, Math.PI * 2);
    context.fillStyle = context.strokeStyle;
    context.fill();
  }

  context.strokeStyle = "#3ad6fc";
  context.lineWidth = 1.5;
  points.slice(1).forEach((point, index) => wire(points[index].right, point.cy, point.x, point.cy));
  edges.forEach((edge, index) => {
    const start = points[edge.from];
    const end = points[edge.to];
    context.strokeStyle = edge.kind === "condition" ? "#ffc57b" : "#a392fa";
    context.setLineDash(edge.kind === "condition" ? [4, 4] : []);
    const lane = Math.max(0, start.y - 19 - ((index % 3) * 10));
    const offset = edge.kind === "condition" ? 11 : -11;
    wire(start.cx + offset, start.y, end.cx + offset, end.y, lane);
  });
}

export function createGraph({ types, inspect }) {
  const surface = document.getElementById("graph-canvas");
  const viewport = document.getElementById("graph-scroll");
  const workflowButton = document.getElementById("graph-draft");
  const traceButton = document.getElementById("graph-run");
  const detail = document.getElementById("graph-detail");
  const inspectButton = document.getElementById("graph-inspect");
  const caption = document.getElementById("graph-caption");
  let view = "workflow";
  let selected = null;
  let active = null;
  let run = null;
  let cards = [];
  let redraw = () => {};
  const observer = new ResizeObserver(() => redraw());
  observer.observe(surface);

  function showSelection(steps, statusById) {
    const step = steps.find((candidate) => candidate.id === selected);
    const matches = (id) => steps.find((candidate) => candidate.id === id)?.name || id;
    const lines = [];
    if (step?.when?.step) {
      const operator = step.when.negate ? "excludes" : "contains";
      lines.push(`Runs when ${matches(step.when.step)} ${operator} “${step.when.includes}”`);
    }
    if (step && statusById.has(step.id)) lines.push(statusById.get(step.id));
    const summary = step ? [step.name.trim() || "Untitled step", ...lines].join(" · ") : "Select a step to inspect it.";
    if (detail.textContent !== summary) detail.textContent = summary;
    inspectButton.hidden = !step;
    inspectButton.textContent = view === "trace" ? "Open run details" : "Open in editor";
    cards.forEach((card) => {
      if (card.tagName === "BUTTON") card.setAttribute("aria-pressed", String(card.dataset.node === selected));
    });
  }

  function render() {
    const focusedId = surface.contains(document.activeElement) ? document.activeElement.dataset.node : null;
    const workflow = view === "trace" ? run?.workflow : active?.workflow;
    const steps = workflow?.steps || [];
    const statusById = new Map();
    if (view === "trace") {
      for (const event of run?.events || []) {
        if (event.stepId && stepStates[event.type]) statusById.set(event.stepId, stepStates[event.type]);
      }
      if (run?.pendingApproval?.stepId) statusById.set(run.pendingApproval.stepId, "Awaiting approval");
      for (const step of steps) {
        if (!statusById.has(step.id) && Object.hasOwn(run?.outputs || {}, step.id)) statusById.set(step.id, "Completed");
      }
    }
    if (!steps.some((step) => step.id === selected)) selected = null;
    workflowButton.setAttribute("aria-pressed", String(view === "workflow"));
    traceButton.setAttribute("aria-pressed", String(view === "trace"));
    traceButton.disabled = !run?.workflow;
    caption.textContent = view === "trace" && run?.workflow ? `Run snapshot · ${run.workflow.name}` : "Step order, data inputs, and conditions.";
    cards = [];
    surface.replaceChildren();
    redraw = () => {};
    if (steps.length === 0) {
      surface.append(node("p", "graph-empty", "Add a workflow step to see the graph."));
      showSelection(steps, statusById);
      return;
    }

    const canvas = node("canvas", "graph-wires");
    canvas.setAttribute("aria-hidden", "true");
    const row = node("ol", "graph-row");
    function addCard(card) {
      const item = node("li", "graph-item");
      item.append(card);
      row.append(item);
      cards.push(card);
    }
    function endpoint(label, icon, text) {
      const terminal = node("div", "graph-terminal");
      const marker = node("span", "graph-terminal-icon", icon);
      marker.setAttribute("aria-hidden", "true");
      terminal.append(marker, node("strong", "", label), node("small", "", text));
      return terminal;
    }
    addCard(endpoint("Input", "↳", "Run brief"));
    steps.forEach((step) => {
      const type = types[step.type];
      const card = node("button", `graph-step graph-${step.type}`);
      card.type = "button";
      card.dataset.node = step.id;
      card.addEventListener("click", () => {
        selected = step.id;
        showSelection(steps, statusById);
      });
      const top = node("span", "graph-node-meta");
      const marker = node("i", "", type?.marker || "·");
      marker.setAttribute("aria-hidden", "true");
      top.append(marker, node("span", "", type?.label || step.type));
      card.append(top, node("strong", "", step.name.trim() || "Untitled step"));
      if (view === "trace") {
        const status = statusById.get(step.id) || "Not reached";
        const badge = node("span", "graph-node-status", status);
        badge.dataset.state = status;
        card.append(badge);
      } else if (step.when) card.append(node("span", "graph-node-condition", "Conditional"));
      addCard(card);
    });
    addCard(endpoint("Output", "↗", "Run record"));
    surface.append(canvas, row);
    const edges = dependencies(steps);
    redraw = () => drawLinks(canvas, row, cards, edges);
    redraw();
    showSelection(steps, statusById);
    if (focusedId) cards.find((card) => card.dataset.node === focusedId)?.focus({ preventScroll: true });
  }

  function changeView(next) {
    view = next;
    selected = null;
    viewport.scrollLeft = 0;
    render();
  }

  workflowButton.addEventListener("click", () => changeView("workflow"));
  traceButton.addEventListener("click", () => changeView("trace"));
  inspectButton.addEventListener("click", () => inspect(selected, view === "trace"));

  return {
    showWorkflow(entry, switchView = false) {
      const changed = entry?.key !== active?.key;
      active = entry;
      if (changed || switchView) changeView("workflow");
      else if (view === "workflow") render();
    },
    showRun(next, switchView = false) {
      run = next;
      if (switchView) changeView("trace");
      else render();
    },
  };
}
