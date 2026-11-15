import { applyImageCrop } from "../../domain/images/image-crop";
import type { ImageCropV3, ImageElementV3, ImageResourceV3 } from "../../domain/schema/public";
import { MountedImagePresentation } from "./content/mounted-image";
import { SVG_NAMESPACE } from "./constants";
import type { SceneDom } from "./scene-dom";
import type { SceneContentRenderer } from "./content-renderer";
import type { MutableSceneInstrumentation, SceneCamera } from "./types";

export interface SceneImageCropLease {
  update(crop: ImageCropV3): void;
  dispose(): void;
}

/** Owns one temporary source reveal without changing selection, document, or resource identity. */
export class SceneImageCropController {
  #active: { flush(): void; camera(camera: SceneCamera): void; dispose(): void } | undefined;
  #released = false;

  public constructor(
    private readonly context: () => readonly [
      SceneDom,
      MutableSceneInstrumentation,
      SceneCamera,
      SceneContentRenderer,
    ],
    private readonly schedule: () => void,
  ) {}

  public readonly begin = (
    image: ImageElementV3,
    resource: Pick<ImageResourceV3, "width" | "height">,
    onCamera: (camera: SceneCamera) => void,
  ): SceneImageCropLease => {
    if (this.#released) throw new Error("The scene has been disposed.");
    this.dispose();
    const [dom, instrumentation, camera, content] = this.context();
    const full = applyImageCrop(image, {
      x: 0,
      y: 0,
      width: resource.width,
      height: resource.height,
    });
    const presentation = new MountedImagePresentation(
      dom.ownerDocument,
      full,
      dom.imageResources,
      instrumentation,
    );
    const root = presentation.group;
    root.removeAttribute("data-element-id");
    root.setAttribute("data-inkbook-crop-preview", "");
    root.setAttribute("transform", `rotate(${full.rotation} ${full.pivot.x} ${full.pivot.y})`);
    const mask = dom.ownerDocument.createElementNS(SVG_NAMESPACE, "path");
    mask.setAttribute("fill", "black");
    mask.setAttribute("fill-opacity", "0.55");
    mask.setAttribute("fill-rule", "evenodd");
    mask.setAttribute("pointer-events", "none");
    root.append(mask);
    dom.imageGroup.append(root);
    const suppression = suppressOriginal(dom, image.id);
    const before = dom.svg.getAttribute("data-inkbook-image-crop");
    dom.svg.setAttribute("data-inkbook-image-crop", "");
    let draft: ImageCropV3 | undefined = image.crop;
    let disposed = false;
    let anchor: SVGGElement | undefined;
    const active = {
      flush: () => {
        const original = content.mountedImageRoot(image.id);
        if (original?.parentNode === dom.imageGroup && original !== anchor) original.after(root);
        anchor = original;
        if (draft === undefined || disposed) return;
        const crop = draft;
        draft = undefined;
        const x = full.x + (crop.x * full.width) / resource.width;
        const y = full.y + (crop.y * full.height) / resource.height;
        const width = (crop.width * full.width) / resource.width;
        const height = (crop.height * full.height) / resource.height;
        mask.setAttribute(
          "d",
          rectangle(full.x, full.y, full.width, full.height) + rectangle(x, y, width, height),
        );
        instrumentation.attributeWrites += 1;
      },
      camera: onCamera,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        draft = undefined;
        root.remove();
        suppression.remove();
        presentation.release();
        if (before === null) dom.svg.removeAttribute("data-inkbook-image-crop");
        else dom.svg.setAttribute("data-inkbook-image-crop", before);
        if (this.#active === active) this.#active = undefined;
      },
    };
    this.#active = active;
    active.flush();
    try {
      onCamera(camera);
    } catch (error: unknown) {
      active.dispose();
      throw error;
    }
    return {
      update: (crop) => {
        if (disposed) return;
        draft = { ...crop };
        this.schedule();
      },
      dispose: active.dispose,
    };
  };

  public flush(): void {
    this.#active?.flush();
  }

  public camera(camera: SceneCamera): void {
    this.#active?.camera(camera);
  }

  public dispose(): void {
    this.#active?.dispose();
  }

  public release(): void {
    this.#released = true;
    this.dispose();
  }
}

function rectangle(x: number, y: number, width: number, height: number): string {
  return `M ${x} ${y} h ${width} v ${height} h ${-width} Z `;
}

function suppressOriginal(dom: SceneDom, id: string): SVGStyleElement {
  const style = dom.ownerDocument.createElementNS(SVG_NAMESPACE, "style");
  const escaped = dom.ownerDocument.defaultView!.CSS.escape(id);
  style.textContent = `.inkbook-scene[data-inkbook-image-crop] [data-element-id="${escaped}"] { visibility: hidden; }`;
  dom.svg.append(style);
  return style;
}
