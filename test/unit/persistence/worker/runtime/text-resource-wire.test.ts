import { expect, it } from "vitest";
import {
  decodeRuntimeRequestChunked,
  decodeRuntimeResult,
  encodeRuntimeRequest,
  encodeRuntimeRequestChunked,
  encodeRuntimeResult,
} from "../../../../../src/persistence/worker/runtime/wire/wire-codec";
import {
  encodeRuntimeSelection,
  resolveClipboardPayload,
} from "../../../../../src/persistence/clipboard/codec";
import { validFontResource, textElement } from "../../clipboard/fixtures";
import { snapshot, executor } from "./fixtures";
import { textTableFrame } from "../../../../fixtures/domain/text-table";

const identity = { ...executor, operationId: 2, purpose: "clipboard" as const };
const context = { checkpoint: () => undefined, signal: new AbortController().signal };

it("preserves text and font resources in clipboard and full/incremental model wire headers", async () => {
  const element = textElement();
  element.ranges = [
    {
      start: 0,
      end: 2,
      style: { backgroundColor: { type: "rgba", value: "#113399FF" }, backgroundOpacity: 0.125 },
    },
  ];
  element.layout.lines[0]!.runs[0]!.style = element.ranges[0]!.style;
  element.layout.tables = [textTableFrame(element.source.length)];
  const fontResources = [await validFontResource()];
  const encoded = encodeRuntimeSelection([element], new Set([element.id]), fontResources);
  if (!encoded.ok) throw new Error(encoded.error.message);
  const decoded = resolveClipboardPayload({ customText: encoded.value.customText });
  const result = decodeRuntimeResult(
    encodeRuntimeResult({ type: "clipboard-decode-success", identity, result: decoded }).value,
  );
  expect(result).toMatchObject({
    type: "clipboard-decode-success",
    result: {
      ok: true,
      value: {
        payload: {
          version: 2,
          fontResources,
          elements: [
            { element: { ranges: element.ranges, layout: { tables: element.layout.tables } } },
          ],
        },
      },
    },
  });

  const full = {
    type: "model-sync-full" as const,
    baseModelRevision: null,
    identity,
    modelRevision: 0,
    snapshot: { ...snapshot(), version: 2 as const, elements: [element], fontResources },
  };
  expect(await decodeRuntimeRequestChunked(encodeRuntimeRequest(full).value, context)).toEqual(
    full,
  );
  const incremental = {
    type: "model-sync-incremental" as const,
    baseModelRevision: 0,
    identity,
    modelRevision: 1,
    changedElements: [element],
    fontResources,
  };
  expect(
    await decodeRuntimeRequestChunked(encodeRuntimeRequest(incremental).value, context),
  ).toEqual(incremental);
});

it("cooperatively captures large text layout headers and abandons cancelled transfers", async () => {
  const element = textElement("x".repeat(2_048));
  element.layout.lines = Array.from({ length: 64 }, (_, line) => ({
    x: 0,
    y: line * 30,
    width: 320,
    height: 30,
    baseline: 20,
    runs: Array.from({ length: 32 }, (_, run) => ({
      text: "x",
      start: line * 32 + run,
      end: line * 32 + run + 1,
      x: run * 10,
      width: 10,
    })),
  }));
  const request = {
    type: "model-sync-full" as const,
    baseModelRevision: null,
    identity,
    modelRevision: 0,
    snapshot: {
      ...snapshot(),
      version: 2 as const,
      elements: [element],
      fontResources: [await validFontResource()],
    },
  };
  let checkpoints = 0;
  const encoded = await encodeRuntimeRequestChunked(request, {
    signal: new AbortController().signal,
    checkpoint: () => {
      checkpoints += 1;
      return undefined;
    },
  });
  expect(checkpoints).toBeGreaterThan(32);
  element.layout.lines[0]!.runs[0]!.text = "changed";
  const decoded = await decodeRuntimeRequestChunked(encoded.value, context);
  if (decoded.type !== "model-sync-full") throw new Error("Expected a full synchronization.");
  const copied = decoded.snapshot.elements[0]!;
  if (copied.kind !== "text") throw new Error("Expected copied text.");
  expect(copied.layout.lines).toHaveLength(64);
  expect(copied.layout.lines[0]!.runs[0]!.text).toBe("x");
  const controller = new AbortController();
  await expect(
    encodeRuntimeRequestChunked(request, {
      signal: controller.signal,
      checkpoint: () => {
        controller.abort();
        return undefined;
      },
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
});
