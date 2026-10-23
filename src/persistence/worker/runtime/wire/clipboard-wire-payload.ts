import { copyStrokeSamplesToRuntime } from "../../../../domain/elements/public";
import type {
  ClipboardElementBodyV1,
  ClipboardElementV1,
  InkClipboardV1,
} from "../../../../domain/schema/public";
import { adoptTransferredStrokeSamples } from "../model/runtime-elements";
import { assertClipboardPayloadWireLimits } from "./packed-element-wire-limits";
import { adoptLocalStrokeArray, isNativeFloat64Array } from "../../../serialization/transfer-array";

type ClipboardStrokeBody = Extract<ClipboardElementBodyV1, { kind: "stroke" }>;
type PackedClipboardStroke = Omit<ClipboardStrokeBody, "points"> & {
  readonly pointsBufferIndex: number;
};
type PackedClipboardBody =
  Exclude<ClipboardElementBodyV1, ClipboardStrokeBody> | PackedClipboardStroke;

export interface PackedClipboardPayload extends Omit<InkClipboardV1, "elements"> {
  readonly elements: readonly {
    readonly clipId: string;
    readonly element: PackedClipboardBody;
  }[];
  readonly pointBuffers: readonly Float64Array[];
}

export function packClipboardPayload(payload: InkClipboardV1): PackedClipboardPayload {
  const pointBuffers: Float64Array[] = [];
  const elements = payload.elements.map(({ clipId, element }) => {
    if (element.kind !== "stroke") return { clipId, element };
    const pointsBufferIndex = pointBuffers.length;
    pointBuffers.push(copyStrokeSamplesToRuntime(element.points));
    const { points: _points, ...record } = element;
    return { clipId, element: { ...record, pointsBufferIndex } };
  });
  return { ...payload, elements, pointBuffers };
}

export function unpackClipboardPayload(payload: PackedClipboardPayload): InkClipboardV1 {
  if (!hasPackedClipboardArrays(payload)) {
    throw new TypeError("Packed clipboard payload must contain element and point-buffer arrays.");
  }
  assertClipboardPayloadWireLimits(payload.elements.length, payload.pointBuffers);
  const used = new Set<number>();
  const elements: ClipboardElementV1[] = payload.elements.map(({ clipId, element }) => {
    if (element.kind !== "stroke") return { clipId, element };
    const index = element.pointsBufferIndex;
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= payload.pointBuffers.length ||
      used.has(index)
    ) {
      throw new RangeError("Clipboard point-buffer index is invalid or reused.");
    }
    const transferred = payload.pointBuffers[index];
    if (!isNativeFloat64Array(transferred)) {
      throw new TypeError("Clipboard stroke points must use a Float64Array wire buffer.");
    }
    const points = adoptLocalStrokeArray(transferred);
    used.add(index);
    const { pointsBufferIndex: _index, ...record } = element;
    return { clipId, element: { ...record, points: adoptTransferredStrokeSamples(points) } };
  });
  if (used.size !== payload.pointBuffers.length) {
    throw new RangeError("Every clipboard point buffer must be referenced exactly once.");
  }
  return { format: payload.format, version: payload.version, elements };
}

function hasPackedClipboardArrays(payload: PackedClipboardPayload): boolean {
  return Array.isArray(payload.elements) && Array.isArray(payload.pointBuffers);
}
