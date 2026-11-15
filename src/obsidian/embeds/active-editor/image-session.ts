import { applyImageCrop } from "../../../domain/images/image-crop";
import { initialImageSize } from "../../../domain/images/image-insertion-size";
import {
  canonicalizeGeometryNumber,
  type ImageCropV3,
  type ImageElementV3,
  type PointV1,
} from "../../../domain/schema/public";
import type {
  EditorChromeOpenings,
  ImportedImageBatch,
} from "../active-scene/editor-chrome-openings";
import type { EditableDocumentModel } from "../document-session/document-model-port";
import { registerAppliedDocumentMutation } from "./document-history";
import { captureElementReplacementHistory, type ActiveEditorHistory } from "./history";
import type { SvgSceneRenderer } from "../../../rendering/scene/scene-renderer";

export interface ActiveImageSessionOptions extends Pick<
  EditorChromeOpenings,
  "onImportImages" | "onCropImage"
> {
  readonly model: EditableDocumentModel;
  readonly history: ActiveEditorHistory;
  readonly ownerWindow: Window;
  readonly isEnabled: () => boolean;
  readonly finishText: () => Promise<boolean>;
  readonly selection: () => ReadonlySet<string>;
  readonly select: (selection: ReadonlySet<string>) => void;
  readonly visibleCenter: () => PointV1;
  readonly onCommitted: () => void;
  readonly onFailed: () => void;
  readonly renderer?: Partial<
    Pick<SvgSceneRenderer, "beginPreviewCommit" | "clearElementPreviews">
  >;
}

/** One presentation owns local import/crop drafts until a prepared document mutation commits. */
export class ActiveImageSession {
  readonly #options: ActiveImageSessionOptions;
  #operation: AbortController | undefined;
  #disposed = false;

  public constructor(options: ActiveImageSessionOptions) {
    this.#options = options;
  }

  public cancel(): void {
    this.#operation?.abort();
    this.#operation = undefined;
  }

  public dispose(): void {
    this.#disposed = true;
    this.cancel();
  }

  public get canImport(): boolean {
    return (
      this.#options.onImportImages !== undefined &&
      this.#options.model.addImageResources !== undefined
    );
  }

  public get canCrop(): boolean {
    const image = this.#selectedImage();
    return (
      this.#options.onCropImage !== undefined &&
      image !== undefined &&
      this.#options.model.imageResource?.(image.assetId) !== undefined
    );
  }

  public get selectedImageId(): string | undefined {
    return this.#selectedImage()?.id;
  }

  public import(point?: PointV1): void {
    if (!this.canImport) return;
    void this.#run(async (signal) => {
      const options = this.#options;
      const center = point ?? options.visibleCenter();
      const revision = options.model.revision;
      const imported = await options.onImportImages!(signal, options.ownerWindow);
      if (
        imported === undefined ||
        imported.resources.length === 0 ||
        !this.#current(signal, revision)
      )
        return;
      const { resources } = imported;
      if (resources.length > 20) throw new RangeError("Image imports are limited to twenty pages.");
      const elements = createImportedImages(
        imported,
        center,
        options.model.page,
        options.ownerWindow.crypto,
      );
      await options.model.addImageResources!(resources);
      if (!this.#current(signal, revision)) return;
      const isCancelled = () => !this.#current(signal, revision);
      const prepared = await options.model.prepareElementAppend(elements, { isCancelled });
      if (prepared.status !== "prepared" || prepared.token === null || isCancelled()) return;
      const applied = options.model.commitPreparedElementMutation(prepared.token);
      if (applied === null) return;
      registerAppliedDocumentMutation(options.history, options.model, applied);
      options.select(new Set(elements.map(({ id }) => id)));
      options.onCommitted();
    });
  }

  public crop(): void {
    if (!this.canCrop) return;
    const image = this.#selectedImage();
    void this.#run(async (signal) => {
      const options = this.#options;
      if (this.#selectedImage() !== image) return;
      const resource =
        image === undefined ? undefined : options.model.imageResource?.(image.assetId);
      if (image === undefined || resource === undefined) return;
      const revision = options.model.revision;
      const previewCommit = options.renderer?.beginPreviewCommit?.();
      let previewReleased = false;
      const clearPreview = () => {
        if (previewReleased) return;
        previewReleased = true;
        options.renderer?.clearElementPreviews?.();
        previewCommit?.cancel();
      };
      signal.addEventListener("abort", clearPreview, { once: true });
      try {
        const crop = await options.onCropImage!(image, resource, signal, options.ownerWindow);
        if (
          crop === undefined ||
          !this.#current(signal, revision) ||
          this.#selectedImage() !== image
        )
          return;
        if (sameCrop(crop, image.crop)) return;
        const replacement = applyImageCrop(image, crop);
        const captured = captureElementReplacementHistory([image], [replacement]);
        const isCancelled = () =>
          !this.#current(signal, revision) || this.#selectedImage() !== image;
        const prepared = await options.model.prepareElementReplacement([replacement], {
          isCancelled,
        });
        if (prepared.status !== "prepared" || prepared.token === null || isCancelled()) return;
        if (previewCommit !== undefined && !previewCommit.arm([image.id])) return;
        if (
          options.model.commitPreparedElementReplacement(prepared.token, captured.capture) !==
          "committed"
        )
          return;
        const replay = async (elements: readonly ImageElementV3[]) => {
          const basis = options.model.revision;
          const cancelled = () => options.history.isDisposed || options.model.revision !== basis;
          const ready = await options.model.prepareElementReplacement(elements, {
            isCancelled: cancelled,
          });
          return (
            ready.status === "prepared" &&
            ready.token !== null &&
            !cancelled() &&
            options.model.commitPreparedElementReplacement(ready.token) === "committed"
          );
        };
        options.history.registerApplied({
          payloadBytes: captured.payloadBytes,
          undo: () => replay(captured.previous as readonly ImageElementV3[]),
          redo: () => replay(captured.replacements as readonly ImageElementV3[]),
        });
        options.onCommitted();
      } finally {
        signal.removeEventListener("abort", clearPreview);
        clearPreview();
      }
    });
  }

  async #run(operation: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const options = this.#options;
    if (this.#operation !== undefined || this.#disposed || !options.isEnabled()) return;
    const controller = new AbortController();
    this.#operation = controller;
    try {
      if (
        !(await options.finishText()) ||
        !this.#current(controller.signal, options.model.revision)
      )
        return;
      await operation(controller.signal);
    } catch {
      if (!controller.signal.aborted && !this.#disposed) options.onFailed();
    } finally {
      if (this.#operation === controller) this.#operation = undefined;
    }
  }

  #current(signal: AbortSignal, revision: number): boolean {
    return (
      !signal.aborted &&
      !this.#disposed &&
      this.#options.isEnabled() &&
      !this.#options.history.isTraversing &&
      !this.#options.history.isDisposed &&
      this.#options.model.revision === revision
    );
  }

  #selectedImage(): ImageElementV3 | undefined {
    const selection = this.#options.selection();
    if (selection.size !== 1) return undefined;
    const id = selection.values().next().value as string;
    const element = this.#options.model.store.get(id)?.element;
    return element?.kind === "image" ? element : undefined;
  }
}

function createImportedImages(
  imported: ImportedImageBatch,
  center: PointV1,
  page: EditableDocumentModel["page"],
  crypto: Pick<Crypto, "randomUUID">,
): ImageElementV3[] {
  const { resources, source } = imported;
  const first = resources[0]!;
  const firstSize = initialImageSize(first, page.innerWidth, source);
  let y = Math.max(page.margin, center.y - firstSize.height / 2);
  return resources.map((resource, index) => {
    const size = index === 0 ? firstSize : initialImageSize(resource, page.innerWidth, source);
    const width = canonicalizeGeometryNumber(size.width);
    const height = canonicalizeGeometryNumber((width * resource.height) / resource.width);
    const x = canonicalizeGeometryNumber(
      Math.max(page.margin, Math.min(center.x - width / 2, page.margin + page.innerWidth - width)),
    );
    const top = canonicalizeGeometryNumber(y);
    y += height + page.margin;
    return {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      kind: "image",
      assetId: resource.id,
      x,
      y: top,
      width,
      height,
      rotation: 0,
      pivot: {
        x: canonicalizeGeometryNumber(x + width / 2),
        y: canonicalizeGeometryNumber(top + height / 2),
      },
      crop: { x: 0, y: 0, width: resource.width, height: resource.height },
    };
  });
}

function sameCrop(left: ImageCropV3, right: ImageCropV3): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}
