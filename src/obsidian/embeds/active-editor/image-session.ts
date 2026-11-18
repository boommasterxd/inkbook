import { applyImageCrop } from "../../../domain/images/image-crop";
import { initialImageSize, initialImageX } from "../../../domain/images/image-insertion-size";
import { IMAGE_LIMITS } from "../../../domain/images/image-limits";
import {
  canonicalizeGeometryNumber,
  type ImageCropV3,
  type ImageElementV3,
  type PointV1,
} from "../../../domain/schema/public";
import type {
  EditorChromeOpenings,
  ImageImportRequest,
  ImportedImageBatch,
} from "../active-scene/editor-chrome-openings";
import type { EditableDocumentModel } from "../document-session/document-model-port";
import { ImageResourceCapacityError } from "../document-session/session-image-resources";
import { registerAppliedDocumentMutation } from "./document-history";
import { captureElementReplacementHistory, type ActiveEditorHistory } from "./history";
import type { SvgSceneRenderer } from "../../../rendering/scene/scene-renderer";
import type { PreviewCommitHandoff } from "../../../rendering/scene/presentation/preview-commit-handoff";

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
  readonly onCommitted: (preserveTool?: boolean) => void;
  readonly onFailed: (reason?: "capacity") => void;
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
      this.#options.model.prepareImageResources !== undefined
    );
  }

  public get canCrop(): boolean {
    const image = this.#selectedImage();
    return (
      this.#options.onCropImage !== undefined &&
      image !== undefined &&
      image.locked !== true &&
      this.#options.model.imageResource?.(image.assetId) !== undefined
    );
  }

  public get selectedImageId(): string | undefined {
    return this.#selectedImage()?.id;
  }

  public import(point?: PointV1): void {
    if (!this.canImport) return;
    void this.#run((signal) => {
      const options = this.#options;
      const center = point ?? options.visibleCenter();
      return options.onImportImages!(signal, options.ownerWindow, {
        page: options.model.page,
        centerX: center.x,
        retainedResources: () =>
          this.#current(signal, options.model.revision) ? options.model.imageResources : undefined,
        submit: this.#importSubmission(center, signal),
      });
    });
  }

  #importSubmission(center: PointV1, signal: AbortSignal): ImageImportRequest["submit"] {
    const { model, history } = this.#options;
    let submitting = false;
    let committed = false;
    return async (imported, dialogSignal) => {
      const revision = model.revision;
      const isCancelled = () =>
        dialogSignal.aborted ||
        this.#operation?.signal !== signal ||
        !this.#current(signal, revision);
      if (submitting || committed || isCancelled() || imported.resources.length === 0)
        return "unavailable";
      if (imported.resources.length > IMAGE_LIMITS.pdfSelectedPages) return "capacity";
      submitting = true;
      try {
        const prepared = await this.#prepareImport(imported, center, isCancelled);
        if (prepared === null || isCancelled()) return "unavailable";
        const applied = model.commitPreparedElementMutation(prepared.token, prepared.resources);
        if (applied === null) return "unavailable";
        committed = true;
        registerAppliedDocumentMutation(history, model, applied);
        const locked = imported.placement === "page-width-locked";
        this.#options.select(new Set(locked ? [] : prepared.elements.map(({ id }) => id)));
        this.#options.onCommitted(locked);
        return "committed";
      } catch (error) {
        if (committed) {
          this.#options.onFailed();
          return "committed";
        }
        if (isCancelled()) return "unavailable";
        if (error instanceof ImageResourceCapacityError) return "capacity";
        throw error;
      } finally {
        submitting = false;
      }
    };
  }

  async #prepareImport(imported: ImportedImageBatch, center: PointV1, isCancelled: () => boolean) {
    const { model, ownerWindow } = this.#options;
    const resources = await model.prepareImageResources!(imported.resources, { isCancelled });
    if (resources === null || isCancelled()) return null;
    const elements = createImportedImages(imported, center, model.page, ownerWindow.crypto);
    const prepared = await model.prepareElementAppend(elements, { isCancelled });
    return prepared.status === "prepared" && prepared.token !== null
      ? { elements, resources, token: prepared.token }
      : null;
  }

  public crop(): void {
    if (!this.canCrop) return;
    const image = this.#selectedImage();
    void this.#run(async (signal) => {
      const options = this.#options;
      if (this.#selectedImage() !== image) return;
      const resource =
        image === undefined ? undefined : options.model.imageResource?.(image.assetId);
      if (image === undefined || image.locked === true || resource === undefined) return;
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
        if (crop === undefined || !this.#currentImage(image, signal, revision)) return;
        if (sameCrop(crop, image.crop)) return;
        const replacement = applyImageCrop(image, crop);
        const isCancelled = () => !this.#currentImage(image, signal, revision);
        if (await this.#replaceImage(image, replacement, isCancelled, previewCommit))
          options.onCommitted();
      } finally {
        signal.removeEventListener("abort", clearPreview);
        clearPreview();
      }
    });
  }

  async #replaceImage(
    image: ImageElementV3,
    replacement: ImageElementV3,
    isCancelled: () => boolean,
    previewCommit?: Pick<PreviewCommitHandoff, "arm">,
  ): Promise<boolean> {
    const options = this.#options;
    const captured = captureElementReplacementHistory([image], [replacement]);
    const prepared = await options.model.prepareElementReplacement([replacement], {
      isCancelled,
      protectLocked: true,
    });
    if (prepared.status !== "prepared" || prepared.token === null || isCancelled()) return false;
    if (previewCommit !== undefined && !previewCommit.arm([image.id])) return false;
    if (
      options.model.commitPreparedElementReplacement(prepared.token, captured.capture) !==
      "committed"
    )
      return false;
    const replay = async (elements: readonly ImageElementV3[]) => {
      const basis = options.model.revision;
      const cancelled = () => options.history.isDisposed || options.model.revision !== basis;
      const ready = await options.model.prepareElementReplacement(elements, {
        isCancelled: cancelled,
        protectLocked: false,
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
    return true;
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
    } catch (error) {
      if (!controller.signal.aborted && !this.#disposed)
        options.onFailed(error instanceof ImageResourceCapacityError ? "capacity" : undefined);
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

  #currentImage(image: ImageElementV3, signal: AbortSignal, revision: number): boolean {
    const selected = this.#selectedImage();
    return selected === image && selected.locked !== true && this.#current(signal, revision);
  }
}

function createImportedImages(
  imported: ImportedImageBatch,
  center: PointV1,
  page: EditableDocumentModel["page"],
  crypto: Pick<Crypto, "randomUUID">,
): ImageElementV3[] {
  const { resources, source, placement } = imported;
  const locked = placement === "page-width-locked";
  const first = resources[0]!;
  const firstSize = initialImageSize(first, page.innerWidth, source, placement);
  let y = Math.max(page.margin, center.y - firstSize.height / 2);
  return resources.map((resource, index) => {
    const size =
      index === 0 ? firstSize : initialImageSize(resource, page.innerWidth, source, placement);
    const width = canonicalizeGeometryNumber(size.width);
    const height = canonicalizeGeometryNumber((width * resource.height) / resource.width);
    const x = initialImageX(width, page, center.x, placement);
    const top = canonicalizeGeometryNumber(y);
    y += height + page.margin;
    return {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      kind: "image",
      ...(locked ? { locked: true } : {}),
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
