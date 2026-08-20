import { describe, expect, it } from "vitest";

import { deriveRelocatedStorageRootV1 } from "../../../src/application/persistence";

describe("storage-root relocation derivation", () => {
  it("replaces an exact storage root", () => {
    expect(
      deriveRelocatedStorageRootV1({
        currentRoot: "Annotations",
        priorPrefix: "Annotations",
        replacementPrefix: "Inkbook",
      }),
    ).toEqual({
      ok: true,
      value: { kind: "replacement", vaultRelativeRoot: "Inkbook" },
    });
  });

  it("preserves the descendant suffix", () => {
    expect(
      deriveRelocatedStorageRootV1({
        currentRoot: "Notes/Annotations",
        priorPrefix: "Notes",
        replacementPrefix: "Archive",
      }),
    ).toEqual({
      ok: true,
      value: {
        kind: "replacement",
        vaultRelativeRoot: "Archive/Annotations",
      },
    });
  });

  it("does not treat a sibling string prefix as affected", () => {
    expect(
      deriveRelocatedStorageRootV1({
        currentRoot: "Notes-Archive/Annotations",
        priorPrefix: "Notes",
        replacementPrefix: "Archive",
      }),
    ).toEqual({
      ok: true,
      value: {
        kind: "not-affected",
        vaultRelativeRoot: "Notes-Archive/Annotations",
      },
    });
  });

  it.each([
    {
      currentRoot: ".obsidian/Annotations",
      priorPrefix: "Notes",
      replacementPrefix: "Archive",
    },
    {
      currentRoot: "Notes/Annotations",
      priorPrefix: ".hidden",
      replacementPrefix: "Archive",
    },
    {
      currentRoot: "Notes/Annotations",
      priorPrefix: "Notes",
      replacementPrefix: "Archive/.hidden",
    },
    {
      currentRoot: "Notes/Annotations",
      priorPrefix: "Notes",
      replacementPrefix: "Notes",
    },
  ])("fails closed for invalid request %#", (request) => {
    expect(deriveRelocatedStorageRootV1(request)).toEqual({
      code: "invalid-command",
      ok: false,
    });
  });

  it("fails closed when the current root matches source and destination", () => {
    expect(
      deriveRelocatedStorageRootV1({
        currentRoot: "Notes/Archive/Annotations",
        priorPrefix: "Notes",
        replacementPrefix: "Notes/Archive",
      }),
    ).toEqual({ code: "sidecar-conflict", ok: false });
  });
});
