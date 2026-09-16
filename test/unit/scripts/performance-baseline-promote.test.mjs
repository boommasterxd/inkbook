import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  git: vi.fn(),
  publish: vi.fn(),
  artifact: vi.fn(),
  remote: vi.fn(),
  validate: vi.fn(),
}));
vi.mock("../../../scripts/performance-baseline-github.mjs", async (original) => ({
  ...(await original()),
  githubApi: mocks.api,
  git: mocks.git,
  publishBaseline: mocks.publish,
  readBaselineArtifact: mocks.artifact,
  remoteBaseline: mocks.remote,
}));
vi.mock("../../../scripts/performance-baseline-validation.mjs", async (original) => ({
  ...(await original()),
  validateBaselineReports: mocks.validate,
}));
import { promoteBaseline } from "../../../scripts/performance-baseline-promote.mjs";

const merge = "a".repeat(40);
const tested = "b".repeat(40);
const base = "c".repeat(40);
const head = "d".repeat(40);
const anchor = "e".repeat(40);
const tree = "f".repeat(40);
const environment = {
  GITHUB_REPOSITORY: "owner/repo",
  GITHUB_SHA: merge,
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF: "refs/heads/main",
};
const workflowNames = {
  "ci.yml": ["CI", "Performance (shared)", "Performance (refresh profiles)"],
  "gitleaks.yml": ["gitleaks"],
  "commit-style-check.yml": ["Validate PR Title"],
};
let invalidTree;
let failedJob;
let wrongHead;
let missingArtifact;
let pullAssociation;
let report;

beforeEach(() => {
  vi.resetAllMocks();
  invalidTree = false;
  failedJob = false;
  wrongHead = false;
  missingArtifact = false;
  pullAssociation = [{ number: 3 }];
  report = {
    eligible: true,
    improvedMetrics: 1,
    testedCommit: tested,
    metrics: [{ key: "metric", ratios: Array(6).fill(0.9) }],
  };
  mocks.git.mockReturnValue(merge);
  mocks.remote.mockReturnValue(anchor);
  mocks.artifact.mockImplementation(() => report);
  mocks.validate.mockReturnValue({ improvedMetrics: 2 });
  const pull = {
    number: 3,
    merged_at: "2026-09-16",
    merge_commit_sha: merge,
    base: { ref: "main", repo: { full_name: "owner/repo" } },
    head: { sha: head },
  };
  mocks.api.mockImplementation((path) => {
    if (path.endsWith(`/commits/${merge}/pulls?per_page=100`)) return [pull];
    if (path.endsWith("/pulls/3")) return pull;
    if (path.includes("/actions/workflows/")) {
      const workflow = path.split("/workflows/")[1].split("/")[0];
      return {
        total_count: 1,
        workflow_runs: [
          {
            id: Object.keys(workflowNames).indexOf(workflow) + 1,
            run_attempt: 1,
            event: "pull_request",
            status: "completed",
            conclusion: "success",
            path: `.github/workflows/${workflow}`,
            head_sha: wrongHead ? merge : head,
            repository: { full_name: "owner/repo" },
            pull_requests: pullAssociation,
          },
        ],
      };
    }
    if (path.includes("/jobs?")) {
      const id = Number(path.split("/runs/")[1].split("/")[0]);
      return {
        total_count: 3,
        jobs: Object.values(workflowNames)[id - 1].map((name) => ({
          name,
          conclusion: failedJob ? "failure" : "success",
        })),
      };
    }
    if (path.includes("/artifacts?"))
      return {
        total_count: 2,
        artifacts: missingArtifact
          ? []
          : [{ name: "performance-baseline-shared" }, { name: "performance-baseline-cadence" }],
      };
    if (path.endsWith(`/git/commits/${tested}`))
      return {
        sha: tested,
        parents: [{ sha: base }, { sha: head }],
        tree: { sha: invalidTree ? base : tree },
      };
    if (path.endsWith(`/git/commits/${merge}`))
      return { sha: merge, parents: [{ sha: base }], tree: { sha: tree } };
    throw new Error(`Unexpected API path ${path}`);
  });
});

describe("post-merge promotion", () => {
  it("validates both reports against exact merged tree, reference and successful run before publishing", () => {
    promoteBaseline(environment);
    expect(mocks.validate).toHaveBeenCalledWith([report, report], {
      testedCommit: tested,
      testedTree: tree,
      anchorCommit: anchor,
      baseCommit: base,
      runId: "1",
      runAttempt: "1",
    });
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.publish.mock.calls[0][0]).toMatchObject({ merge, previous: anchor, anchor });
    expect(mocks.publish.mock.calls[0][1].improvements).toHaveLength(2);
  });
  it("accepts empty post-merge API associations with exact head, merge parents and tree", () => {
    pullAssociation = [];
    promoteBaseline(environment);
    expect(mocks.publish).toHaveBeenCalledOnce();
  });
  it("rejects a populated association to a different PR", () => {
    pullAssociation = [{ number: 99 }];
    expect(() => promoteBaseline(environment)).toThrow("Missing PR run");
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("retains baseline without failing for neutral evidence", () => {
    report.eligible = false;
    promoteBaseline(environment);
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("does not promote source-identical evidence alone", () => {
    report.improvedMetrics = 0;
    promoteBaseline(environment);
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it.each([
    () => {
      invalidTree = true;
    },
    () => {
      failedJob = true;
    },
    () => {
      wrongHead = true;
    },
    () => {
      missingArtifact = true;
    },
    () =>
      mocks.validate.mockImplementation(() => {
        throw new Error("stale anchor");
      }),
  ])("rejects stale or mismatched evidence before any write", (breakEvidence) => {
    breakEvidence();
    expect(() => promoteBaseline(environment)).toThrow();
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it.each([
    { GITHUB_EVENT_NAME: "pull_request" },
    { GITHUB_REF: "refs/heads/topic" },
    { GITHUB_SHA: "--bad" },
    { GITHUB_REPOSITORY: "bad/path/extra" },
  ])("rejects unauthorized context %j", (override) => {
    expect(() => promoteBaseline({ ...environment, ...override })).toThrow();
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it("propagates compare-and-swap rejection without retrying against a new anchor", () => {
    mocks.publish.mockImplementation(() => {
      throw new Error("stale lease");
    });
    expect(() => promoteBaseline(environment)).toThrow("stale lease");
    expect(mocks.publish).toHaveBeenCalledOnce();
  });
});
