import { describe, expect, it } from "vitest";
import type { ArrowElementV1, LineElementV1 } from "../../../../src/domain/schema/public";
import {
  decodeCustomClipboardText,
  encodeRuntimeSelection,
  resolveClipboardPayload,
} from "../../../../src/persistence/clipboard/codec";
import { INKBOOK_CLIPBOARD_TEXT_PREFIX } from "../../../../src/persistence/clipboard/constants";
import { validateClipboardPayload } from "../../../../src/persistence/clipboard/validation";
import {
  arrow,
  ARROW_ID,
  EXTERNAL_ID,
  rectangle,
  RECTANGLE_ID,
  selectedElements,
  spatialRectangle,
} from "./fixtures";

describe("clipboard codec", () => {
  it("encodes identities as compact clip IDs and preserves internal connections", () => {
    const encoded = encodeRuntimeSelection(selectedElements(), new Set([RECTANGLE_ID, ARROW_ID]));

    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.value.payload.elements.map(({ clipId }) => clipId)).toEqual(["0", "1"]);
    expect(encoded.value.plainText).toBe(
      `${INKBOOK_CLIPBOARD_TEXT_PREFIX}${encoded.value.compactJson}`,
    );
    expect(encoded.value.customText).toBe(encoded.value.compactJson);
    expect(encoded.value.compactJson).not.toContain(RECTANGLE_ID);
    expect(encoded.value.compactJson).not.toContain('"createdAt"');

    const body = encoded.value.payload.elements[1]?.element;
    expect(body?.kind).toBe("arrow");
    if (body?.kind === "arrow") expect(body.startConnection?.targetClipId).toBe("0");
  });

  it("detaches connections to targets outside the exact selection", () => {
    const externalArrow = arrow(EXTERNAL_ID);
    const encoded = encodeRuntimeSelection([externalArrow], new Set([ARROW_ID]));

    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const body = encoded.value.payload.elements[0]?.element;
    expect(body?.kind === "arrow" ? body.startConnection : undefined).toBeNull();
    expect(body?.kind === "arrow" ? body.start : undefined).toEqual({ x: 100, y: 100 });
  });

  it("rejects missing selection records without producing a partial payload", () => {
    const encoded = encodeRuntimeSelection([rectangle()], new Set([RECTANGLE_ID, ARROW_ID]));

    expect(encoded).toEqual({
      ok: false,
      error: { code: "missing-selection", message: "The selection contains an unknown element." },
    });
  });

  it("uses the first valid source in custom, plain, session priority order", () => {
    const encoded = encodeRuntimeSelection([rectangle()], new Set([RECTANGLE_ID]));
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;

    const resolved = resolveClipboardPayload({
      customText: "not json",
      plainText: encoded.value.plainText,
      sessionText: encoded.value.compactJson,
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.source).toBe("plain");

    const custom = resolveClipboardPayload({
      customText: encoded.value.customText,
      plainText: encoded.value.plainText,
      sessionText: encoded.value.compactJson,
    });
    expect(custom.ok).toBe(true);
    if (custom.ok) expect(custom.value.source).toBe("custom");
  });

  it("canonicalizes valid noncanonical JSON without changing the decoded payload", () => {
    const encoded = encodeRuntimeSelection([rectangle()], new Set([RECTANGLE_ID]));
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const noncanonical = JSON.stringify(encoded.value.payload, null, 2);

    const decoded = decodeCustomClipboardText(noncanonical);

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.compactJson).toBe(encoded.value.compactJson);
    expect(decoded.value.payload).toEqual(encoded.value.payload);
  });

  it("preserves connections to selected line and arrow endpoints", () => {
    const [target, dependent] = linearSelection();
    const encoded = encodeRuntimeSelection([target, dependent], new Set([target.id, dependent.id]));

    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const body = encoded.value.payload.elements[1]?.element;
    expect(body?.kind).toBe("arrow");
    if (body?.kind === "arrow") {
      expect(body.startConnection).toEqual({
        anchor: { endpoint: "end", kind: "linear-endpoint" },
        targetClipId: "0",
      });
    }
    expect(decodeCustomClipboardText(encoded.value.customText)).toMatchObject({ ok: true });

    const incompatible = structuredClone(encoded.value.payload);
    const incompatibleBody = incompatible.elements[1]?.element;
    if (incompatibleBody?.kind === "arrow" && incompatibleBody.startConnection !== null) {
      incompatibleBody.startConnection.anchor = { kind: "box", position: "top-left" };
    }
    expect(validateClipboardPayload(incompatible).ok).toBe(false);
  });
});

describe("clipboard validation", () => {
  it("rejects unknown properties, duplicate clip IDs, and dangling connections", () => {
    const encoded = encodeRuntimeSelection(selectedElements(), new Set([RECTANGLE_ID, ARROW_ID]));
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;

    const unknownProperty = structuredClone(encoded.value.payload) as unknown as {
      unexpected: boolean;
    };
    unknownProperty.unexpected = true;
    expect(validateClipboardPayload(unknownProperty).ok).toBe(false);

    const duplicate = structuredClone(encoded.value.payload);
    duplicate.elements[1]!.clipId = duplicate.elements[0]!.clipId;
    expect(validateClipboardPayload(duplicate).ok).toBe(false);

    const dangling = structuredClone(encoded.value.payload);
    const danglingBody = dangling.elements[1]!.element;
    if (danglingBody.kind === "arrow" && danglingBody.startConnection !== null) {
      danglingBody.startConnection.targetClipId = "missing";
    }
    expect(validateClipboardPayload(dangling).ok).toBe(false);

    const identityLeak = structuredClone(encoded.value.payload) as unknown as {
      elements: Array<{ element: { id?: string } }>;
    };
    identityLeak.elements[0]!.element.id = RECTANGLE_ID;
    expect(validateClipboardPayload(identityLeak).ok).toBe(false);
  });

  it("rejects a highlight element after the content band has begun", () => {
    const highlighter = {
      id: "44444444-4444-4444-8444-444444444444",
      createdAt: 1_002,
      kind: "stroke" as const,
      tool: "highlighter" as const,
      points: [10, 10, 0.5],
      rotation: 0,
      pivot: { x: 10, y: 10 },
      style: {
        color: { type: "theme-text" as const },
        width: 8 as const,
        opacity: 0.5,
        pressureEnabled: false,
        smoothing: 0.5 as const,
      },
    };
    const encoded = encodeRuntimeSelection(
      [highlighter, rectangle()],
      new Set([highlighter.id, RECTANGLE_ID]),
    );
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    encoded.value.payload.elements.reverse();
    expect(validateClipboardPayload(encoded.value.payload).ok).toBe(false);
  });

  it("rejects malformed and over-nested input before domain adoption", () => {
    expect(decodeCustomClipboardText("{").ok).toBe(false);
    const nested = `${"[".repeat(17)}0${"]".repeat(17)}`;
    expect(decodeCustomClipboardText(nested)).toMatchObject({
      ok: false,
      error: { code: "invalid-schema" },
    });
  });
});

describe("clipboard aggregate validation", () => {
  it("enforces aggregate spatial-index cell memberships", () => {
    const payload = (count: number) => ({
      format: "inkbook-elements" as const,
      version: 1 as const,
      elements: Array.from({ length: count }, (_, index) => {
        const { id: _id, createdAt: _createdAt, ...element } = spatialRectangle(index);
        return { clipId: String(index), element };
      }),
    });

    expect(validateClipboardPayload(payload(1_092)).ok).toBe(true);
    const rejected = validateClipboardPayload(payload(1_093));
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.error).toMatchObject({ code: "invalid-schema" });
    expect(rejected.error.message).toMatch(/spatial-index capacity/);
  });

  it("rejects self-connections and cycles between clipboard linear elements", () => {
    const [target] = linearSelection();
    const self = encodePayload([target]);
    const selfBody = self.elements[0]?.element;
    if (selfBody?.kind !== "line") throw new Error("Expected a line clipboard body.");
    selfBody.startConnection = {
      targetClipId: "0",
      anchor: { endpoint: "start", kind: "linear-endpoint" },
    };
    expect(validateClipboardPayload(self).ok).toBe(false);

    const cycle = encodePayload(linearSelection());
    const firstBody = cycle.elements[0]?.element;
    const secondBody = cycle.elements[1]?.element;
    if (firstBody?.kind !== "line" || secondBody?.kind !== "arrow") {
      throw new Error("Expected line and arrow clipboard bodies.");
    }
    firstBody.endConnection = {
      targetClipId: "1",
      anchor: { endpoint: "start", kind: "linear-endpoint" },
    };
    secondBody.endConnection = {
      targetClipId: "0",
      anchor: { endpoint: "end", kind: "linear-endpoint" },
    };
    expect(validateClipboardPayload(cycle).ok).toBe(false);
  });
});

function encodePayload(elements: readonly (LineElementV1 | ArrowElementV1)[]) {
  const encoded = encodeRuntimeSelection(elements, new Set(elements.map(({ id }) => id)));
  if (!encoded.ok) throw new Error(encoded.error.message);
  return encoded.value.payload;
}

function linearSelection(): [LineElementV1, ArrowElementV1] {
  const target: LineElementV1 = {
    ...arrow(),
    end: { x: 200, y: 100 },
    endNode: "none",
    id: RECTANGLE_ID,
    kind: "line",
    pivot: { x: 150, y: 100 },
    start: { x: 100, y: 100 },
    startConnection: null,
    startNode: "none",
  };
  const dependent: ArrowElementV1 = {
    ...arrow(target.id),
    end: { x: 300, y: 100 },
    id: ARROW_ID,
    pivot: { x: 250, y: 100 },
    start: { x: 200, y: 100 },
    startConnection: {
      anchor: { endpoint: "end", kind: "linear-endpoint" },
      targetId: target.id,
    },
  };
  return [target, dependent];
}
