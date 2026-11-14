import type { TextElementV2 } from "../../../domain/schema/public";
import type { ElementStore } from "../../../domain/store/public";
import type { SvgSceneRenderer } from "../../../rendering/scene/index";
import type {
  TextEditingCallbacks,
  TextEditingSurface,
} from "../../../rendering/scene/text-editing-surface";
import type { TextFieldEditor } from "../../text/editor/text-field-editor";
import type { ActiveTextPreparation } from "./text-preparation";
import { expandLegacyTextPaddingSteps } from "../../../domain/geometry/text-padding";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { EditableDocumentModel } from "../document-session/document-model-port";
import type { ActiveEditorHistory } from "./history";
import { commitTextReplacement } from "./text-session-history";
import type { TextReflowOptions } from "../../../editor/selection/transform/text-reflow-session";

export interface TextSessionEditOptions {
  readonly preserveLayout?: boolean;
}
export type TextHeightChanged = TextEditingCallbacks["onContentHeightChanged"];

/** A legacy field gains its outer inset through the same undoable prepared replacement as typing. */
export async function prepareTextEditingElement(
  id: string,
  options: TextSessionEditOptions & {
    readonly model: EditableDocumentModel;
    readonly history: ActiveEditorHistory;
    readonly preparation: ActiveTextPreparation;
    readonly scheduler: WorkScheduler;
    readonly signal: AbortSignal;
    readonly renderer: Pick<SvgSceneRenderer, "suppressMotionForNextDelta">;
  },
): Promise<TextElementV2 | undefined> {
  const previous = options.model.store.get(id)?.element;
  if (previous?.kind !== "text") return undefined;
  let element = previous as TextElementV2;
  if (!options.preserveLayout) {
    const steps = expandLegacyTextPaddingSteps(element);
    let step = steps.next();
    while (!step.done) {
      const pending = options.scheduler.checkpoint(options.signal, "input");
      if (pending !== undefined) await pending;
      options.signal.throwIfAborted();
      step = steps.next();
    }
    element = step.value;
  }
  await options.preparation.open(element, options.signal);
  if (!options.preserveLayout)
    element = await options.preparation.repairWhitespaceLayout(element, options.signal);
  if (options.signal.aborted || options.model.store.get(id)?.element !== previous) return undefined;
  if (
    element !== previous &&
    !(await commitTextReplacement(options.model, options.history, element, options.signal, () => {
      options.renderer.suppressMotionForNextDelta([id]);
      return true;
    }))
  )
    return undefined;
  options.preparation.adopt(element);
  return options.model.store.get(id)?.element as TextElementV2 | undefined;
}

interface TextGeometryContext {
  readonly element: TextElementV2;
  readonly input: TextFieldEditor;
  readonly surface: TextEditingSurface;
  readonly preparation: ActiveTextPreparation;
}

interface TextSessionGeometryOptions {
  readonly current: () => TextGeometryContext | undefined;
  readonly store: Pick<ElementStore, "get">;
  readonly flush: () => Promise<boolean>;
  readonly update: (element: TextElementV2, preview?: boolean) => void;
  readonly renderer: Pick<SvgSceneRenderer, "waitForTextElement">;
  readonly onError: (error: unknown) => void;
  readonly reconcileHostLayout?: ((callback: () => void) => void) | undefined;
}

/** Keeps one native input alive while selection handles temporarily own its geometry. */
export class TextSessionGeometry {
  readonly #options: TextSessionGeometryOptions;
  #abort: AbortController | undefined;
  #suspending: Promise<boolean> | undefined;
  #resuming: Promise<boolean> | undefined;
  #settlement: Promise<void> | undefined;
  #release: (() => void) | undefined;
  #suspended = false;
  #disposed = false;
  #hostHeight: number | undefined;

  public constructor(options: TextSessionGeometryOptions) {
    this.#options = options;
  }

  public get suspended(): boolean {
    return this.#suspended;
  }

  public hostLayoutChanged(height: number): void {
    if (this.#disposed || height === this.#hostHeight) return;
    this.#hostHeight = height;
    const resume = this.#options.current()?.input.hostLayoutChanged(height);
    if (!resume) return;
    if (this.#options.reconcileHostLayout) this.#options.reconcileHostLayout(resume);
    else resume();
  }

  public primeHostLayout(): void {
    if (this.#hostHeight !== undefined)
      this.#options.current()?.input.hostLayoutChanged(this.#hostHeight);
  }

  public readonly published = (element: TextElementV2): void => {
    if (this.#disposed || !this.#suspended || this.#options.current()?.element.id !== element.id)
      return;
    this.#options.update(element, true);
  };

  public async reflow(
    element: TextElementV2,
    signal: AbortSignal,
    preparation: ActiveTextPreparation,
    options?: TextReflowOptions,
  ): Promise<TextElementV2> {
    return this.prepare(await preparation.prepare(element, signal, options), signal);
  }

  public async prepare(element: TextElementV2, signal: AbortSignal): Promise<TextElementV2> {
    const current = this.#options.current();
    await current?.surface.prepareDocument?.();
    signal.throwIfAborted();
    const context = this.#suspended ? current : undefined;
    await context?.input.prepareGeometry(element, signal, context.preparation.document(element));
    return element;
  }

  public suspend(): Promise<boolean> {
    if (this.#disposed) return Promise.resolve(false);
    if (this.#suspending) return this.#suspending;
    if (this.#suspended) return Promise.resolve(true);
    const context = this.#options.current();
    if (!context) return Promise.resolve(false);
    const abort = new AbortController();
    this.#abort = abort;
    this.#settlement = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
    const operation = this.#guard(this.#suspend(context, abort.signal), abort.signal).then(
      (result) => {
        if (!result && this.#abort === abort) this.#end();
        return result;
      },
    );
    this.#suspending = operation;
    void operation.then(() => {
      if (this.#suspending === operation) this.#suspending = undefined;
    });
    return operation;
  }

  public resume(): Promise<boolean> {
    if (this.#resuming) return this.#resuming;
    const operation = this.#resumeAfterSuspend();
    this.#resuming = operation;
    void operation.then(() => {
      if (this.#resuming === operation) this.#resuming = undefined;
    });
    return operation;
  }

  public settled(): Promise<void> | undefined {
    return this.#settlement;
  }

  public cancel(): void {
    this.#end();
  }

  public dispose(): void {
    this.#disposed = true;
    this.#end();
  }

  async #suspend(context: TextGeometryContext, signal: AbortSignal): Promise<boolean> {
    if (!(await this.#options.flush()) || !this.#current(context, signal)) return false;
    await this.#options.renderer.waitForTextElement(context.element.id, signal);
    if (!this.#current(context, signal)) return false;
    context.surface.setSuspended(true);
    context.input.setGeometrySuspended(true);
    this.#suspended = true;
    return true;
  }

  async #resumeAfterSuspend(): Promise<boolean> {
    if (this.#suspending && !(await this.#suspending)) return false;
    if (this.#disposed) return false;
    const context = this.#options.current();
    if (!context) {
      this.#end();
      return false;
    }
    if (!this.#suspended || !this.#abort) return true;
    const abort = this.#abort;
    try {
      return await this.#guard(this.#resume(context, abort.signal), abort.signal);
    } finally {
      if (this.#abort === abort) this.#end();
    }
  }

  async #resume(context: TextGeometryContext, signal: AbortSignal): Promise<boolean> {
    const element = this.#read(context.element.id);
    if (!element || !this.#current(context, signal)) return false;
    try {
      await context.preparation.open(element, signal);
    } catch (error) {
      // Keep subsequent typing on authoritative geometry even when fonts cannot be reopened.
      const current = this.#read(element.id);
      if (current && this.#current(context, signal)) this.#options.update(current);
      throw error;
    }
    if (!this.#current(context, signal) || this.#read(element.id) !== element) return false;
    context.preparation.adopt(element);
    await context.surface.prepareDocument?.();
    signal.throwIfAborted();
    await context.input.prepareGeometry(element, signal, context.preparation.document(element));
    if (!this.#current(context, signal) || this.#read(element.id) !== element) return false;
    this.#options.update(element);
    await Promise.all([
      this.#options.renderer.waitForTextElement(element.id, signal),
      context.input.ready,
    ]);
    return this.#current(context, signal) && this.#read(element.id) === element;
  }

  #read(id: string): TextElementV2 | undefined {
    const element = this.#options.store.get(id)?.element;
    return element?.kind === "text" ? (element as TextElementV2) : undefined;
  }

  #current(context: TextGeometryContext, signal: AbortSignal): boolean {
    return !this.#disposed && !signal.aborted && this.#options.current()?.input === context.input;
  }

  #end(): void {
    this.#abort?.abort();
    this.#abort = undefined;
    if (this.#suspended) {
      const context = this.#options.current();
      if (context) {
        context.surface.setSuspended(false);
        context.input.setGeometrySuspended(false);
        context.input.requestViewportMeasure();
        if (!this.#disposed) context.input.focusSelectionPreserved();
      }
    }
    this.#suspended = false;
    this.#release?.();
    this.#release = undefined;
    this.#settlement = undefined;
  }

  #guard(operation: Promise<boolean>, signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const abort = () => resolve(false);
      signal.addEventListener("abort", abort, { once: true });
      void operation
        .then(resolve, (error: unknown) => {
          if (!this.#disposed && !signal.aborted) this.#options.onError(error);
          resolve(false);
        })
        .finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) resolve(false);
    });
  }
}
