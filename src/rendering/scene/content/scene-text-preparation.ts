import type { MutableSceneInstrumentation, SceneElementRecord } from "../types";
import type { MountedSceneElement } from "./mounted-element";
import { MountedTextPresentation } from "./mounted-text";
import type { MountSlice } from "../reconciliation/mount-slice";

/** One cancellable native text DOM preparation shares the scene's admitted deadline. */
export class SceneTextPreparation {
  #pending:
    { id: string; version: number; target: MountedTextPresentation; mounted: boolean } | undefined;
  public constructor(
    private readonly options: {
      readonly ownerDocument: Document;
      readonly instrumentation: MutableSceneInstrumentation;
      readonly mounted?: ReadonlyMap<string, MountedSceneElement>;
    },
  ) {}

  public prepare(record: SceneElementRecord, slice: MountSlice): boolean {
    if (record.element.kind !== "text") return true;
    if (this.#pending?.id !== record.id || this.#pending.version !== record.geometryVersion) {
      this.cancel();
      const mounted = this.options.mounted?.get(record.id)?.text;
      this.#pending = {
        id: record.id,
        version: record.geometryVersion,
        mounted: mounted !== undefined,
        target:
          mounted ??
          new MountedTextPresentation(
            this.options.ownerDocument,
            record.element,
            this.options.instrumentation,
            true,
          ),
      };
    }
    const { target } = this.#pending;
    const element = record.element;
    return slice.prepare({ step: (deadline, now) => target.prepare(element, deadline, now) });
  }

  public take(id: string): MountedTextPresentation | undefined {
    if (this.#pending?.id !== id || this.#pending.mounted) return undefined;
    const { target } = this.#pending;
    this.#pending = undefined;
    return target;
  }

  public cancel(id = this.#pending?.id): void {
    if (this.#pending?.id !== id) return;
    this.#pending?.target.cancelPreparation();
    this.#pending = undefined;
  }

  public memoryUsage(): number {
    return this.#pending?.target.memoryUsage() ?? 0;
  }
}
