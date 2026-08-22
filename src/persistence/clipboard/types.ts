import type { InkClipboardV1, InkElementV1, PointV1 } from "../../domain/schema/public";
import type { Bounds } from "../../domain/geometry/public";

type ClipboardErrorCode =
  | "empty-selection"
  | "invalid-json"
  | "invalid-prefix"
  | "invalid-schema"
  | "limit-exceeded"
  | "missing-selection"
  | "stale-operation"
  | "write-failed";

interface ClipboardError {
  code: ClipboardErrorCode;
  message: string;
}

export type ClipboardResult<T> = { ok: true; value: T } | { ok: false; error: ClipboardError };

export interface ClipboardWritePayload {
  customText: string;
  plainText: string;
  byteLength: number;
}

export interface EncodedClipboard extends ClipboardWritePayload {
  payload: InkClipboardV1;
  compactJson: string;
  fingerprint: string;
}

export type ClipboardPayloadSource = "custom" | "plain" | "session";
export type ClipboardShortcutAction = "copy" | "cut" | "paste";

export interface ClipboardShortcutContext {
  pointerOverActiveEditor: boolean;
  textFieldFocused: boolean;
  hasSelection: boolean;
  hasValidInkPayload: boolean;
}

export interface DecodedClipboard extends EncodedClipboard {
  source: ClipboardPayloadSource;
}

export interface ClipboardCandidates {
  customText?: string;
  plainText?: string;
  sessionText?: string;
}

export type ElementBounds = Bounds;

export interface PasteRepeatState {
  fingerprint: string;
  pasteCount: number;
}

export type PasteInvocation =
  | { kind: "toolbar"; visibleCanvasCenter: PointV1 }
  | { kind: "context-menu"; invocationPoint: PointV1 }
  | {
      kind: "shortcut";
      lastSessionPointer: PointV1 | null;
      visibleCanvasCenter: PointV1;
    };

export interface PastePlan {
  elements: readonly InkElementV1[];
  selectedIds: readonly string[];
  highlightIds: readonly string[];
  contentIds: readonly string[];
  insertAtBandFront: true;
  activateTool: "select";
  commandTimestamp: number;
  translation: PointV1;
  repeatState: PasteRepeatState;
}

export interface ClipboardOperationIdentity {
  sessionId: string;
  workerEpoch: number;
  clipboardOperationId: string;
  basisRevision: number;
}

export interface VersionedSelectionRecord {
  id: string;
  geometryVersion: number;
  paintVersion: number;
}

export interface CutGuard extends ClipboardOperationIdentity {
  selectedRecords: readonly VersionedSelectionRecord[];
}

export interface CurrentClipboardState extends ClipboardOperationIdentity {
  presentationAttached: boolean;
  selectedRecords: readonly VersionedSelectionRecord[];
}
