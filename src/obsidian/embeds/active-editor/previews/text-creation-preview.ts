import { canonicalizeGeometryNumber } from "../../../../domain/schema/public";
import type { PointV1 } from "../../../../domain/schema/public";
import type { TextDefaultsV2 } from "../../../../domain/settings/types";
import { TEXT_LINE_HEIGHT } from "../../../../domain/text/text-layout-style";
import type { GesturePreview, GesturePreviewStart } from "../../../../editor/gestures/public";
import type { SvgSceneRenderer } from "../../../../rendering/scene/index";
import { creationLivePath } from "./creation-path";

export interface TextCreationBox extends PointV1 {
  readonly width: number;
}

/** Creation only chooses the wrap width; content, fonts and layout use the text session. */
export class TextCreationPreview implements GesturePreview {
  readonly #start: PointV1;
  readonly #defaults: TextDefaultsV2;
  readonly #renderer: Pick<SvgSceneRenderer, "setLivePath">;
  readonly #create: (box: TextCreationBox) => void;
  #current: PointV1;

  public constructor(options: {
    readonly start: GesturePreviewStart;
    readonly defaults: TextDefaultsV2;
    readonly renderer: Pick<SvgSceneRenderer, "setLivePath">;
    readonly create: (box: TextCreationBox) => void;
  }) {
    this.#start = options.start.pointer;
    this.#current = this.#start;
    this.#defaults = options.defaults;
    this.#renderer = options.renderer;
    this.#create = options.create;
    this.update(options.start.pointer);
  }

  public update(pointer: PointV1): void {
    this.#current = pointer;
    const box = this.#box();
    const height = this.#defaults.fontSize * TEXT_LINE_HEIGHT;
    this.#renderer.setLivePath(
      creationLivePath({
        ...box,
        height,
        kind: "rectangle",
        id: "text-creation-preview",
        createdAt: 0,
        pivot: { x: box.x + box.width / 2, y: box.y + height / 2 },
        rotation: 0,
        style: {
          outlineColor: this.#defaults.color,
          outlineOpacity: 0.5,
          outlineWidth: 1,
          outlineStyle: "dashed",
          fillColor: null,
          fillOpacity: 0,
        },
      }),
    );
  }

  public commit(): boolean {
    this.#renderer.setLivePath(null);
    this.#create(this.#box());
    return true;
  }

  public revert(): void {
    this.#renderer.setLivePath(null);
  }

  #box(): TextCreationBox {
    const width = Math.abs(this.#current.x - this.#start.x);
    return {
      x: canonicalizeGeometryNumber(Math.min(this.#start.x, this.#current.x)),
      y: canonicalizeGeometryNumber(this.#start.y),
      width: canonicalizeGeometryNumber(width === 0 ? 400 : Math.max(0.001, width)),
    };
  }
}
