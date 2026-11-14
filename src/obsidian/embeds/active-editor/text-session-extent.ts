import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { TextEditingSurface } from "../../../rendering/scene/text-editing-surface";

export interface TextSourceExtentLayout {
  begin(): void;
  updateBottom(maximumBottom: number, immediate?: boolean, sourceExtent?: boolean): void;
  finish(committed: boolean, previewMaximumBottom?: number, immediate?: boolean): void;
}

/** Source reveal can temporarily exceed the saved formula or Markdown geometry. */
export class TextSessionExtent {
  #frame: number | undefined;
  #active = false;
  #initialCanonicalHeight: number | undefined;
  #disposed = false;
  #reservedBottom: number | undefined;
  #measuring = false;

  public constructor(
    private readonly options: {
      readonly scheduler: WorkScheduler;
      readonly surface: TextEditingSurface;
      readonly layout: TextSourceExtentLayout | undefined;
      readonly input: () =>
        | {
            readonly contentHeight: number;
            readonly view: { readonly scaleY: number };
            readonly measureContentHeight?: (
              onMeasured?: (height: number | undefined) => void,
            ) => number | undefined;
          }
        | undefined;
      readonly canonicalHeight: () => number;
    },
  ) {}

  public invalidate(): void {
    if (this.#disposed || this.#frame !== undefined || this.#measuring) return;
    this.#frame = this.options.scheduler.requestFrame(() => {
      this.#frame = undefined;
      this.#measure();
    }, "input");
  }

  public reserveBottom(bottom?: number): void {
    if (this.#disposed || (bottom !== undefined && !Number.isFinite(bottom))) return;
    if (bottom === undefined) {
      if (this.#reservedBottom === undefined) return;
      this.#reservedBottom = undefined;
      this.#finishLease(true);
      this.update();
    } else if (this.#reservedBottom === undefined || bottom > this.#reservedBottom) {
      this.#reservedBottom = bottom;
      this.update(true);
    }
  }

  public update(immediate = false, measuredHeight?: number): void {
    if (this.#disposed) return;
    if (this.#frame !== undefined) this.options.scheduler.cancelFrame(this.#frame);
    this.#frame = undefined;
    const height = measuredHeight ?? this.#height();
    if (height === undefined || !Number.isFinite(height) || height < 0) return;
    const bounds = this.options.surface.setContentHeight(height);
    if (!bounds || !this.options.layout) return;
    if (
      !this.#active &&
      (height > this.options.canonicalHeight() || this.#reservedBottom !== undefined)
    ) {
      this.#initialCanonicalHeight = this.options.canonicalHeight();
      this.options.layout.begin();
      this.#active = true;
    }
    if (this.#active)
      this.options.layout.updateBottom(
        Math.max(bounds.maxY, this.#reservedBottom ?? bounds.maxY),
        immediate,
        true,
      );
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#frame !== undefined) this.options.scheduler.cancelFrame(this.#frame);
    this.#finishLease();
  }

  #measure(): void {
    const input = this.options.input();
    if (!input?.measureContentHeight) {
      this.update();
      return;
    }
    this.#measuring = true;
    const complete = (height: number | undefined) => {
      this.#measuring = false;
      if (height !== undefined) this.update(false, height);
    };
    const height = input.measureContentHeight(complete);
    if (height !== undefined) complete(height);
  }

  #height(): number | undefined {
    const input = this.options.input();
    if (!input) return undefined;
    return (
      input.measureContentHeight?.() ??
      (Number.isFinite(input.view.scaleY) && input.view.scaleY > 0
        ? input.contentHeight / input.view.scaleY
        : undefined)
    );
  }

  #finishLease(immediate = false): void {
    if (this.#active) {
      const changed = this.#initialCanonicalHeight !== this.options.canonicalHeight();
      if (immediate) this.options.layout?.finish(changed, undefined, true);
      else this.options.layout?.finish(changed);
    }
    this.#active = false;
    this.#initialCanonicalHeight = undefined;
  }
}
