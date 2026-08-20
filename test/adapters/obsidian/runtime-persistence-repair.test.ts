import { expect, it } from "vitest";

import { serializeRuntimeSceneStateV1 } from "../../../src/domain/codecs";
import { createSceneRevision } from "../../../src/domain/model";
import { createRuntimeSceneStateV1 } from "../../../src/domain/scene";
import {
  createSettingsRevision,
  createSourceGeneration,
  parseRelocationId,
  type NoteIdentityV1,
  type Sha256Digest,
} from "../../../src/application/note-session";
import {
  decodeInkbookSidecarV1,
  type InkbookSidecarV1,
  type PersistenceCodecPortV1,
  type PersistenceCodecWorkV1,
  type PrefixRelocationRuleV1,
  type SidecarStorageLayoutV1,
  type SidecarStoragePolicyV1,
} from "../../../src/application/persistence";
import {
  digestRuntimeTextV1,
  openRuntimePersistenceV1,
  resolveRuntimeRelocatedSidecarV1,
} from "../../../src/adapters/obsidian/runtime-persistence-open";
import { repairRelocatedSidecarV1 } from "../../../src/adapters/obsidian/runtime-persistence-repair";
import {
  ANNOTATION_MARKER_KEY,
  SIDECAR_LOCATOR_KEY,
  SidecarMarkerWriter,
} from "../../../src/adapters/obsidian/vault-sidecar/marker";
import { VaultSidecarRepository } from "../../../src/adapters/obsidian/vault-sidecar/repository";
import { createSharedWorkerPortsV1 } from "../../../src/workers/shared-worker-ports";
import { createRecoveryHarness } from "../../application/persistence/saga-support";
import {
  FakeFrontMatterHost,
  FakeVault,
  preparedSidecarWrite,
} from "./vault-sidecar/support";

const MARKDOWN = "Native Markdown";
const PRIOR_IDENTITY: NoteIdentityV1 = Object.freeze({
  vaultIdHint: "vault-runtime",
  vaultRelativeMarkdownPath: "Notes/page.md",
});
const TARGET_IDENTITY: NoteIdentityV1 = Object.freeze({
  vaultIdHint: "vault-runtime",
  vaultRelativeMarkdownPath: "Archive/page.md",
});
const NOTE_RULE: PrefixRelocationRuleV1 = Object.freeze({
  generation: 1,
  priorPrefix: "Notes",
  relocationId: parseRelocationId("rel_0123456789abcdefghjkmnpqrs"),
  replacementPrefix: "Archive",
});
const ROOT_RULE: PrefixRelocationRuleV1 = Object.freeze({
  generation: 2,
  priorPrefix: "Annotations",
  relocationId: parseRelocationId("rel_1123456789abcdefghjkmnpqrs"),
  replacementPrefix: "ArchiveAnnotations",
});

interface RepairFixtureV1 {
  readonly layout: SidecarStorageLayoutV1;
  readonly policy: SidecarStoragePolicyV1;
  readonly priorPath: string;
  readonly rules: readonly PrefixRelocationRuleV1[];
  readonly targetPath: string;
  readonly targetMarkdownPath: string;
}

interface RepairHarnessV1 {
  readonly codecKinds: readonly PersistenceCodecWorkV1["kind"][];
  readonly dispose: () => void;
  readonly frontmatter: FakeFrontMatterHost;
  readonly recovery: ReturnType<typeof createRecoveryHarness>;
  readonly request: Parameters<typeof repairRelocatedSidecarV1>[0];
  readonly vault: FakeVault;
}

it.each([
  {
    layout: { kind: "adjacent" } as const,
    policy: { mode: "adjacent", version: 1 } as const,
    priorPath: "Notes/page.inkbook.json",
    rules: [NOTE_RULE],
    targetPath: "Archive/page.inkbook.json",
    targetMarkdownPath: "Archive/page.md",
  },
  {
    layout: {
      kind: "vault-root",
      vaultRelativeRoot: "Annotations",
    } as const,
    policy: {
      mode: "vault-root",
      vaultRelativeRoot: "ArchiveAnnotations",
      version: 1,
    } as const,
    priorPath: "Annotations/Notes/page.inkbook.json",
    rules: [NOTE_RULE, ROOT_RULE],
    targetPath: "ArchiveAnnotations/Notes/page.inkbook.json",
    targetMarkdownPath: "Notes/page.md",
  },
])(
  "repairs $layout.kind metadata and locator through the durable saga",
  async (fixture) => {
    const harness = await repairHarness(fixture);

    const repaired = await openRuntimePersistenceV1(
      harness.request.open,
      harness.request.repository,
      harness.request.marker,
    );

    expect(repaired.kind).toBe("existing");
    const decoded = decodeInkbookSidecarV1(
      harness.vault.texts.get(fixture.targetPath) ?? "",
    );
    expect(decoded.kind).toBe("current");
    if (decoded.kind !== "current")
      throw new Error("Expected repaired sidecar.");
    expect(decoded.sidecar.noteIdentity.vaultRelativeMarkdownPath).toBe(
      fixture.targetMarkdownPath,
    );
    expect(decoded.sidecar.storageLayout).toEqual(
      harness.request.evidence.targetLayout,
    );
    expect(harness.frontmatter.frontmatter).toMatchObject({
      [ANNOTATION_MARKER_KEY]: true,
      [SIDECAR_LOCATOR_KEY]: fixture.targetPath,
    });
    expect(harness.recovery.relocations.size).toBe(0);
    expect(harness.codecKinds).toEqual([
      "parse-sidecar",
      "encode-sidecar",
      "parse-sidecar",
    ]);
    expect(harness.vault.processCalls).toBe(1);
    harness.dispose();
  },
);

it("fails closed for stale digest or layout evidence", async () => {
  const fixture = {
    layout: { kind: "adjacent" } as const,
    policy: { mode: "adjacent", version: 1 } as const,
    priorPath: "Notes/page.inkbook.json",
    rules: [NOTE_RULE],
    targetPath: "Archive/page.inkbook.json",
    targetMarkdownPath: "Archive/page.md",
  };
  const digestMismatch = await repairHarness(fixture, "different digest");
  await expect(
    repairRelocatedSidecarV1(digestMismatch.request),
  ).resolves.toBeNull();
  const layoutMismatch = await repairHarness(fixture, MARKDOWN, {
    kind: "vault-root",
    vaultRelativeRoot: "Other",
  });
  await expect(
    repairRelocatedSidecarV1(layoutMismatch.request),
  ).resolves.toBeNull();
  digestMismatch.dispose();
  layoutMismatch.dispose();
});

it("resumes an interrupted metadata repair on reopen", async () => {
  const harness = await repairHarness({
    layout: { kind: "adjacent" },
    policy: { mode: "adjacent", version: 1 },
    priorPath: "Notes/page.inkbook.json",
    rules: [NOTE_RULE],
    targetMarkdownPath: "Archive/page.md",
    targetPath: "Archive/page.inkbook.json",
  });
  harness.recovery.crashAfterStep("sidecar-metadata-saved");

  await expect(
    openRuntimePersistenceV1(
      harness.request.open,
      harness.request.repository,
      harness.request.marker,
    ),
  ).resolves.toEqual({ kind: "drift" });
  const reopened = await openRuntimePersistenceV1(
    harness.request.open,
    harness.request.repository,
    harness.request.marker,
  );

  expect(reopened.kind).toBe("existing");
  expect(harness.recovery.relocations.size).toBe(0);
  harness.dispose();
});

async function repairHarness(
  fixture: RepairFixtureV1,
  embeddedMarkdown = MARKDOWN,
  embeddedLayout = fixture.layout,
): Promise<RepairHarnessV1> {
  const digest = await requiredDigest(embeddedMarkdown);
  const currentDigest = await requiredDigest(MARKDOWN);
  const vault = new FakeVault();
  const rawText = preparedSidecarWrite(
    sidecar(digest, embeddedLayout),
    "desktop-tablet",
  ).rawText;
  const file = vault.addFile(fixture.targetPath, rawText);
  const note = vault.addFile(fixture.targetMarkdownPath, MARKDOWN);
  const frontmatter = new FakeFrontMatterHost({
    [ANNOTATION_MARKER_KEY]: true,
    [SIDECAR_LOCATOR_KEY]: fixture.priorPath,
  });
  const recovery = createRecoveryHarness();
  const workers = workerPorts();
  const codecKinds: PersistenceCodecWorkV1["kind"][] = [];
  const persistenceCodecPort: PersistenceCodecPortV1 = {
    submit: (work) => {
      codecKinds.push(work.kind);
      return workers.persistenceCodec.submit(work);
    },
  };
  const resolution = resolveRuntimeRelocatedSidecarV1({
    getFile: (path) => (path === fixture.targetPath ? file : null),
    identity: {
      ...TARGET_IDENTITY,
      vaultRelativeMarkdownPath: fixture.targetMarkdownPath,
    },
    policy: fixture.policy,
    resolution: { kind: "existing", sidecarPath: fixture.priorPath },
    rules: fixture.rules,
  });
  if (resolution.kind !== "existing" || resolution.relocation === undefined)
    throw new Error("Expected exact relocation evidence.");
  const repository = new VaultSidecarRepository(vault);
  const marker = new SidecarMarkerWriter(frontmatter);
  return {
    codecKinds,
    dispose: (): void => {
      marker.dispose();
      repository.dispose();
      workers.dispose();
    },
    frontmatter,
    recovery,
    request: {
      digestText: requiredDigest,
      evidence: resolution.relocation,
      loaded: {
        file,
        kind: "current" as const,
        rawText,
        sidecar: sidecar(digest, embeddedLayout),
      },
      markdownDigest: currentDigest,
      marker,
      open: {
        identity: {
          ...TARGET_IDENTITY,
          vaultRelativeMarkdownPath: fixture.targetMarkdownPath,
        },
        initialMarkdown: MARKDOWN,
        persistenceCodecPort,
        recovery: recovery.store,
        resolution,
        resolveMarkdownFile: (path: string): typeof note | null =>
          path === fixture.targetMarkdownPath ? note : null,
        settingsRevision: createSettingsRevision(1),
        sourceDigestWorkPort: workers.sourceDigest,
        vault,
        writableTier: "desktop-tablet" as const,
      },
      repository,
    },
    vault,
  };
}

function sidecar(
  markdownContentDigest: Awaited<ReturnType<typeof requiredDigest>>,
  storageLayout: SidecarStorageLayoutV1,
): InkbookSidecarV1 {
  return {
    baseRevision: null,
    format: "inkbook-obsidian-annotations",
    noteIdentity: {
      markdownContentDigest,
      sourceGeneration: createSourceGeneration(1),
      vaultRelativeMarkdownPath: PRIOR_IDENTITY.vaultRelativeMarkdownPath,
    },
    revision: 1,
    savedAtEpochMs: 1,
    scene: serializeRuntimeSceneStateV1(
      createRuntimeSceneStateV1({
        elements: [],
        groups: [],
        noteAppearance: {
          background: "none",
          contrast: "low",
          horizontalSpacing: "standard",
        },
        objectOrder: [],
        revision: createSceneRevision(0),
      }),
    ),
    schemaVersion: { major: 1, minor: 0 },
    storageLayout,
  };
}

async function requiredDigest(value: string): Promise<Sha256Digest> {
  const digest = await digestRuntimeTextV1(value);
  if (digest === null) throw new Error("Expected digest.");
  return digest;
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
