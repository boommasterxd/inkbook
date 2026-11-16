import type { TextElementV2 } from "../../../domain/schema/public";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { PastePlan } from "../../../persistence/clipboard/public";
import { capturePastePlan } from "../../../persistence/clipboard/paste-plan-snapshot";
import { prepareNativeTextInkBounds } from "../../text/native-text-ink-bounds";
import type { EditableDocumentModel } from "../document-session/document-model-port";

/** Preserve the planned placement and saved faces while enriching legacy glyph geometry. */
export async function prepareClipboardTextInkBounds(
  plan: PastePlan,
  options: {
    readonly cancelled: () => boolean;
    readonly ownerWindow: Window;
    readonly model: Pick<EditableDocumentModel, "fontResources">;
    readonly scheduler: WorkScheduler;
  },
): Promise<PastePlan | null> {
  const elements = plan.elements.filter(
    (element): element is TextElementV2 =>
      element.kind === "text" &&
      element.layout.lines.some((line) => line.runs.some((run) => run.inkBounds === undefined)),
  );
  if (elements.length === 0) return plan;
  if (options.cancelled()) return null;
  // The session coordinator already validated and admitted candidate resources, including collisions.
  const resources = new Map((plan.fontResources ?? []).map((resource) => [resource.id, resource]));
  for (const resource of options.model.fontResources ?? []) resources.set(resource.id, resource);
  const prepared = await prepareNativeTextInkBounds({
    document: options.ownerWindow.document,
    elements,
    resources: [...resources.values()],
    scheduler: options.scheduler,
    cancelled: options.cancelled,
  }).catch((error: unknown) => {
    if (options.cancelled()) return null;
    throw error;
  });
  if (options.cancelled()) return null;
  if (prepared === null) return null;
  if (prepared.length === 0) return plan;
  const replacements = new Map(prepared.map((element) => [element.id, element]));
  return capturePastePlan({
    ...plan,
    elements: plan.elements.map((element) => replacements.get(element.id) ?? element),
  });
}
