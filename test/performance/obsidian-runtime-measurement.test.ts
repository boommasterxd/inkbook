import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  measureRuntimeCell,
  RuntimeMeasurementError,
  summarizeMeasurements,
  type RuntimeDiagnosticSnapshot,
  type RuntimeDisposalSnapshot,
  type RuntimeEnvironmentSnapshot,
  type RuntimeHostDriver,
} from "../../scripts/performance/obsidian-runtime-measurement.mjs";
import { buildObsidianHostExpression } from "../../scripts/performance/obsidian-runtime-host.mjs";
import type { PerformanceProfile } from "../../scripts/performance/performance-profile.mjs";

const MEBIBYTE = 1_048_576;
const CELL_ID = "P0-SAMSUNG-GALAXY-BOOK-5";
const WARMUP_COUNT = 5;
const SAMPLE_COUNT = 100;
const TOTAL_CYCLES = WARMUP_COUNT + SAMPLE_COUNT;
const RUNTIME_ROW_COUNT = 5;
const DEFAULT_MODULE_MS = 10;
const DEFAULT_ONLOAD_MS = 20;
const WARMUP_MODULE_MS = 40;
const WARMUP_ONLOAD_MS = 50;
const TIMESTAMP_SPACING_MS = 1_000;
const BASELINE_HEAP_MIB = 10;
const PEAK_HEAP_MIB = 11;
const TOTAL_HEAP_MIB = 16;
const SECOND_CYCLE = 2;
const NEGATIVE_SAMPLE = -1;
const EXPECTED_P50 = 50;
const EXPECTED_P95 = 95;
const EXPECTED_P99 = 99;
const EXPECTED_VARIANCE = 833.25;

function finalProfile(): PerformanceProfile {
  const profile = JSON.parse(
    readFileSync("config/performance-profile.v1.json", "utf8"),
  ) as PerformanceProfile;
  profile.status = "final";
  return profile;
}

function snapshot(
  instance: number,
  moduleCssMs = DEFAULT_MODULE_MS,
  onloadMs = DEFAULT_ONLOAD_MS,
): RuntimeDiagnosticSnapshot {
  const start = instance * TIMESTAMP_SPACING_MS;
  return {
    moduleEvaluatedAt: start + 1,
    onloadEnteredAt: start + moduleCssMs,
    onloadSettledAt: start + onloadMs,
    cssOwnerCount: 1,
  };
}

function disposal(instance: number): RuntimeDisposalSnapshot {
  const start = instance * TIMESTAMP_SPACING_MS;
  return {
    onunloadEnteredAt: start + DEFAULT_ONLOAD_MS + 1,
    disposalSettledAt: start + DEFAULT_ONLOAD_MS + SECOND_CYCLE,
    cssOwnerCount: 0,
    resourceCoordinatorBalanced: true,
    resourceCoordinatorDisposed: true,
  };
}

class FakeRuntimeDriver implements RuntimeHostDriver {
  public cleanupCalls = 0;
  public collectGarbageCalls = 0;
  public disableCalls = 0;
  public enableCalls = 0;
  public environmentProbeCalls = 0;
  public failCollectionAt: number | undefined;
  public failEnableAt: number | undefined;
  public reuseModuleAt: number | undefined;
  private current = 0;
  private heap = BASELINE_HEAP_MIB * MEBIBYTE;
  private baselineRequiresCollection = false;
  private pendingEnable: (() => void) | undefined;

  public async initialize(): Promise<RuntimeDiagnosticSnapshot> {
    return snapshot(this.current);
  }

  public async runEnvironmentProbe(): Promise<RuntimeEnvironmentSnapshot> {
    this.environmentProbeCalls += 1;
    return {
      workerLaunched: true,
      workerResultPassed: true,
      recoveryPassed: true,
      workerResourcesReleased: true,
    };
  }

  public async disableCurrent(
    moduleEvaluatedAt: number,
  ): Promise<RuntimeDisposalSnapshot> {
    expect(this.environmentProbeCalls).toBe(1);
    expect(moduleEvaluatedAt).toBe(snapshot(this.current).moduleEvaluatedAt);
    this.disableCalls += 1;
    this.heap = BASELINE_HEAP_MIB * MEBIBYTE;
    this.baselineRequiresCollection = true;
    return disposal(this.current);
  }

  public async collectGarbage(): Promise<void> {
    this.collectGarbageCalls += 1;
    if (this.collectGarbageCalls === this.failCollectionAt) {
      throw new Error("synthetic HeapProfiler failure");
    }
    this.baselineRequiresCollection = false;
  }

  public enableNext(moduleEvaluatedAt: number): Promise<{
    enableStartedAt: number;
    ready: RuntimeDiagnosticSnapshot;
  }> {
    expect(moduleEvaluatedAt).toBe(snapshot(this.current).moduleEvaluatedAt);
    this.enableCalls += 1;
    if (this.enableCalls === this.failEnableAt) {
      return Promise.reject(new Error("synthetic enable failure"));
    }
    this.current += 1;
    const duration =
      this.current <= WARMUP_COUNT ? WARMUP_MODULE_MS : DEFAULT_MODULE_MS;
    const onloadDuration =
      this.current <= WARMUP_COUNT ? WARMUP_ONLOAD_MS : DEFAULT_ONLOAD_MS;
    const readyInstance =
      this.enableCalls === this.reuseModuleAt ? this.current - 1 : this.current;
    const ready = snapshot(readyInstance, duration, onloadDuration);
    return new Promise((resolve) => {
      this.pendingEnable = (): void =>
        resolve({
          enableStartedAt: this.current * TIMESTAMP_SPACING_MS,
          ready,
        });
    });
  }

  public async heapUsage(): Promise<{ totalSize: number; usedSize: number }> {
    if (this.baselineRequiresCollection) {
      throw new Error("baseline sampled before garbage collection");
    }
    if (this.pendingEnable) {
      this.heap = PEAK_HEAP_MIB * MEBIBYTE;
      const settle = this.pendingEnable;
      this.pendingEnable = undefined;
      queueMicrotask(settle);
    }
    return { totalSize: TOTAL_HEAP_MIB * MEBIBYTE, usedSize: this.heap };
  }

  public async ensureEnabled(): Promise<RuntimeDiagnosticSnapshot> {
    this.cleanupCalls += 1;
    return snapshot(this.current);
  }
}

describe("runtime measurement statistics", () => {
  it("computes nearest-rank percentiles and population variance", () => {
    const values = Array.from(
      { length: SAMPLE_COUNT },
      (_, index) => index + 1,
    );
    expect(summarizeMeasurements(values)).toEqual({
      maximum: SAMPLE_COUNT,
      p50: EXPECTED_P50,
      p95: EXPECTED_P95,
      p99: EXPECTED_P99,
      variance: EXPECTED_VARIANCE,
    });
  });

  it("rejects missing, negative, and non-finite samples", () => {
    expect(() => summarizeMeasurements([1])).toThrow(RuntimeMeasurementError);
    const prefix = Array.from({ length: SAMPLE_COUNT - 1 }, () => 1);
    expect(() => summarizeMeasurements([...prefix, NEGATIVE_SAMPLE])).toThrow(
      /finite non-negative/,
    );
    expect(() => summarizeMeasurements([...prefix, Infinity])).toThrow(
      /finite non-negative/,
    );
  });
});

describe("Obsidian runtime measurement", () => {
  it("discards five warmups and records exactly 100 bounded cycles", async () => {
    const driver = new FakeRuntimeDriver();
    const result = await measureRuntimeCell({
      cellId: CELL_ID,
      driver,
      profile: finalProfile(),
    });

    expect(driver.disableCalls).toBe(TOTAL_CYCLES);
    expect(driver.collectGarbageCalls).toBe(TOTAL_CYCLES);
    expect(driver.enableCalls).toBe(TOTAL_CYCLES);
    expect(driver.environmentProbeCalls).toBe(1);
    expect(result.rows).toHaveLength(RUNTIME_ROW_COUNT);
    expect(result.rows[0]).toMatchObject({
      maximum: DEFAULT_MODULE_MS,
      p50: DEFAULT_MODULE_MS,
      p95: DEFAULT_MODULE_MS,
      p99: DEFAULT_MODULE_MS,
      samples: SAMPLE_COUNT,
      variance: 0,
      warmups: WARMUP_COUNT,
    });
    expect(result.rows[1]).toMatchObject({
      maximum: DEFAULT_ONLOAD_MS,
      p95: DEFAULT_ONLOAD_MS,
    });
    expect(result.rows[2]).toMatchObject({ maximum: 1, unit: "MiB" });
    expect(result.rows[3]).toMatchObject({
      maximum: 1,
      p50: 1,
      p95: 1,
      p99: 1,
      samples: 1,
      variance: 0,
      warmups: 0,
    });
    expect(result.rows[4]).toMatchObject({ maximum: 1, pass: true });
  });

  it("restores plugin enablement after a measurement failure", async () => {
    const driver = new FakeRuntimeDriver();
    driver.failEnableAt = SECOND_CYCLE;

    await expect(
      measureRuntimeCell({ cellId: CELL_ID, driver, profile: finalProfile() }),
    ).rejects.toThrow(/synthetic enable failure/);
    expect(driver.cleanupCalls).toBe(1);
  });

  it("fails closed when forced garbage collection is unavailable", async () => {
    const driver = new FakeRuntimeDriver();
    driver.failCollectionAt = 1;

    await expect(
      measureRuntimeCell({ cellId: CELL_ID, driver, profile: finalProfile() }),
    ).rejects.toThrow(/HeapProfiler failure/);
    expect(driver.enableCalls).toBe(0);
    expect(driver.cleanupCalls).toBe(1);
  });

  it("rejects a reused module mark and restores enablement", async () => {
    const driver = new FakeRuntimeDriver();
    driver.reuseModuleAt = 1;

    await expect(
      measureRuntimeCell({ cellId: CELL_ID, driver, profile: finalProfile() }),
    ).rejects.toThrow(/current enable boundary/);
    expect(driver.cleanupCalls).toBe(1);
  });

  it("rejects a draft profile before mutating the host", async () => {
    const driver = new FakeRuntimeDriver();
    const profile = finalProfile();
    profile.status = "draft";

    await expect(
      measureRuntimeCell({ cellId: CELL_ID, driver, profile }),
    ).rejects.toThrow(/final frozen/);
    expect(driver.disableCalls).toBe(0);
  });

  it("builds guarded mark and CSS lifecycle checks without a pre-wait", () => {
    const expression = buildObsidianHostExpression("disable-current", {
      environmentProbeCommandId: "inkbook:phase-zero-run-environment-probe",
      markTimeoutMs: TIMESTAMP_SPACING_MS,
      pluginId: "inkbook",
      previousModuleEvaluatedAt: TIMESTAMP_SPACING_MS,
    });

    expect(expression).toContain("unsupported-private-host-or-performance-api");
    expect(expression).toContain("missing-or-ambiguous-performance-mark");
    expect(expression).toContain(".inkbook-phase-zero-overlay");
    expect(expression).toContain("await manager.disablePlugin");
    expect(expression).toContain("names.disposalSettled");
    expect(expression).not.toContain("disablePluginAndSave");
    expect(expression).not.toContain("requestAnimationFrame");
  });

  it("builds an event-driven environment probe with exact assertions", () => {
    const expression = buildObsidianHostExpression("run-environment-probe", {
      environmentProbeCommandId: "inkbook:phase-zero-run-environment-probe",
      markTimeoutMs: TIMESTAMP_SPACING_MS,
      pluginId: "inkbook",
    });

    expect(expression).toContain("commands.executeCommandById");
    expect(expression).toContain("names.workerProbeSettled");
    expect(expression).toContain("workerResourcesReleased !== true");
    expect(expression).toContain("waitForUniqueEntry");
  });
});
