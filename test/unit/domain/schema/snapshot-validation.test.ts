import { describe, expect, it } from "vitest";

import {
  FILE_SCHEMA_LIMITS,
  MAX_STROKE_POINTS,
  validateInkSnapshotV1,
} from "../../../../src/domain/schema/public";
import { validateInkSnapshotV1Steps } from "../../../../src/domain/schema/snapshot-validation";
import { observeSchemaArray } from "../../../fixtures/domain/schema-array-work";
import { arrow, line, rectangle, snapshot, straightHighlighter, stroke, uuid } from "./fixtures";

describe("InkSnapshotV1 validation", () => {
  it("accepts an empty snapshot and a connected, partitioned document", () => {
    expect(validateInkSnapshotV1(snapshot()).ok).toBe(true);
    const highlight = stroke(1, "highlighter");
    const document = snapshot([highlight, straightHighlighter(2), rectangle(3), line(4)]);
    const elementWork = observeSchemaArray(document.elements);
    const pointWork = observeSchemaArray(highlight.points);
    highlight.points = pointWork.observed;
    document.elements = elementWork.observed;
    const steps = validateInkSnapshotV1Steps(document);
    let step;
    do {
      const beforeElements = elementWork.work.indexedReads;
      const beforePoints = pointWork.work.indexedReads;
      step = steps.next();
      // Relations have four passes; this four-element document fits in one final slice.
      expect(elementWork.work.indexedReads - beforeElements).toBeLessThanOrEqual(4 * 4);
      // Validation reads x/y/pressure once; bounds read x/y once for each endpoint.
      expect(pointWork.work.indexedReads - beforePoints).toBeLessThanOrEqual(6);
    } while (!step.done);
    expect(elementWork.work.indexedReads).toBeGreaterThan(0);
    expect(elementWork.work.indexedReads).toBeLessThanOrEqual(5 * 4);
    expect(pointWork.work.indexedReads).toBeGreaterThan(0);
    expect(pointWork.work.indexedReads).toBeLessThanOrEqual(6 + 4);
    expect(elementWork.work.descriptorReads).toBeLessThanOrEqual(5 * 4);
    expect(pointWork.work.descriptorReads).toBeLessThanOrEqual(5 * 6);
    const result = step.value;
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
    document.page.activeBufferLines = 8;
    document.page.lockedBufferLines = 0;
    document.page.background = { type: "dots", spacing: 100 };
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
      "obsolete writing height",
      { ...snapshot(), page: { ...snapshot().page, writingLineHeight: 201 } },
      "unknown-property",
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

  it("accepts line and arrow endpoint anchors and follows an acyclic chain", () => {
    const target = line(4);
    target.startConnection = null;
    const dependent = arrow(5);
    dependent.start = { ...target.end };
    dependent.end = { x: 400, y: 150 };
    dependent.pivot = { x: 350, y: 150 };
    dependent.startConnection = {
      targetId: target.id,
      anchor: { kind: "linear-endpoint", endpoint: "end" },
    };

    const result = validateInkSnapshotV1(snapshot([target, dependent]));

    expect(result).toMatchObject({ ok: true, statistics: { connectedEndpoints: 1 } });
  });

  it("rejects self-connections and cycles between linear elements", () => {
    const self = line(4);
    self.startConnection = {
      targetId: self.id,
      anchor: { kind: "linear-endpoint", endpoint: "start" },
    };
    expectValidationCode(snapshot([self]), "invalid-connection-target");

    const first = line(4);
    const second = line(5);
    first.startConnection = {
      targetId: second.id,
      anchor: { kind: "linear-endpoint", endpoint: "start" },
    };
    second.startConnection = {
      targetId: first.id,
      anchor: { kind: "linear-endpoint", endpoint: "start" },
    };
    expectValidationCode(snapshot([first, second]), "invalid-connection-target");
  });
});

describe("InkSnapshotV1 limits and security validation", () => {
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
    const entries = observeSchemaArray(new Array<null>(MAX_STROKE_POINTS * 3 + 1).fill(null));
    document.untrusted = entries.observed;
    const steps = validateInkSnapshotV1Steps(document);

    const first = steps.next();

    expect(entries.work).toEqual({ indexedReads: 0, descriptorReads: 0 });
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
    const entries = observeSchemaArray<null>(new Array<null>(4096).fill(null));
    document.untrusted = entries.observed;
    const steps = validateInkSnapshotV1Steps(document);

    let result = steps.next();
    let previousReads = 0;
    expect(result.done).toBe(false);
    while (!result.done) {
      // Array enumeration and reverse data checks each inspect two descriptors
      // per entry; every preflight pass now stops at the shared node interval.
      expect(entries.work.descriptorReads - previousReads).toBeLessThanOrEqual(2 * 2048);
      previousReads = entries.work.descriptorReads;
      result = steps.next();
    }
    expect(result).toMatchObject({
      done: true,
      value: { ok: false, error: { code: "unknown-property" } },
    });
    expect(entries.work.descriptorReads - previousReads).toBeLessThanOrEqual(2 * 2048);
    expect(entries.work.descriptorReads).toBeLessThanOrEqual(5 * 4096);
    expect(entries.work.indexedReads).toBe(0);
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
