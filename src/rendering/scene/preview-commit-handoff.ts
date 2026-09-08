import type { SceneMotionController } from "./scene-motion-controller";

export interface PreviewCommitHandoff {
  arm(ids: readonly string[]): boolean;
  cancel(): void;
}

interface ActiveHandoff {
  clearRequested: boolean;
  motionSuppressionToken: number | undefined;
  readonly token: number;
}

export class ScenePreviewCommitController {
  readonly #motion: SceneMotionController;
  readonly #onCancelledClear: () => void;
  #active: ActiveHandoff | undefined;
  #committed = false;
  #nextToken = 0;

  public constructor(motion: SceneMotionController, onCancelledClear: () => void) {
    this.#motion = motion;
    this.#onCancelledClear = onCancelledClear;
  }

  public begin(): PreviewCommitHandoff {
    this.release();
    const token = ++this.#nextToken;
    this.#active = { clearRequested: false, motionSuppressionToken: undefined, token };
    return {
      arm: (ids) => this.arm(token, ids),
      cancel: () => this.cancel(token),
    };
  }

  public consume(motionSuppressionToken: number | undefined): boolean {
    const active = this.#active;
    if (
      active?.motionSuppressionToken === undefined ||
      active.motionSuppressionToken !== motionSuppressionToken
    ) {
      return false;
    }
    this.#active = undefined;
    this.#committed = true;
    return true;
  }

  public requestClear(): boolean {
    if (this.#active !== undefined) {
      this.#active.clearRequested = true;
      return true;
    }
    return this.#committed;
  }

  public release(): void {
    const suppression = this.#active?.motionSuppressionToken;
    if (suppression !== undefined) this.#motion.cancelSuppression(suppression);
    this.#active = undefined;
    this.#committed = false;
  }

  public releaseCommitted(): boolean {
    const committed = this.#committed;
    this.#committed = false;
    return committed;
  }

  private arm(token: number, ids: readonly string[]): boolean {
    const active = this.#active;
    if (active?.token !== token) return false;
    active.motionSuppressionToken = this.#motion.suppress(ids);
    return true;
  }

  private cancel(token: number): void {
    if (this.#active?.token !== token) return;
    const clearRequested = this.#active.clearRequested;
    this.release();
    if (clearRequested) this.#onCancelledClear();
  }
}
