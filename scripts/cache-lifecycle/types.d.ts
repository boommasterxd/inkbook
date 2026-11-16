export interface Cache {
  id: number;
  key: string;
  ref: string;
  version: string;
  size_in_bytes: number;
  created_at: string;
  last_accessed_at: string;
}
export interface Workflow {
  name: string;
  path: string;
  job?: string;
}
export interface Policy {
  schemaVersion: 1;
  repository: string;
  defaultBranch: string;
  producerWorkflows: Workflow[];
  producerInputs: string[];
  families: Record<string, string>;
  codeqlWorkflows: Workflow[];
  retiredPrefixes: { prefix: string; replacement: string }[];
}
export interface Replacement {
  family: string;
  key: string;
  prefix: string;
}
export interface Run {
  id: number;
  name: string;
  path: string;
  head_sha: string;
  head_branch: string;
  event: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  pull_requests?: { number: number }[];
}
export interface Api {
  read(path: string): unknown;
  list(path: string, field: string): unknown[];
  remove(id: number): void;
  readReceipts(runId: number, attempt: number): unknown[];
}
export interface Candidate {
  cache: Cache;
  replacement?: Cache;
  reason: string;
}
export interface Options {
  policy: Policy;
  repository: string;
  eventName: string;
  event: Record<string, unknown>;
  runId: number;
  ref: string;
  sha: string;
  workflow: string;
  checkoutSha: string;
  replacements: Replacement[];
  api: Api;
  dryRun?: boolean;
}
