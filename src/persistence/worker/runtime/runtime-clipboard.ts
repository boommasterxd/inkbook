import type { DocumentModelRuntime } from "./document-model";
import type { DocumentRuntimeRequest, DocumentRuntimeResult, RuntimeSliceContext } from "./types";

export type ClipboardRuntimeRequest = Extract<
  DocumentRuntimeRequest,
  { type: "clipboard-decode" | "clipboard-encode" | "clipboard-plan-paste" }
>;

export async function runClipboardRequest(
  model: DocumentModelRuntime,
  request: ClipboardRuntimeRequest,
  context: RuntimeSliceContext | undefined,
  createId: () => string,
): Promise<DocumentRuntimeResult> {
  if (request.type === "clipboard-encode") {
    return {
      identity: request.identity,
      result:
        context === undefined
          ? model.encodeClipboard(request.basisRevision, request.selectedIds)
          : await model.encodeClipboardSliced(request.basisRevision, request.selectedIds, context),
      type: "clipboard-encode-success",
    };
  }
  if (request.type === "clipboard-decode") {
    return {
      identity: request.identity,
      result:
        context === undefined
          ? model.decodeClipboard(request.basisRevision, request.candidates)
          : await model.decodeClipboardSliced(request.basisRevision, request.candidates, context),
      type: "clipboard-decode-success",
    };
  }
  return {
    identity: request.identity,
    result:
      context === undefined
        ? model.planClipboardPaste(
            request.basisRevision,
            request.candidates,
            request.invocation,
            request.commandTimestamp,
            createId,
            request.previousRepeat,
          )
        : await model.planClipboardPasteSliced(request.basisRevision, request.candidates, {
            commandTimestamp: request.commandTimestamp,
            context,
            createId,
            invocation: request.invocation,
            ...(request.previousRepeat === undefined
              ? {}
              : { previousRepeat: request.previousRepeat }),
          }),
    type: "clipboard-plan-paste-success",
  };
}
