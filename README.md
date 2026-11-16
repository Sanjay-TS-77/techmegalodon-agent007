# Agent007 by TechMegalodon

Agent007 is an open-source studio for building, reviewing, and running AI workflows. Draft a plan, compose reusable workflows, preview them in the browser, and review each output and decision in one run history. The server, editor, engine, SDK, and examples are released together under Apache 2.0.

## Quick start

From a source checkout, start the app with [Node.js 24 or later](https://nodejs.org/).

```sh
npm start
```

Open [http://127.0.0.1:4387](http://127.0.0.1:4387). Choose **Support request triage** and start a preview run with a sample request such as `[urgent] Two warehouse users cannot print shipping labels.` Review the draft at the approval step, then approve to continue or reject to end the run. The run history shows the draft, the decision, and the escalation step that matched the `[urgent]` tag.

Preview mode produces deterministic stand-in text for prompt steps. It exercises templates, conditions, approval gates, and the run history without a model account.

## Build a workflow

- **Template** formats your input and earlier step outputs.
- **Prompt** sends the rendered text to the configured hosted model in Live mode.
- **Approval** pauses the run with a message for the reviewer. An approval continues the run. A rejection ends it.
- **Connector** passes rendered text to a registered server-side handler. Use `GET /api/connectors` to see the available handlers.

`{{input}}` inserts the run input. `{{steps.draft}}` inserts the output of an earlier step whose ID is `draft`. Each step can have a condition that looks for a string in a prior output. A skipped step produces no output, so reference its output only on a path where the step runs.

The editor imports and exports workflow JSON. Start with a bundled example for [support triage](examples/support-triage.json), [release readiness](examples/release-brief.json), or a [research handoff](examples/research-handoff.json).

## Plan, connect, and review

Use **Plan workflow** to turn a goal into an editable draft. Preview planning selects a workflow pattern and adds an approval step. Live planning passes the goal to the configured hosted model and validates the returned workflow before opening it in the editor.

Connectors support text cleanup, word and line counts, deduplication, JSON formatting, public GitHub repositories, issues and releases, and public npm package metadata. Text and JSON connectors execute in both modes. In Preview, GitHub and npm connectors identify the requested target. In Live, they make read-only public requests.

The run record shows which steps ran or skipped, their outputs, approval notes, and step duration. Hosted model steps also report token usage when the provider returns it. Run metrics summarize status counts, pending approvals, success rate across finished runs, and model tokens.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/plans` | Generate a workflow draft from a JSON body with `goal` and `mode`. |
| `GET /api/connectors` | List available connectors and the input each expects. |
| `GET /api/metrics` | Read aggregate run and token metrics for the workspace. |

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

From a source checkout, build the image and start a container.

```sh
docker build -t agent007 .
docker run --rm --name agent007 \
  -p 127.0.0.1:4387:4387 \
  -v agent007-data:/var/lib/agent007 \
  agent007
```

Open [http://127.0.0.1:4387](http://127.0.0.1:4387). The named volume keeps data across container restarts. To configure Live mode, pass the provider settings and key to the container through `--env-file` or your container platform's secrets mechanism.

## Data and access

Agent007 stores workflows, run inputs and outputs, and approval history in SQLite. The data directory defaults to `.agent007`. Set `AGENT007_DATA_DIR` to use a different path. Back up this directory with the server stopped to preserve your history.

The server listens on `127.0.0.1:4387` by default. Set `HOST` and `PORT` to change the bind address and port. Agent007 is a single workspace. Every user who can reach it can read runs and record approval decisions. Keep it on loopback or put it behind authenticated access controls when sharing it. Set `AGENT007_ALLOWED_HOSTS` to a comma-separated list of exact hostnames when running behind such a proxy.

Every save records a workflow revision. Runs keep the revision they started with, and `GET /api/workflows/{id}/versions` retrieves earlier revisions. An approval remains available across a restart. Runs interrupted mid-step are recorded as failed so the server avoids repeating a model call.

## JavaScript SDK

With the server running, save this module in the source checkout and run it with `node`.

```js
import { createClient } from './src/sdk.mjs';

const client = createClient();
const { workflow } = await client.plan('Draft a response to a support request for review.');
const saved = await client.createWorkflow(workflow);
const started = await client.startRun({ workflowId: saved.id, input: 'Two users cannot print labels.' });
const run = await client.waitForRun(started.id);

if (run.pendingApproval) {
  console.log(run.pendingApproval.message);
}
```

After a human reviews the draft, `client.decideRun(run.id, { approve: true, note: 'Reviewed' })` records the decision. The SDK includes TypeScript declarations for workflows, outputs, connectors, and run events.

## Release scope

Version 0.1 includes editable plans, a versioned workflow library, a JavaScript SDK, five hosted model adapters, eight built-in connectors, conditional steps, approvals, and run traces. Deployment is single-workspace. Planned areas include multi-user identity and access policies, scheduled and webhook triggers, a larger connector catalogue, workflow graphs, and production operations across multiple workers.

## Develop

```sh
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development and review workflow.

Agent007 is maintained by TechMegalodon and distributed under the [Apache License 2.0](LICENSE).
