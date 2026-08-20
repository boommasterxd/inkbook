import { describe, expect, it } from "vitest";

import {
  parseRelocationId,
  type NoteIdentityV1,
} from "../../../src/application/note-session";
import type { PrefixRelocationRuleV1 } from "../../../src/application/persistence";
import type { RuntimeSidecarResolutionV1 } from "../../../src/adapters/obsidian/runtime-sidecar-resolution";
import {
  resolveRuntimeRelocatedSidecarV1,
  resolveRuntimeSidecarMarkerV1,
} from "../../../src/adapters/obsidian/runtime-persistence-open";

const IDENTITY: NoteIdentityV1 = Object.freeze({
  vaultIdHint: "vault-runtime",
  vaultRelativeMarkdownPath: "Archive/page.md",
});
const RULE: PrefixRelocationRuleV1 = Object.freeze({
  generation: 2,
  priorPrefix: "Notes",
  relocationId: parseRelocationId("rel_0123456789abcdefghjkmnpqrs"),
  replacementPrefix: "Archive",
});
const ROOT_RULE: PrefixRelocationRuleV1 = Object.freeze({
  generation: 3,
  priorPrefix: "Archive",
  relocationId: parseRelocationId("rel_1123456789abcdefghjkmnpqrs"),
  replacementPrefix: "Archive/Archive",
});

describe("resolveRuntimeRelocatedSidecarV1", () => {
  it("resolves one concrete adjacent target through retained rules", () => {
    expect(
      resolveRuntimeRelocatedSidecarV1({
        getFile: (path) =>
          path === "Archive/page.inkbook.json"
            ? { path, stat: { size: 1 } }
            : null,
        identity: IDENTITY,
        policy: { mode: "adjacent", version: 1 },
        resolution: {
          kind: "existing",
          sidecarPath: "Notes/page.inkbook.json",
        },
        rules: [RULE],
      }),
    ).toEqual({
      kind: "existing",
      relocation: {
        priorSidecarPath: "Notes/page.inkbook.json",
        relocationIds: [RULE.relocationId],
        rules: [RULE],
        targetLayout: { kind: "adjacent" },
        targetSidecarPath: "Archive/page.inkbook.json",
      },
      sidecarPath: "Archive/page.inkbook.json",
    });
  });

  it("blocks when adjacent and vault-root candidates are both concrete", () => {
    expect(
      resolveRuntimeRelocatedSidecarV1({
        getFile: (path) => ({ path, stat: { size: 1 } }),
        identity: IDENTITY,
        policy: {
          mode: "vault-root",
          vaultRelativeRoot: "Archive",
          version: 1,
        },
        resolution: {
          kind: "existing",
          sidecarPath: "Notes/page.inkbook.json",
        },
        rules: [RULE, ROOT_RULE],
      }),
    ).toEqual({ kind: "blocked" });
  });

  it("fails closed before retained rules load or without a concrete target", () => {
    const request = {
      getFile: (): null => null,
      identity: IDENTITY,
      policy: { mode: "adjacent", version: 1 } as const,
      resolution: {
        kind: "existing",
        sidecarPath: "Notes/page.inkbook.json",
      } as const,
    };
    expect(
      resolveRuntimeRelocatedSidecarV1({ ...request, rules: null }),
    ).toEqual({ kind: "blocked" });
    expect(
      resolveRuntimeRelocatedSidecarV1({ ...request, rules: [RULE] }),
    ).toEqual({ kind: "blocked" });
  });
});

describe("resolveRuntimeSidecarMarkerV1", () => {
  const policy = {
    mode: "vault-root",
    vaultRelativeRoot: "Annotations",
    version: 1,
  } as const;
  const resolve = (frontmatter: unknown): RuntimeSidecarResolutionV1 =>
    resolveRuntimeSidecarMarkerV1({
      identity: IDENTITY,
      metadata: { kind: "available", frontmatter },
      normalizePath: (path) => path,
      policy,
    });

  it("blocks unavailable metadata and invalid marker evidence specifically", () => {
    expect(
      resolveRuntimeSidecarMarkerV1({
        identity: IDENTITY,
        metadata: { kind: "unavailable" },
        normalizePath: (path) => path,
        policy,
      }),
    ).toEqual({ kind: "blocked", reason: "metadata-unavailable" });
    expect(resolve(null)).toEqual({
      kind: "blocked",
      reason: "invalid-marker",
    });
    expect(resolve({ "inkbook-annotations": "yes" })).toEqual({
      kind: "blocked",
      reason: "invalid-marker",
    });
  });

  it("validates locators before exposing an existing sidecar", () => {
    expect(
      resolve({
        "inkbook-annotations": true,
        "inkbook-sidecar": "../Other.inkbook.json",
      }),
    ).toEqual({ kind: "blocked", reason: "invalid-locator" });
    expect(
      resolve({
        "inkbook-annotations": true,
        "inkbook-sidecar": "Archive/page.inkbook.json",
      }),
    ).toEqual({
      kind: "existing",
      sidecarPath: "Archive/page.inkbook.json",
    });
  });

  it("derives only adjacent and current-policy discovery candidates", () => {
    expect(resolve({ "inkbook-annotations": true })).toEqual({
      allowUnannotated: false,
      candidatePaths: [
        "Archive/page.inkbook.json",
        "Annotations/Archive/page.inkbook.json",
      ],
      creationPath: "Annotations/Archive/page.inkbook.json",
      kind: "discovery",
      markerState: "legacy",
    });
    expect(resolve(undefined)).toMatchObject({
      allowUnannotated: true,
      kind: "discovery",
      markerState: "missing",
    });
    expect(
      resolve({
        "inkbook-annotations": false,
        "inkbook-sidecar": "Archive/page.inkbook.json",
      }),
    ).toMatchObject({
      allowUnannotated: false,
      candidatePaths: ["Archive/page.inkbook.json"],
      kind: "discovery",
      markerState: "false",
    });
  });
});
