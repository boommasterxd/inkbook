import type { PointV1, InkElementV1 } from "../../../../domain/schema/public";
import type { WorkScheduler } from "../../../../domain/scheduling/work-scheduler";
import type { HoldToShapeSettingsV1, ToolDefaultsV1 } from "../../../../domain/settings/types";
import { HoldToShapeSession } from "../../../../editor/tools/hold-to-shape-session";
import { createRecognizedElement } from "../../../../editor/tools/recognized-creation";
import { ActiveEditorLongPressScheduler } from "../input/long-press";
import { editLinearEndpoint } from "../../../../editor/selection/transform/linear-transforms";
import type { SnapCandidate } from "../../../../editor/snapping/snap-candidate";
import type { CreationPreviewOptions } from "./creation-preview-types";

interface CreationHoldOptions {
  readonly settings: HoldToShapeSettingsV1;
  readonly defaults: ToolDefaultsV1;
  readonly identity: { readonly id: string; readonly createdAt: number };
  readonly ownerWindow: Window;
  readonly scheduler: WorkScheduler;
  readonly start: PointV1;
  readonly zoom: number;
  readonly readPoints: () => readonly number[];
  readonly isCurrent: () => boolean;
  readonly onPreview: (element: InkElementV1 | null) => void;
}

/** Adapts owned host timers and native creation to the portable hold state machine. */
export class CreationHoldRecognition {
  readonly #session: HoldToShapeSession;
  readonly #timers: ActiveEditorLongPressScheduler;

  public constructor(options: CreationHoldOptions) {
    this.#timers = new ActiveEditorLongPressScheduler(options.ownerWindow);
    let nextTimer = 0;
    this.#session = new HoldToShapeSession({
      settings: structuredClone(options.settings),
      start: options.start,
      zoom: options.zoom,
      readPoints: options.readPoints,
      scheduler: options.scheduler,
      isCurrent: options.isCurrent,
      clock: {
        now: () => options.ownerWindow.performance.now(),
        cancel: (handle) => this.#timers.cancel(handle),
        schedule: (delayMs, callback) => {
          const handle = ++nextTimer;
          this.#timers.schedule(handle, delayMs, callback);
          return handle;
        },
      },
      onPreview: (recognition) => {
        const element =
          recognition === null
            ? null
            : createRecognizedElement({
                identity: options.identity,
                defaults: options.defaults,
                recognition,
              });
        options.onPreview(element);
      },
    });
  }

  public observe(samples: readonly PointV1[]): void {
    this.#session.observe(samples);
  }

  public dispose(): void {
    this.#session.dispose();
    this.#timers.dispose();
  }
}

export function createCreationHold(
  options: CreationPreviewOptions,
  readPoints: () => readonly number[],
  isCurrent: () => boolean,
  onPreview: CreationHoldOptions["onPreview"],
): CreationHoldRecognition | undefined {
  if (
    options.start.tool !== "draw" ||
    options.holdToShape?.enabled !== true ||
    !options.defaults.pen.holdToShapeEnabled ||
    options.ownerWindow === undefined ||
    options.workScheduler === undefined
  )
    return undefined;
  return new CreationHoldRecognition({
    settings: options.holdToShape,
    defaults: options.defaults,
    identity: options.identity,
    ownerWindow: options.ownerWindow,
    scheduler: options.workScheduler,
    start: options.screenStart ?? options.start.pointer,
    zoom: options.strokeInput?.zoom ?? 1,
    readPoints,
    isCurrent,
    onPreview,
  });
}

/** Reuse endpoint editing without rebuilding the recognized curve, decorations or paint. */
export function connectRecognizedElement(
  element: InkElementV1,
  candidates: readonly [SnapCandidate | null, SnapCandidate | null],
): InkElementV1 {
  if (element.kind !== "line" && element.kind !== "arrow") return element;
  let result: InkElementV1 = element;
  for (const [endpoint, candidate] of [
    ["start", candidates[0]],
    ["end", candidates[1]],
  ] as const) {
    if (candidate === null) continue;
    result = editLinearEndpoint(result, endpoint, candidate.point, {
      connection: { anchor: candidate.anchor, targetId: candidate.targetId },
    });
  }
  return result;
}

/** A raw press offers only a provisional start; recognized shafts own both endpoints. */
export function creationHoldSnapEndpoints(
  element: InkElementV1 | null,
  start: CreationPreviewOptions["start"]["pointer"],
  pointer: CreationPreviewOptions["start"]["pointer"],
  provisional: boolean,
) {
  const linear = element?.kind === "line" || element?.kind === "arrow";
  return {
    start: linear ? element.start : start,
    end: linear ? { ...pointer, ...element.end } : pointer,
    endEnabled: linear,
    enabled: linear || (element === null && provisional),
  };
}
