const byId = (id) => document.getElementById(id);
const roles = { admin: "Admin", editor: "Editor", viewer: "Viewer" };

function message(id, text = "", kind = "error") {
  const status = byId(id);
  status.textContent = text;
  status.dataset.kind = kind;
}

function value(id) {
  return byId(id).value;
}

function route(collection, id) {
  return `/api/${collection}/${encodeURIComponent(id)}`;
}

export function createWorkspaceTools({ request, element, button, getWorkflows, canRunLive, onReady, onLock, formatDate }) {
  let session = null;
  let triggerEdit = null;
  let userEdit = null;
  let webhookExample = "";

  function visibleStudio(visible) {
    for (const id of ["studio-shell", "topbar-nav", "topbar-detail", "skip-workspace"]) byId(id).hidden = !visible;
    byId("access-screen").hidden = visible;
  }

  function showAccess(expired = false) {
    const setup = session?.setupRequired;
    visibleStudio(false);
    document.querySelectorAll("dialog[open]").forEach((dialog) => dialog.close());
    onLock();
    byId("access-form").reset();
    byId("access-form").hidden = Boolean(setup && !session.setupAvailable);
    byId("access-token-field").hidden = !setup;
    byId("access-token").required = Boolean(setup);
    byId("access-password").autocomplete = setup ? "new-password" : "current-password";
    byId("access-password").minLength = setup ? 12 : 1;
    byId("access-title").textContent = setup ? "Set up Agent007" : "Sign in to Agent007";
    byId("access-submit").textContent = setup ? "Create admin account" : "Sign in";
    byId("access-help").textContent = setup ? (session.setupAvailable
      ? "Use your setup token to create the first workspace administrator."
      : "Set AGENT007_SETUP_TOKEN in the server environment and restart Agent007, then reload this page.")
      : "Access your workflows, triggers, and run history.";
    message("access-status", expired ? "Your session expired. Sign in again to continue." : "");
    if (expired) byId("access-title").focus();
  }

  function applyAccount() {
    const user = session?.user;
    byId("open-account").hidden = !user;
    byId("user-admin").hidden = user?.role !== "admin";
    if (!user) return;
    byId("account-avatar").textContent = Array.from(user.username)[0]?.toUpperCase() || "·";
    byId("account-label").textContent = user.username;
    byId("account-summary").textContent = `${user.username} · ${roles[user.role]}`;
  }

  function applySession(next) {
    session = next;
    if (!session.enabled || session.user) {
      applyAccount();
      visibleStudio(true);
      return onReady(session);
    }
    showAccess();
  }

  function onSubmit(id, statusId, action) {
    byId(id).addEventListener("submit", async (event) => {
      event.preventDefault();
      const submit = event.currentTarget.querySelector("button[type=submit]");
      if (submit.disabled) return;
      submit.disabled = true;
      message(statusId);
      try {
        await action();
      } catch (error) {
        message(statusId, error.message);
      } finally {
        submit.disabled = false;
      }
    });
  }

  onSubmit("access-form", "access-status", async () => {
    const credentials = { username: value("access-username").trim(), password: value("access-password") };
    try {
      const next = session?.setupRequired
        ? await request("/api/auth/setup", "POST", { ...credentials, setupToken: value("access-token") })
        : await request("/api/auth/login", "POST", credentials);
      await applySession(next);
      byId("workspace").focus();
    } finally {
      byId("access-password").value = "";
      byId("access-token").value = "";
    }
  });

  function canEdit() {
    return session?.enabled === false || session?.user?.role === "admin" || session?.user?.role === "editor";
  }

  function clearWebhook() {
    webhookExample = "";
    byId("trigger-secret-box").hidden = true;
    byId("trigger-url").textContent = "";
    byId("trigger-secret").textContent = "";
  }

  function revealWebhook(trigger, secret) {
    if (!byId("trigger-dialog").open) return;
    const url = new URL(route("webhooks", trigger.id), location.origin).href;
    byId("trigger-url").textContent = url;
    byId("trigger-secret").textContent = secret;
    byId("trigger-secret-box").hidden = false;
    webhookExample = `curl -X POST '${url}' -H 'Authorization: Bearer ${secret}' -H 'Content-Type: application/json' -d '{}'`;
  }

  function triggerTypeChanged() {
    const schedule = value("trigger-type") === "schedule";
    byId("trigger-interval-field").hidden = !schedule;
    byId("trigger-interval").required = schedule;
  }

  function refreshWorkflowOptions(selected) {
    const select = byId("trigger-workflow");
    const workflows = getWorkflows();
    select.replaceChildren(new Option(workflows.length ? "Select a saved workflow" : "Save a workflow first", ""));
    workflows.forEach((entry) => select.append(new Option(entry.workflow.name, entry.id)));
    select.value = workflows.some((entry) => entry.id === selected) ? selected : "";
    byId("save-trigger").disabled = workflows.length === 0;
  }

  function editTrigger(trigger) {
    triggerEdit = trigger?.id || null;
    byId("trigger-form").reset();
    refreshWorkflowOptions(trigger?.workflowId);
    byId("trigger-type").disabled = Boolean(trigger);
    byId("trigger-type").value = trigger?.type || "schedule";
    byId("trigger-live").disabled = !canRunLive(trigger?.workflowId ?? value("trigger-workflow"));
    byId("trigger-mode").value = trigger?.mode || "preview";
    byId("trigger-name").value = trigger?.name || "";
    byId("trigger-input").value = trigger?.input || "";
    byId("trigger-interval").value = trigger?.intervalMinutes ?? 60;
    byId("trigger-form-title").textContent = trigger ? "Edit trigger" : "Create a trigger";
    byId("save-trigger").textContent = trigger ? "Save trigger" : "Create trigger";
    byId("cancel-trigger").hidden = !trigger;
    triggerTypeChanged();
  }

  async function refreshTriggers() {
    const { triggers } = await request("/api/triggers");
    const list = byId("trigger-list");
    const workflows = new Map(getWorkflows().map((entry) => [entry.id, entry.workflow.name]));
    list.replaceChildren();
    if (!triggers.length) list.append(element("p", "muted", "No triggers configured."));
    for (const trigger of triggers) {
      const item = element("article", "management-item");
      const type = trigger.type === "schedule" ? `Every ${trigger.intervalMinutes} min` : "Webhook";
      const mode = trigger.mode === "live" ? "Live" : "Preview";
      item.append(element("strong", "", trigger.name), element("p", "muted", `${type} · ${mode} · ${trigger.enabled ? "Enabled" : "Paused"}`));
      if (workflows.has(trigger.workflowId)) item.append(element("p", "muted", workflows.get(trigger.workflowId)));
      if (trigger.type === "webhook") item.append(element("code", "", route("webhooks", trigger.id)));
      if (trigger.nextAt && trigger.enabled) item.append(element("p", "muted", `Next run ${formatDate(trigger.nextAt)}`));
      if (trigger.lastError) item.append(element("p", "run-error", trigger.lastError));
      if (canEdit()) {
        const actions = element("div", "management-actions");
        actions.append(button("Edit", "small-button", () => {
          editTrigger(trigger);
          byId("trigger-name").focus();
        }));
        actions.append(button(trigger.enabled ? "Pause" : "Enable", "small-button", () => updateTrigger(async () => {
          await request(route("triggers", trigger.id), "PATCH", { enabled: !trigger.enabled });
        })));
        if (trigger.type === "webhook") actions.append(button("Rotate secret", "small-button", () => {
          if (!confirm(`Rotate the secret for “${trigger.name}”? The current secret will stop working.`)) return;
          updateTrigger(async () => {
            const result = await request(`${route("triggers", trigger.id)}/rotate`, "POST", {});
            revealWebhook(result.trigger, result.secret);
          });
        }));
        actions.append(button("Delete", "small-button destructive", () => {
          if (!confirm(`Delete the trigger “${trigger.name}”?`)) return;
          updateTrigger(async () => {
            await request(route("triggers", trigger.id), "DELETE");
            clearWebhook();
            if (triggerEdit === trigger.id) editTrigger(null);
          });
        }));
        item.append(actions);
      }
      list.append(item);
    }
  }

  async function updateTrigger(action = refreshTriggers) {
    message("trigger-status");
    try {
      await action();
      if (action !== refreshTriggers) await refreshTriggers();
    } catch (error) {
      message("trigger-status", error.message);
    }
  }

  byId("open-triggers").addEventListener("click", () => {
    byId("trigger-dialog").showModal();
    byId("trigger-editor").hidden = !canEdit();
    byId("trigger-list").replaceChildren(element("p", "muted", "Loading triggers…"));
    editTrigger(null);
    updateTrigger();
  });
  byId("trigger-dialog").addEventListener("close", () => {
    clearWebhook();
    byId("trigger-form").reset();
    message("trigger-status");
  });
  byId("trigger-type").addEventListener("change", triggerTypeChanged);
  byId("trigger-workflow").addEventListener("change", () => {
    byId("trigger-live").disabled = !canRunLive(value("trigger-workflow"));
    if (byId("trigger-live").disabled) byId("trigger-mode").value = "preview";
  });
  byId("cancel-trigger").addEventListener("click", () => editTrigger(null));
  byId("hide-webhook").addEventListener("click", clearWebhook);
  byId("copy-webhook").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(webhookExample);
      message("trigger-status", "Copied curl example.", "success");
    } catch {
      message("trigger-status", "Clipboard unavailable. Select and copy the URL and token above.");
    }
  });
  onSubmit("trigger-form", "trigger-status", async () => {
    const type = value("trigger-type");
    const body = { name: value("trigger-name").trim(), workflowId: value("trigger-workflow"), mode: value("trigger-mode"), input: value("trigger-input") };
    if (type === "schedule") body.intervalMinutes = Number(value("trigger-interval"));
    const result = triggerEdit ? await request(route("triggers", triggerEdit), "PATCH", body) : await request("/api/triggers", "POST", { ...body, type });
    if (result.secret) revealWebhook(result.trigger, result.secret);
    else clearWebhook();
    editTrigger(null);
    await refreshTriggers();
    message("trigger-status", "Trigger saved.", "success");
  });

  function editUser(user) {
    userEdit = user?.id || null;
    byId("user-form").reset();
    byId("user-name").value = user?.username || "";
    byId("user-name").disabled = Boolean(user);
    byId("user-password").required = !user;
    byId("user-password").placeholder = user ? "Leave blank to keep current password" : "";
    byId("user-role").value = user?.role || "editor";
    byId("user-form-title").textContent = user ? "Edit member" : "Add a member";
    byId("save-user").textContent = user ? "Save member" : "Add member";
    byId("cancel-user").hidden = !user;
  }

  async function refreshUsers() {
    const { users } = await request("/api/users");
    const list = byId("user-list");
    list.replaceChildren();
    for (const user of users) {
      const item = element("article", "management-item");
      item.append(element("strong", "", user.username), element("p", "muted", `${roles[user.role]} · ${user.enabled ? "Active" : "Disabled"}`));
      if (user.id !== session?.user?.id) {
        const actions = element("div", "management-actions");
        actions.append(button("Edit", "small-button", () => {
          editUser(user);
          byId("user-password").focus();
        }));
        actions.append(button(user.enabled ? "Disable" : "Enable", "small-button", async () => {
          try {
            await request(route("users", user.id), "PATCH", { enabled: !user.enabled });
            if (userEdit === user.id) editUser(null);
            await refreshUsers();
            message("account-status", "Member updated.", "success");
          } catch (error) {
            message("account-status", error.message);
          }
        }));
        item.append(actions);
      }
      list.append(item);
    }
  }

  byId("open-account").addEventListener("click", async () => {
    byId("account-dialog").showModal();
    if (session?.user?.role !== "admin") return;
    byId("user-list").replaceChildren(element("p", "muted", "Loading members…"));
    editUser(null);
    try {
      await refreshUsers();
    } catch (error) {
      message("account-status", error.message);
    }
  });
  byId("account-dialog").addEventListener("close", () => {
    byId("password-form").reset();
    byId("user-form").reset();
    message("account-status");
  });
  byId("sign-out").addEventListener("click", async () => {
    try {
      await request("/api/auth/logout", "POST", {});
      session = { ...session, user: null };
      showAccess();
      byId("access-username").focus();
    } catch (error) {
      message("account-status", error.message);
    }
  });
  byId("cancel-user").addEventListener("click", () => editUser(null));
  onSubmit("user-form", "account-status", async () => {
    const password = value("user-password");
    const role = value("user-role");
    try {
      if (userEdit) await request(route("users", userEdit), "PATCH", { role, ...(password ? { password } : {}) });
      else await request("/api/users", "POST", { username: value("user-name").trim(), password, role });
      editUser(null);
      await refreshUsers();
      message("account-status", "Member saved.", "success");
    } finally {
      byId("user-password").value = "";
    }
  });
  onSubmit("password-form", "account-status", async () => {
    try {
      const result = await request("/api/auth/password", "POST", { currentPassword: value("current-password"), password: value("new-password") });
      session = { ...session, user: result.user };
      applyAccount();
      message("account-status", "Password updated.", "success");
    } finally {
      byId("password-form").reset();
    }
  });

  return {
    async start() {
      try {
        await applySession(await request("/api/auth/session"));
      } catch (error) {
        byId("access-title").textContent = "Workspace unavailable";
        message("access-status", `${error.message} Reload the page to retry.`);
      }
    },
    expire() {
      if (!session?.user) return;
      session = { ...session, user: null };
      showAccess(true);
    },
    canEdit,
  };
}
