export { beginClipboardWriteDuringActivation, type ClipboardWritePort } from "./adapter";
export { decodeCustomClipboardText, encodeSelection, resolveClipboardPayload } from "./codec";
export { INKBOOK_CLIPBOARD_TEXT_PREFIX, INKBOOK_CLIPBOARD_WEB_MIME } from "./constants";
export {
  classifyPasteResult,
  isCurrentCut,
  isCurrentPasteResult,
  planPaste,
  resolvePasteTarget,
  shouldHandleClipboardShortcut,
  validatePasteAdoption,
} from "./operations";
export type {
  ClipboardCandidates,
  ClipboardWritePayload,
  ClipboardOperationIdentity,
  CurrentClipboardState,
  CutGuard,
  EncodedClipboard,
  PastePlan,
  PasteInvocation,
  PasteRepeatState,
  VersionedSelectionRecord,
} from "./types";
export { validateClipboardPayload } from "./validation";
