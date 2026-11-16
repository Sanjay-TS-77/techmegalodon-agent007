# Agent007 by TechMegalodon

Agent007 is an open-source studio for building, reviewing, and running AI workflows. Draft plans, inspect dependencies on a visual graph, automate runs with schedules and webhooks, and review results in a shared workspace. The server, editor, engine, SDK, and examples are released together under Apache 2.0.

## Quick start

Use [Node.js 24 or later](https://nodejs.org/) in a source checkout. Copy `.env.example` to `.env`, then generate a setup token and set it as `AGENT007_SETUP_TOKEN` in `.env`.

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm start
```

Open [http://127.0.0.1:4387](http://127.0.0.1:4387) and enter the token to create the first administrator. Remove the token from `.env` after setup. Choose **Support request triage** and try a preview with `[urgent] Two warehouse users cannot print shipping labels.` Approve or reject the draft and inspect the resulting graph and run history.

Preview mode produces deterministic stand-in text for prompt steps. It exercises templates, conditions, approval gates, and the run history without a model account.

On a fresh loopback-only installation, you can set `AGENT007_AUTH=disabled` and leave the setup token blank for a local demo. Once the data directory has accounts, they remain required.

## Build a workflow

- **Template** formats your input and earlier step outputs.
- **Prompt** sends the rendered text to the configured hosted model in Live mode.
- **Approval** pauses the run with a message for the reviewer. An approval continues the run. A rejection ends it.
- **Connector** passes rendered text to a registered server-side handler. Use `GET /api/connectors` to see the available handlers.

`{{input}}` inserts the run input. `{{steps.draft}}` inserts the output of an earlier step whose ID is `draft`. Each step can have a condition that looks for a string in a prior output. A skipped step produces no output, so reference its output only on a path where the step runs.

The editor imports and exports workflow JSON. Start with a bundled example for [support triage](examples/support-triage.json), [release readiness](examples/release-brief.json), or a [research handoff](examples/research-handoff.json).

Click a node in the workflow graph to inspect or edit a step. The graph shows execution order, output references, and conditional dependencies. The run graph uses the saved revision that ran and marks the result of each step.

## Plan, connect, and review

Use **Plan workflow** to turn a goal into an editable draft. Preview planning selects a workflow pattern and adds an approval step. Live planning passes the goal to the configured hosted model and validates the returned workflow before opening it in the editor.

The 16 built-in connectors cover text cleanup, counts, deduplication, SHA-256 digests, JSON formatting and selection, CSV conversion, GitHub repositories and activity, the npm, PyPI and crates.io registries, Hacker News items, and Open Library ISBN lookups. Local transforms execute in both modes. Network connectors show their destination in Preview and make read-only requests to fixed public endpoints in Live. A workflow with only templates, approvals, and connectors can run Live without a model account.

**Select JSON value** takes `{"pointer":"/items/0","value":{"items":["first"]}}`. **CSV to JSON** uses the header row as property names and preserves field values as strings. CSV supports quoted commas, quotes and newlines.

The run record shows which steps ran or skipped, their outputs, approval notes, and step duration. Hosted model steps also report token usage when the provider returns it. Run metrics summarize status counts, pending approvals, success rate across finished runs, and model tokens.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/plans` | Generate a workflow draft from a JSON body with `goal` and `mode`. |
| `GET /api/connectors` | List available connectors and the input each expects. |
| `GET /api/metrics` | Read aggregate run and token metrics for the workspace. |

## Automate runs

Open **Triggers** to attach a schedule or webhook to a saved workflow. A trigger uses the latest saved revision at execution, and each run records which revision it used. Approval steps still pause automated runs for review.

- **Schedule** runs every 1–43,200 minutes, starting after the first interval. The interval stays anchored to a UTC timestamp. Enabling a schedule or changing its interval resets that timestamp. After downtime, Agent007 starts one overdue occurrence and resumes the original cadence. Keep the studio running to execute schedules on time.
- **Webhook** starts a run when an external system sends an authenticated JSON `POST`. Copy the bearer token when creating or rotating it. Send `{"input":"a message"}` for plain text, a JSON object for structured workflow input, or `{}` for the stored default. The reply contains the run ID. Send a unique `Idempotency-Key` per event to reuse the run ID on retry for 24 hours. Reusing a key with different input returns `409`.

```sh
curl -X POST "https://agent.example.com/api/webhooks/$TRIGGER_ID" \
  -H "Authorization: Bearer $WEBHOOK_TOKEN" \
  -H "Idempotency-Key: ticket-147-created" \
  -H 'Content-Type: application/json' \
  -d '{"event":"ticket.created","ticketId":147}'
```

## Connect a hosted model

Copy `.env.example` to `.env` and populate the provider settings, or set the variables in the server process environment. Restart Agent007 to use the new configuration. The browser offers Live model execution when the provider is configured.

| Variable | Value |
| --- | --- |
| `AGENT007_PROVIDER` | `openai`, `anthropic`, `google`, `groq`, or `mistral` |
| `AGENT007_MODEL` | A model ID available to your provider account |
| `OPENAI_API_KEY` | API key for `openai` |
| `ANTHROPIC_API_KEY` | API key for `anthropic` |
| `GEMINI_API_KEY` | API key for `google` |
| `GROQ_API_KEY` | API key for `groq` |
| `MISTRAL_API_KEY` | API key for `mistral` |

Set only the key for your chosen provider. Agent007 keeps the key in the server process. In Live mode the provider receives the rendered prompt, which can include run input and prior outputs. Keep sensitive data out of prompts unless the provider and your data policy allow it.

## Run in Docker

Prepare `.env` with a setup token as above. From a source checkout, build the image and start a container.

```sh
docker build -t agent007 .
docker run --rm --name agent007 \
  --env-file .env \
  -p 127.0.0.1:4387:4387 \
  -v agent007-data:/var/lib/agent007 \
  agent007
```

Open [http://127.0.0.1:4387](http://127.0.0.1:4387). The named volume keeps data across container restarts. You can supply the setup token and model key through your container platform's secrets mechanism.

## Data and access

Agent007 stores workflows, runs, accounts, and triggers in SQLite. The data directory defaults to `.agent007`. Point `AGENT007_DATA_DIR` at your existing data directory when upgrading. Back up the whole directory with the server stopped.

The server listens on `127.0.0.1:4387` by default. Set `HOST` and `PORT` to change the bind address and port. For shared deployments, serve Agent007 behind an HTTPS reverse proxy that forwards the public `Host` and set `AGENT007_ALLOWED_HOSTS` to the exact public hostname. Custom hosts use Secure cookies by default. The app throttles failed sign-in attempts by direct connection IP. Use client-IP rate limits at the proxy if it combines traffic from multiple users.

All accounts share the same workflow library and run history. Admins manage accounts and can do everything editors can. Editors build workflows, start runs, manage triggers, and record approvals. Viewers can inspect the workspace and runs. Passwords use scrypt, and administrators can disable accounts or reset their passwords. Disabling an account revokes its sessions.

Every save records a workflow revision. Runs keep the revision they started with, and `GET /api/workflows/{id}/versions` retrieves earlier revisions. An approval remains available across a restart. Runs interrupted mid-step are recorded as failed so the server avoids repeating a model call.

## JavaScript SDK

With the server running, save this module in the source checkout and run it with `node`. Set `AGENT007_USER` and `AGENT007_PASSWORD` for an editor or administrator account in the client process environment.

```js
import { createClient } from './src/sdk.mjs';

const base = 'http://127.0.0.1:4387';
const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: process.env.AGENT007_USER, password: process.env.AGENT007_PASSWORD }),
});
if (!login.ok) throw new Error(`Sign-in failed (${login.status})`);
const cookie = login.headers.get('set-cookie').split(';', 1)[0];
const client = createClient(base, { headers: { cookie } });
const { workflow } = await client.plan('Draft a response to a support request for review.');
const saved = await client.createWorkflow(workflow);
const started = await client.startRun({ workflowId: saved.id, input: 'Two users cannot print labels.' });
const run = await client.waitForRun(started.id);

if (run.pendingApproval) {
  console.log(run.pendingApproval.message);
}
```

After a human reviews the draft, `client.decideRun(run.id, { approve: true, note: 'Reviewed' })` records the decision. Use `client.createTrigger(...)` and `client.listTriggers()` to manage automation. The SDK includes TypeScript declarations for workflows, runs, connectors, and triggers and is available as an installable tarball on the [GitHub release page](https://github.com/Sanjay-TS-77/techmegalodon-agent007/releases).

## Release scope

Version 0.2 adds shared workspace accounts, workflow graphs, scheduled and webhook triggers, and eight new connectors. This release runs as a single studio process with one SQLite-backed workspace.

## Develop

```sh
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development and review workflow.

Agent007 is maintained by TechMegalodon and distributed under the [Apache License 2.0](LICENSE).
