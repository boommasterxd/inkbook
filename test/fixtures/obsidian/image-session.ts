import { vi } from "vitest";
import { ElementStore } from "../../../src/domain/store/public";
import type { ImageElementV3, ImageResourceV3 } from "../../../src/domain/schema/public";
import {
  ActiveImageSession,
  type ActiveImageSessionOptions,
} from "../../../src/obsidian/embeds/active-editor/image-session";
import { ActiveEditorHistory } from "../../../src/obsidian/embeds/active-editor/history";
import type { EditableDocumentModel } from "../../../src/obsidian/embeds/document-session/document-model-port";
import { elementMutationPorts, elementReplacementPorts } from "./element-mutation-ports";
import { imageElement, imageResource } from "../domain/images";
import { PAGE } from "../../unit/domain/store/fixtures";

export function deferredImageSession<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export const sessionImageResource: ImageResourceV3 = {
  ...imageResource(),
  width: 4000,
  height: 1000,
};
export const sessionImage: ImageElementV3 = {
  ...imageElement(),
  x: 24.3,
  y: 24.3,
  width: 400,
  height: 100,
  pivot: { x: 224.3, y: 74.3 },
  crop: { x: 0, y: 0, width: 4000, height: 1000 },
};

/** Real prepared image mutation/history with separately controlled selection and document revisions. */
export function imageSessionFixture(
  overrides: Partial<ActiveImageSessionOptions> = {},
  initial: ImageElementV3[] = [],
) {
  const store = new ElementStore(initial);
  let revision = 0;
  const committed = () => {
    revision += 1;
  };
  let selection: ReadonlySet<string> = new Set(initial.map(({ id }) => id));
  const addImageResources = vi.fn(async () => undefined);
  const model = {
    store,
    page: PAGE,
    get revision() {
      return revision;
    },
    imageResource: () => sessionImageResource,
    addImageResources,
    ...elementMutationPorts(store, committed),
    ...elementReplacementPorts(store, committed),
  } as unknown as EditableDocumentModel;
  const history = new ActiveEditorHistory(model);
  const onCommitted = vi.fn();
  const onFailed = vi.fn();
  const options: ActiveImageSessionOptions = {
    model,
    history,
    ownerWindow: window,
    isEnabled: () => true,
    finishText: async () => true,
    selection: () => selection,
    select: (next) => {
      selection = next;
    },
    visibleCenter: () => ({ x: 2000, y: 300 }),
    onImportImages: async () => ({
      resources: [
        sessionImageResource,
        { ...sessionImageResource, id: "b".repeat(64), width: 100, height: 100 },
      ],
      source: "pdf",
    }),
    onCropImage: async () => ({ x: 1000, y: 250, width: 2000, height: 500 }),
    onCommitted,
    onFailed,
    ...overrides,
  };
  const session = new ActiveImageSession(options);
  return {
    session,
    store,
    history,
    model,
    addImageResources,
    options,
    onCommitted,
    onFailed,
    changeRevision: committed,
    selection: () => selection,
  };
}
