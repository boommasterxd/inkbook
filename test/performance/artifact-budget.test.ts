import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ArtifactBudgetError,
  type ArtifactMeasurement,
  assertArtifactBudget,
  deterministicGzip,
  extractEmbeddedWorker,
  measureArtifactPackage,
} from "../../scripts/performance/artifact-budget.mjs";

const workerSource = String.raw`"use strict"; const PROTOCOL_VERSION = 1; self.addEventListener("message", () => {});`;

async function createPackage(): Promise<string> {
  const packageDirectory = await mkdtemp(join(tmpdir(), "inkbook-artifact-"));
  await Promise.all([
    writeFile(
      join(packageDirectory, "main.js"),
      `const worker = String.raw\`${workerSource}\`;`,
    ),
    writeFile(join(packageDirectory, "manifest.json"), "{}"),
    writeFile(join(packageDirectory, "styles.css"), ".inkbook {}"),
  ]);
  return packageDirectory;
}

describe("artifact budget measurement", () => {
  it("measures deterministic package and embedded-worker bytes", async () => {
    const packageDirectory = await createPackage();
    try {
      const measurement: ArtifactMeasurement =
        await measureArtifactPackage(packageDirectory);

      expect(measurement.mainJsBytes).toBeGreaterThan(0);
      expect(measurement.mainJsGzipBytes).toBe(
        deterministicGzip(
          Buffer.from(`const worker = String.raw\`${workerSource}\`;`),
        ).byteLength,
      );
      expect(measurement.embeddedWorkerBytes).toBe(
        Buffer.byteLength(workerSource),
      );
      expect(extractEmbeddedWorker(`String.raw\`${workerSource}\``)).toBe(
        workerSource,
      );
      expect(deterministicGzip(Buffer.from("stable"))).toEqual(
        deterministicGzip(Buffer.from("stable")),
      );
    } finally {
      await rm(packageDirectory, { recursive: true, force: true });
    }
  });

  it("rejects an artifact that exceeds any frozen byte limit", async () => {
    const packageDirectory = await createPackage();
    try {
      const measurement: ArtifactMeasurement =
        await measureArtifactPackage(packageDirectory);
      expect(() =>
        assertArtifactBudget(measurement, {
          limits: {
            mainRawBytes: 1,
            mainGzipBytes: Number.MAX_SAFE_INTEGER,
            embeddedWorkerRawBytes: Number.MAX_SAFE_INTEGER,
            stylesRawBytes: Number.MAX_SAFE_INTEGER,
            stylesGzipBytes: Number.MAX_SAFE_INTEGER,
          },
        }),
      ).toThrow(ArtifactBudgetError);
    } finally {
      await rm(packageDirectory, { recursive: true, force: true });
    }
  });

  it("rejects missing embedded worker payloads", async () => {
    const packageDirectory = await mkdtemp(
      join(tmpdir(), "inkbook-artifact-missing-"),
    );
    try {
      await Promise.all([
        writeFile(
          join(packageDirectory, "main.js"),
          "export const noWorker = true;",
        ),
        writeFile(join(packageDirectory, "manifest.json"), "{}"),
        writeFile(join(packageDirectory, "styles.css"), ""),
      ]);
      await expect(measureArtifactPackage(packageDirectory)).rejects.toThrow(
        ArtifactBudgetError,
      );
    } finally {
      await rm(packageDirectory, { recursive: true, force: true });
    }
  });
});
