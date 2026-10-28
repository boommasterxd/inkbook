import type {
  ArrowElementV1,
  BoxShapeElementV1,
  InkElementV1,
  PageV1,
} from "../../../../src/domain/schema/public";
import {
  encodeRuntimeSelection,
  resolveClipboardPayload,
} from "../../../../src/persistence/clipboard/codec";
import type { DecodedClipboard } from "../../../../src/persistence/clipboard/types";

export const RECTANGLE_ID = "11111111-1111-4111-8111-111111111111";
export const ARROW_ID = "22222222-2222-4222-8222-222222222222";
export const EXTERNAL_ID = "33333333-3333-4333-8333-333333333333";

const outlineStyle = {
  outlineColor: { type: "theme-text" as const },
  outlineWidth: 4 as const,
  outlineOpacity: 1,
  outlineStyle: "solid" as const,
};

export const rectangle = (): BoxShapeElementV1 => ({
  id: RECTANGLE_ID,
  createdAt: 1_000,
  kind: "rectangle",
  x: 100,
  y: 100,
  width: 100,
  height: 80,
  rotation: 0,
  pivot: { x: 150, y: 140 },
  style: { ...outlineStyle, fillColor: null, fillOpacity: 0 },
});

export const arrow = (targetId = RECTANGLE_ID): ArrowElementV1 => ({
  id: ARROW_ID,
  createdAt: 1_001,
  kind: "arrow",
  start: { x: 100, y: 100 },
  end: { x: 40, y: 40 },
  bend: null,
  startConnection: {
    targetId,
    anchor: { kind: "box", position: "top-left" },
  },
  endConnection: null,
  startNode: "none",
  endNode: "arrow",
  rotation: 0,
  pivot: { x: 70, y: 70 },
  style: outlineStyle,
});

export const selectedElements = (): InkElementV1[] => [rectangle(), arrow()];

export function createDecodedClipboardFixture(
  elements: readonly InkElementV1[] = selectedElements(),
): DecodedClipboard {
  const encoded = encodeRuntimeSelection(elements, new Set(elements.map(({ id }) => id)));
  if (!encoded.ok) throw new Error(encoded.error.message);
  const decoded = resolveClipboardPayload({ customText: encoded.value.customText });
  if (!decoded.ok) throw new Error(decoded.error.message);
  return decoded.value;
}

export const spatialRectangle = (index: number, width = 1_019): BoxShapeElementV1 => ({
  ...rectangle(),
  createdAt: index,
  height: 15_355,
  id: `90000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
  pivot: { x: 2 + width / 2, y: 7_679.5 },
  width,
  x: 2,
  y: 2,
});

export const page = (): PageV1 => ({
  innerWidth: 2000,
  margin: 24.3,
  background: { type: "none" },
  activeBufferLines: 3,
  lockedBufferLines: 0,
});
