import type { MountedTextPresentation } from "./content/mounted-text";
import type { SceneCamera, SceneViewport } from "./types";
import {
  inverseTextMatrix,
  textCameraMatrix,
  textElementMatrix,
  textPreviewMatrix,
  textRectBounds,
  type TextClientRect,
  type TextEditingMatrix,
  type TextEditingBounds,
} from "./text-editing-geometry";
import type { SceneDocumentAssets } from "./scene-surface-document";
import { multiplyAffineMatrices } from "../../domain/geometry/affine-matrix";

export interface TextEditingViewportContext {
  readonly prepareDocument?: (document: Document) => SceneDocumentAssets;
  readonly cameraGroup: SVGGElement;
  readonly camera: SceneCamera;
  readonly viewport: SceneViewport | undefined;
  readonly invalidate: () => void;
}

/** One bounded HTML clip tells the native editor its real host-visible window. */
export class TextEditingViewport {
  readonly #values = new Map<HTMLElement, Map<string, string>>();
  #bounds: TextEditingBounds;
  #canonicalBounds: TextEditingBounds;
  #contentHeight = 0;
  #key = "";
  #previewTransform: string | null = null;
  #nativeReadPending = true;
  #pageInverse: TextEditingMatrix | undefined;
  #released = false;
  #visibleTop = 0;
  #camera: SceneCamera;
  #cameraMatrix: TextEditingMatrix | undefined;

  public constructor(
    private readonly options: {
      readonly text: Pick<MountedTextPresentation, "element" | "group"> &
        Partial<Pick<MountedTextPresentation, "previewMatrix">>;
      readonly clip: HTMLDivElement;
      readonly container: HTMLDivElement;
      readonly isolatedInput?: boolean;
      readonly bounds: TextEditingBounds;
      readonly context: TextEditingViewportContext | undefined;
      readonly onChanged: ((geometryChanged?: boolean) => void) | undefined;
      readonly onBoundsChanged?: (bounds: TextEditingBounds) => void;
    },
  ) {
    this.#bounds = options.bounds;
    this.#camera = options.context?.camera ?? { x: 0, zoom: 1 };
    this.#canonicalBounds = options.bounds;
    options.onBoundsChanged?.(options.bounds);
    this.write(options.container, "--inkbook-text-editor-height", options.bounds.height);
    this.write(options.container, "--inkbook-text-editor-width", options.bounds.width);
    this.write(options.clip, "--inkbook-text-viewport-top", 0);
    this.write(options.clip, "--inkbook-text-viewport-height", options.bounds.height);
    const context = options.context;
    if (context?.viewport) this.update(context.viewport, context.camera, false);
  }

  public updateBounds(bounds: TextEditingBounds): void {
    if (this.#released) return;
    if (
      ["x", "y", "width", "height"].every(
        (name) =>
          this.#canonicalBounds[name as keyof TextEditingBounds] ===
          bounds[name as keyof TextEditingBounds],
      )
    )
      return;
    this.#canonicalBounds = bounds;
    this.commitBounds();
  }

  public setContentHeight(height: number) {
    if (this.#released || !Number.isFinite(height) || height < 0) return undefined;
    this.#contentHeight = height;
    this.commitBounds();
    const { x, y, width, height: extent } = this.#bounds;
    return textRectBounds(
      { left: x, top: y, right: x + width, bottom: y + extent },
      textPreviewMatrix(this.options.text.element, this.options.text.previewMatrix),
    );
  }

  private commitBounds(): void {
    const bounds = {
      ...this.#canonicalBounds,
      height: Math.max(this.#canonicalBounds.height, this.#contentHeight),
    };
    if (
      ["x", "y", "width", "height"].every(
        (name) =>
          this.#bounds[name as keyof TextEditingBounds] === bounds[name as keyof TextEditingBounds],
      )
    )
      return;
    this.#bounds = bounds;
    this.#nativeReadPending = true;
    this.write(this.options.container, "--inkbook-text-editor-height", bounds.height);
    this.write(this.options.container, "--inkbook-text-editor-width", bounds.width);
    this.options.onBoundsChanged?.(bounds);
    this.options.context?.invalidate();
  }

  public update(viewport: SceneViewport, camera: SceneCamera, native = true): void {
    if (this.#released) return;
    const element = this.options.text.element;
    this.#camera = camera;
    const key = [
      viewport.left,
      viewport.top,
      viewport.width,
      viewport.height,
      camera.x,
      camera.zoom,
      this.#bounds.x,
      this.#bounds.y,
      this.#bounds.width,
      this.#bounds.height,
      element.rotation,
      element.pivot.x,
      element.pivot.y,
    ].join(",");
    const sameGeometry = key === this.#key;
    const previewTransform = this.options.text.group.getAttribute("transform");
    if (sameGeometry && previewTransform === this.#previewTransform && !this.#nativeReadPending)
      return;
    this.#key = key;
    this.#previewTransform = previewTransform;
    const local = native ? this.readMatrix(this.options.text.group) : undefined;
    const page = native ? this.readMatrix(this.options.context?.cameraGroup) : undefined;
    this.#cameraMatrix = page ?? textCameraMatrix(camera);
    this.#pageInverse = inverseTextMatrix(page ?? textCameraMatrix(camera));
    const inverse = inverseTextMatrix(local ?? textElementMatrix(element, camera));
    const rect =
      inverse &&
      textRectBounds(
        {
          left: viewport.left,
          top: viewport.top,
          right: viewport.left + viewport.width,
          bottom: viewport.top + viewport.height,
        },
        inverse,
      );
    const { x, y, width, height } = this.#bounds;
    const top = rect ? Math.max(0, Math.min(height, rect.minY - y)) : 0;
    const bottom = rect ? Math.max(top, Math.min(height, rect.maxY - y)) : 0;
    const visible =
      rect && rect.maxX >= x && rect.minX <= x + width && viewport.width > 0 && viewport.height > 0;
    const clippedHeight = visible ? bottom - top : 0;
    this.#nativeReadPending = !native;
    this.writeClip(top, clippedHeight, !sameGeometry);
  }

  private writeClip(top: number, clippedHeight: number, geometryChanged: boolean): void {
    this.#visibleTop = top;
    const values = this.#values.get(this.options.clip);
    const clipChanged =
      values?.get("--inkbook-text-viewport-top") !== `${top}px` ||
      values?.get("--inkbook-text-viewport-height") !== `${clippedHeight}px`;
    this.write(this.options.clip, "--inkbook-text-viewport-top", top);
    this.write(this.options.clip, "--inkbook-text-viewport-height", clippedHeight);
    if (this.options.isolatedInput)
      this.write(this.options.container, "--inkbook-text-viewport-top", top);
    if (geometryChanged || clipChanged) this.options.onChanged?.(geometryChanged);
  }

  public pageBounds(rect: TextClientRect) {
    if (this.options.isolatedInput) {
      if (this.#released) return undefined;
      const { x, y } = this.#bounds;
      return textRectBounds(
        {
          left: rect.left + x,
          right: rect.right + x,
          top: rect.top + y + this.#visibleTop,
          bottom: rect.bottom + y + this.#visibleTop,
        },
        textPreviewMatrix(this.options.text.element, this.options.text.previewMatrix),
      );
    }
    return this.#released || this.#pageInverse === undefined
      ? undefined
      : textRectBounds(rect, this.#pageInverse);
  }

  public toDrawingPoint(point: { readonly x: number; readonly y: number }) {
    if (this.#released) return undefined;
    const matrix = this.inputMatrix();
    const x = point.x + this.#bounds.x,
      y = point.y + this.#bounds.y + this.#visibleTop;
    return { x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f };
  }

  public fromDrawingPoint(point: { readonly x: number; readonly y: number }) {
    if (this.#released) return undefined;
    const inverse = inverseTextMatrix(this.inputMatrix());
    if (!inverse) return undefined;
    return {
      x: inverse.a * point.x + inverse.c * point.y + inverse.e - this.#bounds.x,
      y: inverse.b * point.x + inverse.d * point.y + inverse.f - this.#bounds.y - this.#visibleTop,
    };
  }

  public toDrawingRect(rect: TextClientRect): TextClientRect | undefined {
    if (this.#released) return undefined;
    const { x, y } = this.#bounds;
    const result = textRectBounds(
      {
        left: rect.left + x,
        right: rect.right + x,
        top: rect.top + y + this.#visibleTop,
        bottom: rect.bottom + y + this.#visibleTop,
      },
      this.inputMatrix(),
    );
    return (
      result && { left: result.minX, top: result.minY, right: result.maxX, bottom: result.maxY }
    );
  }

  private inputMatrix(): TextEditingMatrix {
    const camera = this.#cameraMatrix ?? textCameraMatrix(this.#camera);
    const own = textPreviewMatrix(this.options.text.element, this.options.text.previewMatrix);
    const [a, b, c, d, e, f] = multiplyAffineMatrices(
      [camera.a, camera.b, camera.c, camera.d, camera.e, camera.f],
      [own.a, own.b, own.c, own.d, own.e, own.f],
    );
    return { a, b, c, d, e, f };
  }

  public release(): void {
    this.#released = true;
    this.#pageInverse = undefined;
    this.#contentHeight = 0;
    this.#values.clear();
  }

  private readMatrix(node: SVGGElement | undefined): TextEditingMatrix | undefined {
    return node && typeof node.getScreenCTM === "function"
      ? (node.getScreenCTM() ?? undefined)
      : undefined;
  }

  private write(node: HTMLElement, name: string, value: number): void {
    const formatted = `${value}px`;
    let values = this.#values.get(node);
    if (!values) {
      values = new Map();
      this.#values.set(node, values);
    }
    if (values.get(name) === formatted) return;
    node.style.setProperty(name, formatted);
    values.set(name, formatted);
  }
}
