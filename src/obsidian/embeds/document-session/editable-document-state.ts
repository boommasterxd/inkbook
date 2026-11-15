import type { EditableDocumentModel } from "./document-model-port";

type StatelessEditableDocumentModel = Omit<
  EditableDocumentModel,
  | "mutationAvailability"
  | "page"
  | "revision"
  | "fontResources"
  | "imageResources"
  | "formatVersion"
>;

export function attachEditableDocumentState(
  model: StatelessEditableDocumentModel,
  state: {
    readonly mutationAvailability: () => EditableDocumentModel["mutationAvailability"];
    readonly fontResources?: () => EditableDocumentModel["fontResources"];
    readonly imageResources?: () => EditableDocumentModel["imageResources"];
    readonly formatVersion?: () => EditableDocumentModel["formatVersion"];
    readonly page: () => EditableDocumentModel["page"];
    readonly revision: () => EditableDocumentModel["revision"];
  },
): EditableDocumentModel {
  return Object.defineProperties(model, {
    mutationAvailability: { enumerable: true, get: state.mutationAvailability },
    fontResources: { enumerable: true, get: () => state.fontResources?.() },
    imageResources: { enumerable: true, get: () => state.imageResources?.() },
    formatVersion: { enumerable: true, get: () => state.formatVersion?.() },
    page: { enumerable: true, get: state.page },
    revision: { enumerable: true, get: state.revision },
  }) as EditableDocumentModel;
}
