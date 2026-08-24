import { describe, expect, it } from "vitest";

import { FILE_SCHEMA_LIMITS, validateInkSnapshotV1 } from "../../../../src/domain/schema/public";
import { validateInkSnapshotV1Steps } from "../../../../src/domain/schema/snapshot-validation";
import { line, rectangle, snapshot, straightHighlighter, stroke, uuid } from "./fixtures";

describe("InkSnapshotV1 validation", () => {
  it("accepts an empty snapshot and a connected, partitioned document", () => {
    expect(validateInkSnapshotV1(snapshot()).ok).toBe(true);
    const document = snapshot([
      stroke(1, "highlighter"),
      straightHighlighter(2),
      rectangle(3),
      line(4),
    ]);
    const result = validateInkSnapshotV1(document);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.statistics).toMatchObject({
        elements: 4,
        strokes: 1,
        strokePoints: 2,
        connectedEndpoints: 1,
      });
    }
  });

  it("accepts page and revision boundary values", () => {
    const document = snapshot();
    document.revision = Number.MAX_SAFE_INTEGER;
    document.page.writingLineHeight = 50;
    document.page.activeBufferLines = 8;
    document.page.lockedBufferLines = 0;
    document.page.background = { type: "dots", spacing: 80 };
    expect(validateInkSnapshotV1(document).ok).toBe(true);
  });

  it.each([
    ["root property", { ...snapshot(), script: "alert(1)" }, "unknown-property"],
    ["format", { ...snapshot(), format: "other" }, "invalid-literal"],
    ["version", { ...snapshot(), version: 2 }, "invalid-literal"],
    ["revision", { ...snapshot(), revision: -1 }, "invalid-number"],
    ["unsafe revision", { ...snapshot(), revision: Number.MAX_SAFE_INTEGER + 1 }, "invalid-number"],
    [
      "page width",
      { ...snapshot(), page: { ...snapshot().page, innerWidth: 1999 } },
      "invalid-literal",
    ],
    [
      "line spacing",
      { ...snapshot(), page: { ...snapshot().page, background: { type: "lines", spacing: 20 } } },
      "invalid-literal",
    ],
    [
      "writing height",
      { ...snapshot(), page: { ...snapshot().page, writingLineHeight: 201 } },
      "invalid-range",
    ],
    [
      "active buffer",
      { ...snapshot(), page: { ...snapshot().page, activeBufferLines: 0 } },
      "invalid-range",
    ],
  ])("rejects invalid %s", (_name, value, code) => {
    const result = validateInkSnapshotV1(value);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe(code);
  });

  it("rejects duplicate IDs and highlight elements after content", () => {
    const duplicate = validateInkSnapshotV1(snapshot([rectangle(1), stroke(1)]));
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe("duplicate-id");

    const bandOrder = validateInkSnapshotV1(snapshot([rectangle(1), stroke(2, "highlighter")]));
    expect(bandOrder.ok).toBe(false);
    if (!bandOrder.ok) expect(bandOrder.error.code).toBe("invalid-render-band-order");
  });
});

describe("InkSnapshotV1 relational and security validation", () => {
  it("rejects dangling, incompatible, and displaced connections", () => {
    const toleranceEdge = line();
    toleranceEdge.start = { x: 200.001, y: 150 };
    expect(validateInkSnapshotV1(snapshot([rectangle(), toleranceEdge])).ok).toBe(true);

    const dangling = line();
    dangling.startConnection = { ...dangling.startConnection!, targetId: uuid(99) };
    expectValidationCode(snapshot([rectangle(), dangling]), "invalid-connection-target");

    const incompatible = line();
    incompatible.startConnection = {
      targetId: rectangle().id,
      anchor: { kind: "ellipse-cardinal", angle: 0 },
    };
    expectValidationCode(snapshot([rectangle(), incompatible]), "invalid-anchor");

    const displaced = line();
    displaced.start = { x: 200.001, y: 150.001 };
    expectValidationCode(snapshot([rectangle(), displaced]), "connection-position-mismatch");
  });

  it("enforces connected-endpoint and per-target limits", () => {
    const first = line(4);
    const second = line(5);
    second.end = { x: 350, y: 150 };
    const limits = { ...FILE_SCHEMA_LIMITS, connectedEndpointsPerTarget: 1 };
    const result = validateInkSnapshotV1(snapshot([rectangle(), first, second]), { limits });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("connection-limit-exceeded");
  });

  it("enforces byte and element limits at exact boundaries", () => {
    expect(
      validateInkSnapshotV1(snapshot(), {
        totalInputBytes: FILE_SCHEMA_LIMITS.totalInputBytes,
        metadataBytes: FILE_SCHEMA_LIMITS.metadataBytes,
      }).ok,
    ).toBe(true);
    expectValidationCode(snapshot(), "input-byte-limit-exceeded", {
      totalInputBytes: FILE_SCHEMA_LIMITS.totalInputBytes + 1,
    });
    expectValidationCode(snapshot(), "metadata-byte-limit-exceeded", {
      metadataBytes: FILE_SCHEMA_LIMITS.metadataBytes + 1,
    });
    expectValidationCode(snapshot([rectangle()]), "element-limit-exceeded", {
      limits: { ...FILE_SCHEMA_LIMITS, elements: 0 },
    });
  });

  it("rejects excessive derived height", () => {
    const tall = rectangle();
    tall.y = 999_800;
    tall.pivot.y = 999_850;
    expectValidationCode(snapshot([tall]), "invalid-range");
  });

  it("rejects non-finite values, sparse arrays, extra array properties, and excessive depth", () => {
    const nonFinite = snapshot([stroke()]);
    nonFinite.elements[0]!.pivot.x = Number.NaN;
    expectValidationCode(nonFinite, "invalid-number");

    const sparse = snapshot();
    sparse.elements = Array(1) as never[];
    expectValidationCode(sparse, "invalid-json-value");

    const extra = snapshot();
    Object.assign(extra.elements, { unsafe: true });
    expectValidationCode(extra, "invalid-json-value");

    let nested: unknown = [];
    for (let depth = 0; depth < 17; depth += 1) nested = [nested];
    expectValidationCode(nested, "maximum-depth-exceeded");
  });

  it("turns hostile proxy inspection into a safe validation failure", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("hostile trap");
        },
      },
    );
    const result = validateInkSnapshotV1(hostile);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid-json-value");
  });
});

describe("InkSnapshotV1 spatial capacity validation", () => {
  it("computes and enforces retained spatial-index cell memberships", () => {
    const document = snapshot([rectangle()]);
    const accepted = validateInkSnapshotV1(document);

    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      expect(accepted.statistics).toMatchObject({
        spatialIndexCellMemberships: 1,
        spatialIndexOverflowElements: 0,
      });
    }
    expectValidationCode(document, "spatial-index-limit-exceeded", {
      limits: { ...FILE_SCHEMA_LIMITS, spatialIndexCellMemberships: 0 },
    });
  });
});

describe("InkSnapshotV1 bounded JSON-tree inspection", () => {
  it("rejects over-wide containers before enumerating their siblings", () => {
    const document = snapshot() as unknown as Record<string, unknown>;
    document.untrusted = new Array(FILE_SCHEMA_LIMITS.elements + 1).fill(null);
    const steps = validateInkSnapshotV1Steps(document);

    const first = steps.next();

    expect(first.done).toBe(true);
    if (first.done) {
      expect(first.value).toMatchObject({
        ok: false,
        error: { code: "json-node-limit-exceeded", path: "$.untrusted" },
      });
    }
  });

  it("keeps valid-width container inspection incremental", () => {
    const document = snapshot() as unknown as Record<string, unknown>;
    document.untrusted = new Array(4096).fill(null);
    const steps = validateInkSnapshotV1Steps(document);

    expect(steps.next()).toEqual({ done: false, value: undefined });
    const result = steps.next();

    expect(result.done).toBe(false);
  });
});

function expectValidationCode(
  value: unknown,
  code: string,
  options: Parameters<typeof validateInkSnapshotV1>[1] = {},
): void {
  const result = validateInkSnapshotV1(value, options);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe(code);
}
