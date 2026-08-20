type BindingOrigin = "inferred" | "manual";
type BindingConfidence = "high" | "medium" | "low";
type BlockKindV1 =
  | "frontmatter"
  | "heading"
  | "paragraph"
  | "list-item"
  | "blockquote"
  | "code-block"
  | "table"
  | "thematic-break"
  | "blank-line"
  | "other";
export type BlockFingerprintV1 = string & {
  readonly __brand: "BlockFingerprintV1";
};

export interface TextBoundaryAnchor {
  readonly utf16Offset: number;
  readonly association: "before" | "after";
  readonly blockKind: BlockKindV1;
  readonly contextBefore: string;
  readonly contextAfter: string;
  readonly blockFingerprint: BlockFingerprintV1;
}

interface TextPositionBinding {
  readonly kind: "text-position";
  readonly anchor: TextBoundaryAnchor;
  readonly localOffsetX: number;
  readonly localOffsetY: number;
  readonly origin: BindingOrigin;
  readonly confidence: BindingConfidence;
  readonly inferenceProfileVersion: 1;
}

interface TextRangeBindingCommon {
  readonly kind: "text-range";
  readonly start: TextBoundaryAnchor;
  readonly end: TextBoundaryAnchor;
  readonly origin: BindingOrigin;
  readonly confidence: BindingConfidence;
  readonly inferenceProfileVersion: 1;
}

interface FragmentRangeBinding extends TextRangeBindingCommon {
  readonly presentation: "highlight" | "underline";
}

export interface EnclosureRangeBinding extends TextRangeBindingCommon {
  readonly presentation: "enclosure";
  readonly marginsInLineHeights: {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
  };
}

type TextRangeBinding = FragmentRangeBinding | EnclosureRangeBinding;

export interface FixedBinding {
  readonly kind: "fixed";
  readonly anchorX: number;
  readonly anchorY: number;
  readonly origin: BindingOrigin;
  readonly confidence: BindingConfidence;
  readonly inferenceProfileVersion: 1;
}

export type ElementBinding =
  TextRangeBinding | TextPositionBinding | FixedBinding;

const BLOCK_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;

export function parseBlockFingerprintV1(value: string): BlockFingerprintV1 {
  if (!BLOCK_FINGERPRINT_PATTERN.test(value)) {
    throw new TypeError("Invalid block fingerprint syntax.");
  }
  return value as BlockFingerprintV1;
}

function materializeTextBoundaryAnchor(
  anchor: TextBoundaryAnchor,
): TextBoundaryAnchor {
  return Object.freeze({ ...anchor });
}

function materializeRangeBinding(binding: TextRangeBinding): TextRangeBinding {
  const common = {
    ...binding,
    start: materializeTextBoundaryAnchor(binding.start),
    end: materializeTextBoundaryAnchor(binding.end),
  };
  if (binding.presentation !== "enclosure") {
    return Object.freeze(common);
  }
  return Object.freeze({
    ...common,
    marginsInLineHeights: Object.freeze({ ...binding.marginsInLineHeights }),
  });
}

export function materializeElementBinding(
  binding: ElementBinding,
): ElementBinding {
  switch (binding.kind) {
    case "fixed":
      return Object.freeze({ ...binding });
    case "text-position":
      return Object.freeze({
        ...binding,
        anchor: materializeTextBoundaryAnchor(binding.anchor),
      });
    case "text-range":
      return materializeRangeBinding(binding);
  }
}
