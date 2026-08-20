import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { gzipSync } from "node:zlib";

import { expect, it } from "vitest";

import {
  launchByteWorker,
  type BrowserWorkerEnvironment,
} from "../../src/workers/scheduler/browser-worker-adapter";
import { WORKER_PROTOCOL_VERSION } from "../../src/workers/scheduler/protocol";

const WORKER_PREFIX = "const __INKBOOK_STATIC_WORKER_SOURCE__ = ";
const MAX_WORKER_BYTES = 786_432;
const MAX_MAIN_BYTES = 2_097_152;
const MAX_GZIP_MAIN_BYTES = 524_288;
const MAX_STYLES_BYTES = 131_072;
const MAX_GZIP_STYLES_BYTES = 32_768;
const BUILD_TIMEOUT_MS = 30_000;
const CANCEL_REQUEST_ID = 1;

it(
  "embeds and launches the static worker from the exact production package",
  () => {
    execFileSync(process.execPath, ["scripts/build.mjs"], {
      cwd: process.cwd(),
      stdio: "pipe",
    });
    const packageFiles: string[] = readdirSync("dist");
    expect(
      [...packageFiles].sort((left, right) => left.localeCompare(right)),
    ).toEqual(["main.js", "manifest.json", "styles.css"]);
    const mainBytes = readFileSync("dist/main.js");
    const manifest = readFileSync("dist/manifest.json", "utf8");
    const stylesBytes = readFileSync("dist/styles.css");
    expect(mainBytes.byteLength).toBeLessThanOrEqual(MAX_MAIN_BYTES);
    expect(gzipSync(mainBytes).byteLength).toBeLessThanOrEqual(
      MAX_GZIP_MAIN_BYTES,
    );
    expect(stylesBytes.byteLength).toBeLessThanOrEqual(MAX_STYLES_BYTES);
    expect(gzipSync(stylesBytes).byteLength).toBeLessThanOrEqual(
      MAX_GZIP_STYLES_BYTES,
    );
    const main = mainBytes.toString("utf8");
    expectCleanProductionText(main);
    expectCleanPackageMetadata(manifest);
    expectCleanProductionText(stylesBytes.toString("utf8"));
    const workerSource = extractWorkerSource(main);
    expect(
      new TextEncoder().encode(workerSource).byteLength,
    ).toBeLessThanOrEqual(MAX_WORKER_BYTES);
    expect(workerSource).not.toMatch(
      /\b(?:eval|importScripts|require)\s*\(|https?:\/\/|node:/u,
    );
    let launchedSource: BlobPart | undefined;
    let revoked = false;
    class PackagedBlob {
      readonly parts: readonly BlobPart[];

      constructor(parts: BlobPart[] = []) {
        this.parts = parts;
        launchedSource = parts[0];
      }
    }
    class PackagedWorker {
      readonly posted: unknown[] = [];
      terminated = false;

      postMessage(message: unknown): void {
        this.posted.push(message);
      }

      terminate(): void {
        this.terminated = true;
      }
    }
    const launched = launchByteWorker(
      {
        Blob: PackagedBlob,
        URL: {
          createObjectURL: (): string => "blob:packaged-worker",
          revokeObjectURL: (): void => {
            revoked = true;
          },
        },
        Worker: PackagedWorker,
      } as unknown as BrowserWorkerEnvironment,
      workerSource,
    );
    const packagedWorker = launched?.worker as unknown as
      PackagedWorker | undefined;
    expect(launchedSource).toBe(workerSource);
    launched?.worker.postMessage({
      protocolVersion: WORKER_PROTOCOL_VERSION,
      kind: "cancel",
      requestId: CANCEL_REQUEST_ID,
    });
    expect(packagedWorker?.posted).toEqual([
      {
        protocolVersion: WORKER_PROTOCOL_VERSION,
        kind: "cancel",
        requestId: CANCEL_REQUEST_ID,
      },
    ]);
    launched?.dispose();
    expect(packagedWorker?.terminated).toBe(true);
    expect(revoked).toBe(true);
  },
  BUILD_TIMEOUT_MS,
);

function expectCleanProductionText(value: string): void {
  expect(value).not.toMatch(/sourceMappingURL|https?:\/\//u);
  expect(value).not.toMatch(/(?:^|["'])electron(?:["']|$)/imu);
  expect(value).not.toMatch(/\brequire\(["'](?:node:|[^"']+\.node["'])/u);
  expect(value).not.toMatch(
    /\brequire\(["'](?:fs["'/]|path["'/]|child_process|worker_threads|vm["'/])/u,
  );
  expect(value).not.toMatch(
    /\b(?:eval|importScripts|fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/u,
  );
  expect(value).not.toMatch(
    /(?:\/home\/|\/Users\/|[A-Z]:\\|Development\/Projects)/u,
  );
  expect(value).not.toMatch(
    /\bconsole\.(?:debug|trace)\s*\(|__INKBOOK_(?:DEBUG|PROBE)|development-probe/iu,
  );
}

function expectCleanPackageMetadata(value: string): void {
  expect(value).not.toMatch(/sourceMappingURL/u);
  expect(value).not.toMatch(/(?:^|["'])electron(?:["']|$)/imu);
  expect(value).not.toMatch(
    /\brequire\(["'](?:node:|fs["'/]|path["'/]|child_process|worker_threads|vm["'/]|[^"']+\.node["'])/u,
  );
  expect(value).not.toMatch(
    /\b(?:eval|importScripts|fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/u,
  );
  expect(value).not.toMatch(
    /(?:\/home\/|\/Users\/|[A-Z]:\\|Development\/Projects)/u,
  );
  expect(value).not.toMatch(
    /\bconsole\.(?:debug|trace)\s*\(|__INKBOOK_(?:DEBUG|PROBE)|development-probe/iu,
  );
}

function extractWorkerSource(main: string): string {
  const declaration = main.indexOf(WORKER_PREFIX);
  if (declaration < 0)
    throw new Error("Embedded worker declaration is missing.");
  const start = declaration + WORKER_PREFIX.length;
  const end = main.indexOf(";\n", start);
  if (end < 0) throw new Error("Embedded worker declaration is incomplete.");
  const value: unknown = JSON.parse(main.slice(start, end));
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("Embedded worker payload is invalid.");
  }
  return value;
}
