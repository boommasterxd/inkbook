import type { ImageElementV3, InkElementV1 } from "../../../domain/schema/public";
import { SVG_NAMESPACE } from "../constants";
import type { MutableSceneInstrumentation } from "../types";
import type { SceneImageLease, SceneImageResources } from "./image-resources";
import { writeRaw } from "./mounted-path";
import { bindImagePaintInstrumentation } from "./image-opacity";

/** Geometry changes touch only the crop viewport; encoded source ownership stays shared. */
export class MountedImagePresentation {
  public readonly group: SVGGElement;
  readonly #viewport: SVGSVGElement;
  readonly #use: SVGUseElement;
  readonly #substrate: SVGRectElement;
  readonly #attributes = new Map<string, string>();
  #assetId: string | undefined;
  #lease: SceneImageLease | undefined;
  #contrast: ImageElementV3["contrast"] | null = null;

  public constructor(
    ownerDocument: Document,
    element: ImageElementV3,
    private readonly resources: SceneImageResources,
    private readonly instrumentation: MutableSceneInstrumentation,
  ) {
    this.group = ownerDocument.createElementNS(SVG_NAMESPACE, "g");
    bindImagePaintInstrumentation(this.group, instrumentation);
    this.group.setAttribute("data-element-id", element.id);
    writeRaw(this.group, "data-inkbook-image", "", instrumentation, false);
    this.#viewport = ownerDocument.createElementNS(SVG_NAMESPACE, "svg");
    this.#viewport.setAttribute("overflow", "hidden");
    this.#viewport.setAttribute("preserveAspectRatio", "none");
    this.#use = ownerDocument.createElementNS(SVG_NAMESPACE, "use");
    this.#viewport.append(this.#use);
    this.#substrate = ownerDocument.createElementNS(SVG_NAMESPACE, "rect");
    writeRaw(this.#substrate, "class", "inkbook-image-substrate", instrumentation, false);
    this.group.append(this.#viewport, this.#substrate);
    this.update(element);
  }

  public update(element: ImageElementV3): void {
    if (this.#assetId !== element.assetId) {
      const lease = this.resources.acquire(element.assetId);
      writeRaw(this.#use, "href", lease.href, this.instrumentation, false);
      this.#lease?.release();
      this.#lease = lease;
      this.#assetId = element.assetId;
    }
    for (const key of ["x", "y", "width", "height"] as const) {
      this.write(key, String(element[key]));
      if (this.#substrate.getAttribute(key) !== String(element[key]))
        writeRaw(this.#substrate, key, String(element[key]), this.instrumentation, true);
    }
    if (this.#contrast !== element.contrast) this.writeContrast(element.contrast);
    const crop = element.crop;
    this.write("viewBox", `${crop.x} ${crop.y} ${crop.width} ${crop.height}`);
  }

  public release(): void {
    this.#lease?.release();
    this.#lease = undefined;
    this.#assetId = undefined;
  }

  private write(name: string, value: string): void {
    if (this.#attributes.get(name) === value) return;
    writeRaw(this.#viewport, name, value, this.instrumentation, true);
    this.#attributes.set(name, value);
  }

  private writeContrast(contrast: ImageElementV3["contrast"]): void {
    this.#contrast = contrast;
    writeRaw(
      this.group,
      "data-inkbook-image-contrast",
      contrast ?? null,
      this.instrumentation,
      false,
    );
    writeRaw(
      this.#substrate,
      "fill",
      contrast === "light" ? "white" : "black",
      this.instrumentation,
      false,
    );
    writeRaw(
      this.#substrate,
      "display",
      contrast === undefined ? "none" : null,
      this.instrumentation,
      false,
    );
  }
}

export function imageMotionSnapshot(
  context: {
    readonly ownerDocument: Document;
    readonly imageResources: SceneImageResources;
    readonly autoPaint?: { retainImage(node: SVGGElement): () => void };
  },
  element: InkElementV1,
  maximumBytes: number,
  instrumentation: MutableSceneInstrumentation,
):
  { readonly root: SVGGElement; readonly bytes: number; readonly release: () => void } | undefined {
  if (element.kind !== "image" || maximumBytes < 1024) return undefined;
  const image = new MountedImagePresentation(
    context.ownerDocument,
    element,
    context.imageResources,
    instrumentation,
  );
  const releaseUnderlay = context.autoPaint?.retainImage(image.group);
  return {
    root: image.group,
    bytes: 1024,
    release: () => {
      releaseUnderlay?.();
      image.release();
    },
  };
}
