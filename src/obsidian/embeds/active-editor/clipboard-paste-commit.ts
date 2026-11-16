import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { AppliedElementMutation } from "../../../domain/store/public";
import type { PastePlan } from "../../../persistence/clipboard/public";
import type { EditableDocumentModel } from "../document-session/document-model-port";
import {
  captureClipboardDocumentBasis,
  clipboardDocumentBasisCurrent,
  type ClipboardAdoptionGuard,
} from "./clipboard-adoption-guard";
import { prepareClipboardTextInkBounds } from "./clipboard-text-preparation";

/** Prepare geometry and private assets before one resource-aware Store commit. */
export async function commitClipboardPaste(options: {
  readonly plan: PastePlan;
  readonly expectedRevision: number;
  readonly model: EditableDocumentModel;
  readonly ownerWindow: Window;
  readonly scheduler: WorkScheduler;
  readonly adoption: ClipboardAdoptionGuard;
  readonly isCurrent: () => boolean;
}): Promise<AppliedElementMutation | null> {
  const { model, adoption, scheduler } = options;
  const basis = captureClipboardDocumentBasis(model);
  const cancelled = () =>
    model.revision !== options.expectedRevision ||
    !clipboardDocumentBasisCurrent(model, basis) ||
    !options.isCurrent();
  const plan = await prepareClipboardTextInkBounds(options.plan, {
    cancelled,
    ownerWindow: options.ownerWindow,
    model,
    scheduler,
  });
  if (plan === null || cancelled()) return null;
  const preparedAdoption = await adoption.prepare(plan, {
    isCancelled: cancelled,
    shouldYield: () => scheduler.shouldYield(),
    yieldControl: () => scheduler.checkpoint(undefined, "frame") ?? Promise.resolve(),
  });
  if (preparedAdoption === null) return null;
  const valid = () => adoption.accepts(preparedAdoption, model.page);
  if (!valid() || cancelled()) return null;
  const resources = plan.imageResources;
  if (resources?.length && model.prepareImageResources === undefined) return null;
  const preparedResources = resources?.length
    ? await model.prepareImageResources!(resources, { isCancelled: cancelled })
    : undefined;
  if (preparedResources === null || cancelled()) return null;
  const prepared = await model.prepareElementAppend(preparedAdoption.elements, {
    isCancelled: cancelled,
  });
  if (prepared.token === null || cancelled() || !valid()) return null;
  return model.commitPreparedElementMutation(prepared.token, preparedResources);
}
