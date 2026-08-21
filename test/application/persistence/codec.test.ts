/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact schema and parser boundaries are intentional. */
import { describe, expect, it } from "vitest";

import {
  assertWritableSidecarSizeV1,
  decodeInkbookSidecarV1,
  encodeInkbookSidecarV1,
  SIDECAR_RESOURCE_LIMITS_V1,
  SIDECAR_WRITE_LIMITS_UTF8_BYTES_V1,
  validateInkbookSidecarV1,
} from "../../../src/application/persistence";
import { canonicalizeJson } from "../../../src/domain/codecs";
import { completeSidecar } from "./support";

function encodedText(): string {
  return new TextDecoder().decode(
    encodeInkbookSidecarV1(completeSidecar(), "phone"),
  );
}

function expectRejectedSidecar(
  mutator: (sidecar: Record<string, unknown>) => void,
): void {
  const sidecar = structuredClone(completeSidecar()) as unknown as Record<
    string,
    unknown
  >;
  mutator(sidecar);
  expect(() => validateInkbookSidecarV1(sidecar)).toThrow();
}

describe("Inkbook sidecar codec", () => {
  it("encodes current V1 as canonical UTF-8 with exactly one LF", () => {
    const source = completeSidecar();
    const bytes = encodeInkbookSidecarV1(source, "phone");
    const text = new TextDecoder().decode(bytes);

    expect(text).toBe(`${canonicalizeJson(source)}\n`);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(bytes.at(-1)).toBe(0x0a);
    expect(bytes[0]).not.toBe(0xef);
  });

  it("round-trips the complete scene into a deeply immutable V1 model", () => {
    const decoded = decodeInkbookSidecarV1(
      encodeInkbookSidecarV1(completeSidecar(), "phone"),
    );

    expect(decoded.kind).toBe("current");
    if (decoded.kind !== "current") return;
    expect(decoded.sidecar).toEqual(completeSidecar());
    expect(Object.isFrozen(decoded.sidecar)).toBe(true);
    expect(Object.isFrozen(decoded.sidecar.noteIdentity)).toBe(true);
    expect(Object.isFrozen(decoded.sidecar.storageLayout)).toBe(true);
    expect(Object.isFrozen(decoded.sidecar.scene)).toBe(true);
    expect(Object.isFrozen(decoded.sidecar.scene.elements)).toBe(true);
    expect(Object.isFrozen(decoded.sidecar.scene.elements[0]?.geometry)).toBe(
      true,
    );
  });

  it("recognizes newer major and minor versions as bounded read-only data", () => {
    const futureMinor = {
      ...completeSidecar(),
      schemaVersion: { major: 1, minor: 1 },
      futureField: { retainedOnlyInSource: true },
    };
    const futureMajor = {
      format: "inkbook-obsidian-annotations",
      schemaVersion: { major: 2, minor: 0 },
      replacementEnvelope: [1, 2, 3],
    };

    expect(
      decodeInkbookSidecarV1(`${canonicalizeJson(futureMinor)}\n`),
    ).toEqual({
      kind: "read-only-newer-version",
      schemaVersion: { major: 1, minor: 1 },
    });
    expect(decodeInkbookSidecarV1(canonicalizeJson(futureMajor))).toEqual({
      kind: "read-only-newer-version",
      schemaVersion: { major: 2, minor: 0 },
    });
  });
});

describe("Inkbook sidecar validation", () => {
  it("rejects unknown current fields and malformed envelope scalars", () => {
    expectRejectedSidecar((sidecar) => {
      sidecar.transientSelection = [];
    });
    expectRejectedSidecar((sidecar) => {
      sidecar.format = "inkbook";
    });
    expectRejectedSidecar((sidecar) => {
      sidecar.schemaVersion = { major: 1, minor: 0, patch: 1 };
    });
    expectRejectedSidecar((sidecar) => {
      sidecar.savedAtEpochMs = Number.POSITIVE_INFINITY;
    });
  });

  it("enforces digest, source generation, and direct revision ancestry", () => {
    expectRejectedSidecar((sidecar) => {
      sidecar.noteIdentity = {
        vaultRelativeMarkdownPath: "Notes/Example.md",
        markdownContentDigest: "A".repeat(64),
        sourceGeneration: 1,
      };
    });
    expectRejectedSidecar((sidecar) => {
      sidecar.noteIdentity = {
        vaultRelativeMarkdownPath: "Notes/Example.md",
        markdownContentDigest: "a".repeat(64),
        sourceGeneration: 0,
      };
    });
    expectRejectedSidecar((sidecar) => {
      sidecar.revision = 3;
      sidecar.baseRevision = 1;
    });

    const later = structuredClone(completeSidecar()) as unknown as Record<
      string,
      unknown
    >;
    later.revision = 2;
    later.baseRevision = 1;
    expect(validateInkbookSidecarV1(later).baseRevision).toBe(1);
  });

  it("enforces closed normalized storage and Markdown paths", () => {
    for (const root of [
      "",
      "/Annotations",
      "A//B",
      "A/../B",
      ".hidden/A",
      "A\\B",
    ]) {
      expectRejectedSidecar((sidecar) => {
        sidecar.storageLayout = {
          kind: "vault-root",
          vaultRelativeRoot: root,
        };
      });
    }
    expectRejectedSidecar((sidecar) => {
      sidecar.storageLayout = { kind: "adjacent", vaultRelativeRoot: "A" };
    });
    expectRejectedSidecar((sidecar) => {
      sidecar.noteIdentity = {
        vaultRelativeMarkdownPath: "Notes/Example.txt",
        markdownContentDigest: "a".repeat(64),
        sourceGeneration: 1,
      };
    });
  });

  it("rejects a storage discriminator accessor without invoking it", () => {
    let invoked = false;
    const storageLayout = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(storageLayout, "kind", {
      enumerable: true,
      get(): string {
        invoked = true;
        return "adjacent";
      },
    });

    expectRejectedSidecar((sidecar) => {
      sidecar.storageLayout = storageLayout;
    });
    expect(invoked).toBe(false);
  });

  it("rejects incomplete or non-canonical current scenes", () => {
    expectRejectedSidecar((sidecar) => {
      const source = structuredClone(
        completeSidecar().scene,
      ) as unknown as Record<string, unknown>;
      const objectOrder = source.objectOrder as readonly unknown[];
      source.objectOrder = objectOrder.slice(1);
      sidecar.scene = source;
    });
    expectRejectedSidecar((sidecar) => {
      sidecar.scene = { ...completeSidecar().scene, viewportBounds: {} };
    });
  });
});

describe("Inkbook sidecar parser limits", () => {
  it.each([
    ["phone", SIDECAR_WRITE_LIMITS_UTF8_BYTES_V1.phone],
    ["desktop-tablet", SIDECAR_WRITE_LIMITS_UTF8_BYTES_V1["desktop-tablet"]],
  ] as const)("enforces the %s write boundary", (tier, limit) => {
    expect(() => assertWritableSidecarSizeV1(limit - 1, tier)).not.toThrow();
    expect(() => assertWritableSidecarSizeV1(limit, tier)).not.toThrow();
    expect(() => assertWritableSidecarSizeV1(limit + 1, tier)).toThrow(
      /write byte limit/u,
    );
  });

  it("rejects BOM, malformed UTF-8, duplicate keys, and excessive nesting", () => {
    expect(() => decodeInkbookSidecarV1(`\ufeff${encodedText()}`)).toThrow(
      /BOM/u,
    );
    expect(() =>
      decodeInkbookSidecarV1(Uint8Array.from([0x7b, 0x22, 0xff, 0x22, 0x7d])),
    ).toThrow();
    expect(() =>
      decodeInkbookSidecarV1(
        '{"format":"inkbook-obsidian-annotations","format":"inkbook-obsidian-annotations"}',
      ),
    ).toThrow(/duplicate-key/u);
    expect(() =>
      decodeInkbookSidecarV1(`${"[".repeat(65)}null${"]".repeat(65)}`),
    ).toThrow(/nesting-limit/u);
  });

  it("admits the 16 MiB boundary to parsing and rejects immediately over", () => {
    const ceiling = SIDECAR_RESOURCE_LIMITS_V1.maxUtf8Bytes;
    const atLimit = `${" ".repeat(ceiling - 2)}{}`;
    const overLimit = `${atLimit} `;

    expect(() => decodeInkbookSidecarV1(atLimit)).toThrow(
      /Sidecar format is unsupported/u,
    );
    expect(() => decodeInkbookSidecarV1(overLimit)).toThrow(/utf8-byte-limit/u);
  });
});
