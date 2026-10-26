import type * as Schema from "../../../domain/schema/public";
import type { SceneContentRenderer } from "../content-renderer";
import type { SceneVisibilityCoordinator } from "../scene-visibility-coordinator";
import { validatePreviewVersion } from "../scene-runtime";
import type * as Scene from "../types";
import type { ProgressivePreviewPurpose } from "./connected-preview-cohort";
import { ScenePreviewCommitController } from "./preview-commit-handoff";
import type { ProgressivePreviewTransform } from "./progressive-element-preview";
import type { SceneElementPreviews } from "./scene-element-previews";
import type { SceneMotionController } from "./scene-motion-controller";
import type { SceneTransformPreviewController } from "./transform-preview-controller";

interface ScenePreviewInputOptions {
  readonly camera: () => Scene.SceneCamera;
  readonly elements: SceneElementPreviews;
  readonly schedule: () => void;
  readonly transforms: SceneTransformPreviewController;
  readonly viewport: () => Scene.SceneViewport | undefined;
  readonly visibility: SceneVisibilityCoordinator;
}

export class ScenePreviewInput {
  public readonly commits: ScenePreviewCommitController;

  public constructor(
    motion: SceneMotionController,
    private readonly content: SceneContentRenderer,
    private readonly options: ScenePreviewInputOptions,
  ) {
    this.commits = new ScenePreviewCommitController(
      motion,
      () => {
        options.transforms.clear();
        options.elements.clear();
        this.releasePreviews();
      },
      () => {
        if (content.hasSharedSelectionCommitFeedback && options.transforms.values.size === 0) {
          options.visibility.captureCommittedPreview(this.commits);
        }
      },
    );
  }

  public setTransform(
    ids: readonly string[],
    transform: string | null,
    version: number,
    strokeWidth: Scene.PreviewStrokeWidth,
    transformBounds?: Scene.PreviewBoundsTransform,
    matrix?: ProgressivePreviewTransform["matrix"] | ProgressivePreviewTransform,
  ): void {
    validatePreviewVersion(version, "Preview transform");
    this.options.transforms.set(ids, transform, version, strokeWidth, transformBounds, matrix);
    this.options.schedule();
  }

  public setElements(items: readonly Schema.InkElementV1[], frame: number): void {
    validatePreviewVersion(frame, "Element preview");
    if (this.options.elements.immediate.set(items, frame)) this.options.schedule();
  }

  public setProgressiveElements(
    ids: readonly string[],
    materialize: (id: string) => Schema.InkElementV1 | undefined,
    version: number,
    feedback?: ProgressivePreviewTransform,
    mode?: ProgressivePreviewPurpose,
  ): void {
    validatePreviewVersion(version, "Progressive element preview");
    const request = { feedback, ids, materialize, version };
    this.content.stageSelectionFeedback(feedback);
    this.options.elements.setProgressive(
      request,
      this.options.viewport(),
      this.options.camera(),
      mode,
    );
    this.options.schedule();
  }

  public clear(kind: "transform" | "progressive" | "element"): void {
    if (this.commits.requestClear()) return;
    const cleared =
      kind === "transform"
        ? this.options.transforms.clear()
        : kind === "progressive"
          ? this.options.elements.clearProgressive()
          : this.options.elements.clear();
    if (cleared) this.releasePreviews();
  }

  private releasePreviews(): void {
    this.options.visibility.releasePreviews();
    this.options.schedule();
  }
}
