import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ exec: vi.fn(), mkdir: vi.fn(), rm: vi.fn(), write: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: mocks.exec }));
vi.mock("node:fs", () => ({
  mkdtempSync: mocks.mkdir,
  rmSync: mocks.rm,
  writeFileSync: mocks.write,
}));
import {
  boundedItems,
  publishBaseline,
  readBaselineArtifact,
  remoteBaseline,
} from "../../../scripts/performance-baseline-github.mjs";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.mkdir.mockReturnValue("/tmp/baseline-test");
  mocks.exec.mockReturnValue("");
});

describe("atomic reference publication", () => {
  const context = {
    merge: "a".repeat(40),
    previous: "b".repeat(40),
    anchor: "b".repeat(40),
    run: { id: 1, run_attempt: 2, html_url: "https://example.test/run" },
  };
  it("publishes audit and baseline in one atomic push with an exact old-reference lease", () => {
    publishBaseline(context, { improvedMetrics: 1 });
    const args = mocks.exec.mock.calls[1][1];
    expect(args).toEqual([
      "push",
      "--atomic",
      `--force-with-lease=refs/tags/performance-baseline:${context.previous}`,
      "origin",
      `${context.merge}:refs/tags/performance-baseline`,
      `refs/tags/performance-baseline-audit-${context.merge}:refs/tags/performance-baseline-audit-${context.merge}`,
    ]);
    const annotation = JSON.parse(mocks.exec.mock.calls[0][2].input);
    expect(annotation).toMatchObject({
      previous: context.anchor,
      next: context.merge,
      runId: 1,
      runAttempt: 2,
      improvedMetrics: 1,
    });
  });
  it("uses an absent-reference lease when bootstrapping", () => {
    publishBaseline({ ...context, previous: null }, {});
    expect(mocks.exec.mock.calls[1][1]).toContain(
      "--force-with-lease=refs/tags/performance-baseline:",
    );
  });
  it("rejects a stale lease without any fallback push", () => {
    mocks.exec.mockReturnValueOnce("").mockImplementationOnce(() => {
      throw new Error("stale info");
    });
    expect(() => publishBaseline(context, {})).toThrow("stale info");
    expect(mocks.exec).toHaveBeenCalledTimes(2);
  });
  it("resolves absent and valid remote refs and rejects malformed refs", () => {
    expect(remoteBaseline()).toBeNull();
    mocks.exec.mockReturnValue(`${context.anchor}\trefs/tags/performance-baseline\n`);
    expect(remoteBaseline()).toBe(context.anchor);
    mocks.exec.mockReturnValue("invalid");
    expect(() => remoteBaseline()).toThrow();
  });
});

describe("bounded artifact handling", () => {
  const artifact = { id: 42, expired: false, size_in_bytes: 100 };
  it("reads only the expected JSON entry and cleans up the temporary archive", () => {
    mocks.exec
      .mockReturnValueOnce(Buffer.from("zip"))
      .mockReturnValueOnce("baseline-report.json\n")
      .mockReturnValueOnce('{"version":1}');
    expect(readBaselineArtifact("owner/repo", artifact)).toEqual({ version: 1 });
    expect(mocks.exec.mock.calls[2][1]).toEqual([
      "-p",
      "/tmp/baseline-test/report.zip",
      "baseline-report.json",
    ]);
    expect(mocks.rm).toHaveBeenCalledWith("/tmp/baseline-test", { recursive: true, force: true });
  });
  it.each([{ expired: true }, { size_in_bytes: 0 }, { size_in_bytes: 2_000_001 }])(
    "rejects unavailable or oversized artifacts %j",
    (override) => {
      expect(() => readBaselineArtifact("owner/repo", { ...artifact, ...override })).toThrow();
      expect(mocks.exec).not.toHaveBeenCalled();
    },
  );
  it.each(["../../malicious\n", "baseline-report.json\nextra.js\n", "duplicate\n"])(
    "rejects unexpected ZIP entries %s without extracting files",
    (listing) => {
      mocks.exec.mockReturnValueOnce(Buffer.from("zip")).mockReturnValueOnce(listing);
      expect(() => readBaselineArtifact("owner/repo", artifact)).toThrow();
      expect(mocks.exec).toHaveBeenCalledTimes(2);
      expect(mocks.rm).toHaveBeenCalledOnce();
    },
  );
  it("fails closed when API pagination exceeds the bounded first page", () => {
    expect(boundedItems({ total_count: 1, jobs: [{}] }, "jobs")).toEqual([{}]);
    expect(() => boundedItems({ total_count: 101, jobs: [] }, "jobs")).toThrow();
  });
});
