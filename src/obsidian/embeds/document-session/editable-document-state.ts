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
  let formatVersion = state.formatVersion?.();
  return Object.defineProperties(model, {
    mutationAvailability: { enumerable: true, get: state.mutationAvailability },
    fontResources: { enumerable: true, get: () => state.fontResources?.() },
    imageResources: { enumerable: true, get: () => state.imageResources?.() },
    formatVersion: {
      enumerable: true,
      get: () => {
        const current = model.store.lockedCount > 0 ? 4 : state.formatVersion?.();
        if (current !== undefined && (formatVersion === undefined || current > formatVersion))
          formatVersion = current;
        return formatVersion;
      },
    },
    page: { enumerable: true, get: state.page },
    revision: { enumerable: true, get: state.revision },
  }) as EditableDocumentModel;
}
