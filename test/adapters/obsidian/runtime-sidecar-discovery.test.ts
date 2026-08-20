import { describe, expect, it } from "vitest";

import type { NoteIdentityV1 } from "../../../src/application/note-session";
import type {
  InkbookSidecarV1,
  SidecarStorageLayoutV1,
} from "../../../src/application/persistence";
import {
  materializeRuntimeSidecarResolutionV1,
  type RuntimeSidecarResolutionV1,
} from "../../../src/adapters/obsidian/runtime-sidecar-resolution";
import { SidecarMarkerWriter } from "../../../src/adapters/obsidian/vault-sidecar/marker";
import { VaultSidecarRepository } from "../../../src/adapters/obsidian/vault-sidecar/repository";
import { createSharedWorkerPortsV1 } from "../../../src/workers/shared-worker-ports";
import { completeSidecar } from "../../application/persistence/support";
import {
  fakeFile,
  FakeFrontMatterHost,
  FakeVault,
  preparedSidecarWrite,
} from "./vault-sidecar/support";

const IDENTITY: NoteIdentityV1 = Object.freeze({
  vaultIdHint: "vault-runtime",
  vaultRelativeMarkdownPath: "Notes/Example.md",
});
const ADJACENT_PATH = "Notes/Example.inkbook.json";
const ROOT_PATH = "Annotations/Notes/Example.inkbook.json";

describe("materializeRuntimeSidecarResolutionV1 legacy discovery", () => {
  it.each([
    [ADJACENT_PATH, { kind: "adjacent" }],
    [ROOT_PATH, { kind: "vault-root", vaultRelativeRoot: "Annotations" }],
  ] as const)(
    "adopts the single identity-valid candidate at %s",
    async (path, layout) => {
      const harness = discoveryHarness("legacy");
      harness.addSidecar(path, layout);

      await expect(harness.materialize()).resolves.toEqual({
        kind: "resolved",
        resolution: { kind: "existing", sidecarPath: path },
      });
      expect(harness.frontmatter.frontmatter).toEqual({
        foreign: "preserved",
        "inkbook-annotations": true,
        "inkbook-sidecar": path,
      });
      expect(harness.frontmatter.calls).toBe(1);
      expect(harness.vault.getFilesCalls).toBe(0);
      harness.dispose();
    },
  );

  it("reports missing drift without writing when neither candidate exists", async () => {
    const harness = discoveryHarness("legacy");

    await expect(harness.materialize()).resolves.toEqual({ kind: "drift" });
    expect(harness.frontmatter.calls).toBe(0);
    expect(harness.vault.getFilesCalls).toBe(0);
    harness.dispose();
  });

  it("reports location conflict when both deterministic candidates are valid", async () => {
    const harness = discoveryHarness("legacy");
    harness.addSidecar(ADJACENT_PATH, { kind: "adjacent" });
    harness.addSidecar(ROOT_PATH, {
      kind: "vault-root",
      vaultRelativeRoot: "Annotations",
    });

    await expect(harness.materialize()).resolves.toEqual({
      kind: "conflict",
    });
    expect(harness.frontmatter.calls).toBe(0);
    harness.dispose();
  });

  it("rejects a candidate whose embedded Markdown identity differs", async () => {
    const harness = discoveryHarness("legacy");
    harness.addSidecar(ADJACENT_PATH, { kind: "adjacent" }, "Other.md");

    await expect(harness.materialize()).resolves.toEqual({
      kind: "conflict",
    });
    expect(harness.frontmatter.calls).toBe(0);
    harness.dispose();
  });
});

describe("materializeRuntimeSidecarResolutionV1 missing marker", () => {
  it("keeps a discovered sidecar disconnected and never restores implicitly", async () => {
    const missing = discoveryHarness("missing");
    missing.addSidecar(ADJACENT_PATH, { kind: "adjacent" });
    await expect(missing.materialize()).resolves.toEqual({ kind: "drift" });
    expect(missing.frontmatter.calls).toBe(0);
    missing.dispose();

    const disconnected = discoveryHarness("false");
    disconnected.addSidecar(ADJACENT_PATH, { kind: "adjacent" });
    await expect(disconnected.materialize()).resolves.toEqual({
      kind: "drift",
    });
    expect(disconnected.frontmatter.calls).toBe(0);
    disconnected.dispose();
  });

  it("uses the current-policy path only for a truly unannotated note", async () => {
    const harness = discoveryHarness("missing");

    await expect(harness.materialize()).resolves.toEqual({
      kind: "resolved",
      resolution: { kind: "unannotated", sidecarPath: ROOT_PATH },
    });
    expect(harness.vault.getFilesCalls).toBe(0);
    harness.dispose();
  });
});

interface DiscoveryHarnessV1 {
  readonly frontmatter: FakeFrontMatterHost;
  readonly vault: FakeVault;
  addSidecar(
    path: string,
    layout: SidecarStorageLayoutV1,
    markdownPath?: string,
  ): void;
  dispose(): void;
  materialize(): ReturnType<typeof materializeRuntimeSidecarResolutionV1>;
}

function discoveryHarness(
  markerState: "false" | "legacy" | "missing",
): DiscoveryHarnessV1 {
  const vault = new FakeVault();
  const repository = new VaultSidecarRepository(vault);
  const frontmatter = new FakeFrontMatterHost({
    foreign: "preserved",
    ...(markerState === "missing"
      ? {}
      : { "inkbook-annotations": markerState === "legacy" }),
  });
  const marker = new SidecarMarkerWriter(frontmatter);
  const workers = workerPorts();
  const resolution: RuntimeSidecarResolutionV1 = {
    allowUnannotated: markerState === "missing",
    candidatePaths: [ADJACENT_PATH, ROOT_PATH],
    creationPath: ROOT_PATH,
    kind: "discovery",
    markerState,
  };
  return {
    frontmatter,
    vault,
    addSidecar: (
      path,
      layout,
      markdownPath = IDENTITY.vaultRelativeMarkdownPath,
    ): void => {
      const sidecar: InkbookSidecarV1 = {
        ...completeSidecar(),
        noteIdentity: {
          ...completeSidecar().noteIdentity,
          vaultRelativeMarkdownPath: markdownPath,
        },
        storageLayout: layout,
      };
      vault.addFile(
        path,
        preparedSidecarWrite(sidecar, "desktop-tablet").rawText,
      );
    },
    dispose: (): void => {
      marker.dispose();
      repository.dispose();
      workers.dispose();
    },
    materialize: () =>
      materializeRuntimeSidecarResolutionV1({
        identity: IDENTITY,
        marker,
        normalizePath: vault.normalizePath,
        noteFile: fakeFile(IDENTITY.vaultRelativeMarkdownPath),
        persistenceCodecPort: workers.persistenceCodec,
        repository,
        resolution,
      }),
  };
}

function workerPorts(): ReturnType<typeof createSharedWorkerPortsV1> {
  const revision = Object.freeze({ layout: 0, scene: 0 });
  return createSharedWorkerPortsV1({
    clock: { now: () => performance.now() },
    environment: null,
    isCurrent: (candidate) =>
      candidate.layout === revision.layout &&
      candidate.scene === revision.scene,
    readRevision: () => revision,
    slices: {
      schedule: (_mode, callback): (() => void) => {
        const handle = setTimeout(callback, 0);
        return () => clearTimeout(handle);
      },
    },
  });
}
