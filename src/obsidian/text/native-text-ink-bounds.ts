import type {
  FontResourceV2,
  TextElementV2,
  TextLayoutRunV2,
  TextStyleV2,
} from "../../domain/schema/public";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import { textRunFontResource } from "../../persistence/fonts/bound-font-resources";
import { CanvasTextMeasurer } from "../../rendering/text/canvas-text-measurer";
import { prepareTextInkBounds } from "../../rendering/text/text-ink-bounds";
import type { MeasuredText } from "../../rendering/text/text-layout-types";
import {
  loadNativeFontPreview,
  type FontPreviewBudget,
  type NativeFontPreview,
} from "../fonts/native-font-preview";
import { createWindowSchedulerForwarding } from "../performance/window-scheduler-forwarding";

const MAX_FACES = 4;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_DECODED_BYTES = 32 * 1024 * 1024;

interface NativeTextInkOptions {
  readonly cancelled: () => boolean;
  readonly document: Document;
  readonly elements: readonly TextElementV2[];
  readonly resources: readonly FontResourceV2[];
  readonly scheduler: WorkScheduler;
}

/** Measures the original saved faces and advances; no source parsing or text reflow occurs. */
export async function prepareNativeTextInkBounds(
  options: NativeTextInkOptions,
): Promise<readonly TextElementV2[]> {
  const task = new NativeTextInkTask(options);
  try {
    return await task.prepare();
  } finally {
    task.dispose();
  }
}

class NativeTextInkTask {
  readonly #options: NativeTextInkOptions;
  readonly #controller = new AbortController();
  readonly #scheduler: WorkScheduler;
  readonly #faces = new Map<string, NativeFontPreview>();
  #measurer: CanvasTextMeasurer | undefined;
  #bytes = 0;
  #decodedBytes = 0;

  public constructor(options: NativeTextInkOptions) {
    this.#options = options;
    const central = options.scheduler;
    this.#scheduler = {
      ...createWindowSchedulerForwarding(() => central),
      checkpoint: (signal, priority) => {
        this.#assertActive();
        return central.checkpoint(signal, priority);
      },
      nextFrame: (signal, priority) => {
        this.#assertActive();
        return central.nextFrame(signal, priority);
      },
    };
  }

  public async prepare(): Promise<readonly TextElementV2[]> {
    const replacements: TextElementV2[] = [];
    for (const element of this.#options.elements) {
      this.#assertActive();
      const replacement = await this.#prepareElement(element);
      if (replacement !== element) replacements.push(replacement);
    }
    this.#assertActive();
    return replacements;
  }

  public dispose(): void {
    this.#controller.abort();
    this.#scheduler.dispose();
    this.#measurer?.dispose();
    for (const preview of this.#faces.values()) preview.dispose();
    this.#faces.clear();
  }

  async #prepareElement(element: TextElementV2): Promise<TextElementV2> {
    const groups = new Map<string, { resource: FontResourceV2; runs: TextLayoutRunV2[] }>();
    const styleFaces = new Map<string, string>();
    for (const line of element.layout.lines)
      for (const run of line.runs) {
        const pending = this.#scheduler.checkpoint(this.#controller.signal, "background");
        if (pending !== undefined) await pending;
        if (run.inkBounds !== undefined) continue;
        const resource = textRunFontResource(run, element.style, this.#options.resources);
        const group = groups.get(resource.id) ?? { resource, runs: [] };
        group.runs.push(run);
        groups.set(resource.id, group);
        styleFaces.set(styleKey({ ...element.style, ...run.style }), resource.id);
      }
    if (groups.size === 0) return element;
    const metrics = new Map<string, MeasuredText>();
    for (const { resource, runs } of groups.values()) {
      await this.#face(resource);
      this.#assertActive();
      const native = (this.#measurer ??= new CanvasTextMeasurer(this.#options.document));
      for (const run of runs) {
        const pending = this.#scheduler.checkpoint(this.#controller.signal, "background");
        if (pending !== undefined) await pending;
        const style = { ...element.style, ...run.style };
        const key = measurementKey(run.text, style, resource.id);
        if (!metrics.has(key))
          metrics.set(
            key,
            native.measure(run.text, { ...style, fontFamily: `preview-${resource.id}` }),
          );
      }
    }
    return prepareTextInkBounds(element, {
      scheduler: this.#scheduler,
      signal: this.#controller.signal,
      measure: {
        measure: (text, style, id) => {
          const resource = id ?? styleFaces.get(styleKey(style));
          const measured =
            resource === undefined ? undefined : metrics.get(measurementKey(text, style, resource));
          if (measured?.inkBounds === undefined)
            throw new Error("Native glyph bounds are unavailable.");
          return measured;
        },
      },
    });
  }

  async #face(resource: FontResourceV2): Promise<void> {
    const retained = this.#faces.get(resource.id);
    if (retained !== undefined) {
      this.#faces.delete(resource.id);
      this.#faces.set(resource.id, retained);
      return;
    }
    this.#assertActive();
    const preview = await loadNativeFontPreview(resource, {
      document: this.#options.document,
      scheduler: this.#scheduler,
      signal: this.#controller.signal,
      admit: (budget) => this.#admit(budget),
    });
    if (preview === undefined) throw new Error("Native text font exceeds its preparation budget.");
    this.#faces.set(resource.id, preview);
    this.#bytes += preview.bytes;
    this.#decodedBytes += preview.decodedBytes;
    this.#assertActive();
  }

  #admit(budget: FontPreviewBudget): boolean {
    if (budget.bytes > MAX_BYTES || budget.decodedBytes > MAX_DECODED_BYTES) return false;
    while (
      this.#faces.size >= MAX_FACES ||
      this.#bytes + budget.bytes > MAX_BYTES ||
      this.#decodedBytes + budget.decodedBytes > MAX_DECODED_BYTES
    ) {
      const oldest = this.#faces.keys().next().value;
      if (oldest === undefined) return false;
      const preview = this.#faces.get(oldest)!;
      preview.dispose();
      this.#bytes -= preview.bytes;
      this.#decodedBytes -= preview.decodedBytes;
      this.#faces.delete(oldest);
      this.#measurer?.clear();
    }
    return true;
  }

  #assertActive(): void {
    if (this.#options.cancelled()) this.#controller.abort();
    this.#controller.signal.throwIfAborted();
  }
}

function styleKey(style: TextStyleV2): string {
  return `${style.fontFamily}:${String(style.bold)}:${String(style.italic)}`;
}

function measurementKey(text: string, style: TextStyleV2, id: string): string {
  return `${id}:${String(style.fontSize)}:${String(style.bold)}:${String(style.italic)}:${text}`;
}
