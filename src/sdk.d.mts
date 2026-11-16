export type Mode = 'preview' | 'live';
export type RunStatus = 'running' | 'awaiting_approval' | 'succeeded' | 'failed' | 'rejected';

export interface Condition {
  step: string;
  includes: string;
  negate?: boolean;
}

interface StepBase {
  id: string;
  name: string;
  template: string;
  when?: Condition;
}

export type Step = StepBase & (
  { type: 'template' | 'prompt' | 'approval' } |
  { type: 'connector'; connector: string }
);

export interface Workflow {
  name: string;
  description?: string;
  steps: Step[];
}

export interface SavedWorkflow extends Workflow {
  id: string;
  revision: number;
  updatedAt: string;
}

export interface RunEvent {
  at: string;
  type: string;
  stepId?: string;
  message?: string;
  durationMs?: number;
  model?: string;
  actor?: { id: string; username: string };
  usage?: { inputTokens: number; outputTokens: number };
}

export type RunSource =
  { type: 'manual'; userId?: string; username?: string } |
  { type: 'schedule'; triggerId: string; scheduledAt: string } |
  { type: 'webhook'; triggerId: string };

export interface RunSummary {
  id: string;
  workflowName: string;
  status: RunStatus;
  mode: Mode;
  createdAt: string;
  updatedAt: string;
  source?: RunSource;
}

export interface Run extends Omit<RunSummary, 'workflowName'> {
  workflow: Workflow;
  workflowId: string;
  workflowRevision: number;
  input: string;
  cursor: number;
  outputs: Record<string, string>;
  events: RunEvent[];
  pendingApproval: { stepId: string; message: string } | null;
  error: string | null;
}

export interface Connector {
  id: string;
  name: string;
  description: string;
  inputHint: string;
  configured: boolean;
}

interface TriggerSettings {
  name: string;
  workflowId: string;
  mode?: Mode;
  enabled?: boolean;
  input?: string;
}

export type NewTrigger = TriggerSettings & (
  { type: 'schedule'; intervalMinutes: number } |
  { type: 'webhook'; intervalMinutes?: never }
);

export interface Trigger extends Required<TriggerSettings> {
  id: string;
  type: 'schedule' | 'webhook';
  intervalMinutes: number | null;
  nextAt: string | null;
  lastRunId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Metrics {
  runs: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  successRate: number | null;
  awaitingApproval: number;
  byStatus: Partial<Record<RunStatus, number>>;
  byMode: Partial<Record<Mode, number>>;
}

export interface Client {
  listWorkflows(): Promise<SavedWorkflow[]>;
  createWorkflow(workflow: Workflow): Promise<SavedWorkflow>;
  updateWorkflow(id: string, workflow: Workflow & { revision?: number }): Promise<SavedWorkflow>;
  listRuns(): Promise<RunSummary[]>;
  getRun(id: string, options?: { signal?: AbortSignal }): Promise<Run>;
  startRun(options: { workflowId: string; input?: string; mode?: Mode }): Promise<Run>;
  decideRun(id: string, decision: { approve: boolean; note?: string }): Promise<Run>;
  listConnectors(): Promise<Connector[]>;
  listTriggers(): Promise<Trigger[]>;
  createTrigger(trigger: NewTrigger): Promise<{trigger: Trigger; secret?: string}>;
  updateTrigger(id: string, changes: Partial<TriggerSettings> & { intervalMinutes?: number }): Promise<Trigger>;
  removeTrigger(id: string): Promise<void>;
  rotateWebhook(id: string): Promise<{trigger: Trigger; secret: string}>;
  getMetrics(): Promise<Metrics>;
  plan(goal: string, mode?: Mode): Promise<{ workflow: Workflow; summary: string }>;
  waitForRun(id: string, options?: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<Run>;
}

export class Agent007Error extends Error {
  status?: number;
  body?: unknown;
  constructor(message: string, options?: { status?: number; body?: unknown });
}

export function createClient(baseUrl?: string, options?: { fetch?: typeof fetch; headers?: HeadersInit }): Client;
