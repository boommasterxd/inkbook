import type { EditableDocumentModel } from "./document-model-port";

type StatelessEditableDocumentModel = Omit<
  EditableDocumentModel,
  "mutationAvailability" | "page" | "revision"
>;

export function attachEditableDocumentState(
  model: StatelessEditableDocumentModel,
  state: {
    readonly mutationAvailability: () => EditableDocumentModel["mutationAvailability"];
    readonly page: () => EditableDocumentModel["page"];
    readonly revision: () => EditableDocumentModel["revision"];
  },
): EditableDocumentModel {
  return Object.defineProperties(model, {
    mutationAvailability: { enumerable: true, get: state.mutationAvailability },
    page: { enumerable: true, get: state.page },
    revision: { enumerable: true, get: state.revision },
  }) as EditableDocumentModel;
}
