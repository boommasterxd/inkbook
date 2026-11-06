import { afterEach, beforeEach, vi } from "vitest";
import type { InkElementV1, PointV1 } from "../../../src/domain/schema/public";
import { ElementStore } from "../../../src/domain/store/public";
import { createBuiltInSettings } from "../../../src/domain/settings/defaults";
import type { HoldToShapeSettingsV1, ToolDefaultsV1 } from "../../../src/domain/settings/types";
import type { WorkScheduler } from "../../../src/domain/scheduling/work-scheduler";
import {
  CreationPreview,
  type CreationSnapPorts,
} from "../../../src/obsidian/embeds/active-editor/previews/creation-preview";
import { ElementSceneStore } from "../../../src/obsidian/embeds/active-editor/scene-store";
import type { EditableDocumentModel } from "../../../src/obsidian/embeds/document-session/document-model-port";
import { activeEditorStoreHistory } from "./active-editor";
import { immediateWorkScheduler, pausedWorkScheduler } from "./immediate-work-scheduler";
import { elementReplacementPorts } from "./element-mutation-ports";
import { createWorkerSnapshot } from "../persistence/worker-snapshot";
import { createSceneFixture, sceneDeltaEntries } from "../rendering/scene";
import { fakeNode } from "../../unit/rendering/scene/fakes";
import { endpointMotif } from "../../unit/domain/recognition/arrow-fixtures";
import { quadraticSamples } from "../../unit/domain/recognition/recognition-fixtures";

export const HOLD_IDENTITY = { createdAt: 1, id: "00000000-0000-4000-8000-000000000001" };
export const HOLD_SETTINGS = { enabled: true, holdDurationMs: 600, jitterTolerancePx: 4 };
interface HoldFixtureOptions {
  readonly points: readonly number[];
  readonly settings?: HoldToShapeSettingsV1;
  readonly pausedRecognition?: boolean;
  readonly elements?: readonly InkElementV1[];
  readonly snap?: (scene: ElementSceneStore) => CreationSnapPorts;
  readonly workScheduler?: WorkScheduler;
  readonly holdEnabled?: boolean;
}

export function useHoldFixtures() {
  const cleanup: (() => void)[] = [];
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    for (const dispose of cleanup.splice(0)) dispose();
    vi.useRealTimers();
  });
  return (fixture: ReturnType<typeof createHoldFixture>) => {
    cleanup.push(fixture.dispose);
    return fixture;
  };
}

function holdDefaults(): ToolDefaultsV1 {
  const defaults = createBuiltInSettings().toolDefaults;
  for (const kind of ["line", "rectangle", "arrow"] as const) {
    defaults.shapes[kind].outlineColor = { type: "rgba", value: "#EF4444FF" };
    defaults.shapes[kind].outlineOpacity = 0.6;
    defaults.shapes[kind].outlineStyle = "dashed";
    defaults.shapes[kind].outlineWidth = 4;
  }
  defaults.shapes.rectangle.fillOpacity = 0.4;
  defaults.shapes.rectangle.fillColor = { type: "rgba", value: "#3B82F6FF" };
  defaults.pen = {
    ...defaults.pen,
    color: { type: "rgba", value: "#22C55EFF" },
    width: 8,
    opacity: 0.5,
    pressureEnabled: false,
  };
  return defaults;
}

export function createHoldFixture(options: HoldFixtureOptions) {
  const store = new ElementStore(options.elements ?? []);
  const sceneStore = new ElementSceneStore(store);
  const scene = createSceneFixture(createWorkerSnapshot([]).page, sceneStore);
  scene.scheduler.runAll();
  let revision = 0;
  const unsubscribe = store.subscribe((delta) => {
    revision++;
    scene.renderer.applyDelta({ affected: sceneDeltaEntries(delta) });
  });
  const history = activeEditorStoreHistory(store);
  const defaults = holdDefaults();
  if (options.holdEnabled !== undefined) defaults.pen.holdToShapeEnabled = options.holdEnabled;
  const admission = pausedWorkScheduler();
  const refinement = new AbortController();
  let current = true;
  const model = {
    store,
    ...elementReplacementPorts(store),
    beginInteractiveOperation: () => () => undefined,
  } as unknown as EditableDocumentModel;
  const preview = new CreationPreview({
    defaults,
    history,
    model,
    identity: HOLD_IDENTITY,
    renderer: scene.renderer,
    holdToShape: options.settings ?? { ...HOLD_SETTINGS },
    ownerWindow: {
      performance: { now: () => Date.now() },
      setTimeout: (callback: () => void, delay: number) => window.setTimeout(callback, delay),
      clearTimeout: (handle: ReturnType<typeof setTimeout>) => window.clearTimeout(handle),
    } as unknown as Window,
    workScheduler:
      options.workScheduler ??
      (options.pausedRecognition ? admission.scheduler : immediateWorkScheduler()),
    isCurrent: () => current,
    readRevision: () => revision,
    refinementSignal: refinement.signal,
    ...(options.snap === undefined ? {} : { snap: options.snap(sceneStore) }),
    start: {
      additive: false,
      kind: "tool-gesture",
      tool: "draw",
      pointer: holdPointer(options.points[0]!, options.points[1]!),
    },
  });
  const samples = Array.from({ length: options.points.length / 3 - 1 }, (_, index) => ({
    ...holdPointer(options.points[(index + 1) * 3]!, options.points[(index + 1) * 3 + 1]!),
    time: index + 1,
  }));
  preview.observeInputSamples(samples);
  preview.updateSamples(samples);
  scene.scheduler.runAll();
  const camera = fakeNode(scene.renderer.svg).nodes[1]!;
  return {
    ...scene,
    store,
    sceneStore,
    history,
    preview,
    defaults,
    admission,
    refinement,
    ghost: camera.nodes[5]!,
    raw: camera.nodes[6]!,
    marker: fakeNode(scene.renderer.svg).nodes[2]!.nodes[3]!,
    invalidate: () => {
      current = false;
    },
    dispose: () => {
      preview.revert();
      history.dispose();
      unsubscribe();
      scene.renderer.destroy();
      sceneStore.release();
    },
  };
}

export function holdPointer(x: number, y: number) {
  return { pointerId: 1, pointerType: "pen" as const, pressure: 0.5, x, y };
}

export function advanceHold(fixture: ReturnType<typeof createHoldFixture>, duration = 600): void {
  vi.advanceTimersByTime(duration);
  fixture.scheduler.runAll();
}

export function curvedArrowSamples(): number[] {
  const tangent = Math.atan2(50, 60);
  const motif = (point: PointV1, start: boolean) => {
    const dx = start ? 120 - point.x : point.x - 120;
    const dy = start ? -point.y : point.y;
    const angle = start ? -tangent : tangent;
    return [
      (start ? 0 : 120) + dx * Math.cos(angle) - dy * Math.sin(angle),
      dx * Math.sin(angle) + dy * Math.cos(angle),
      0.5,
    ];
  };
  const shaft = quadraticSamples({ x: 60, y: -50 }, { x: 120, y: 0 }, 61);
  return [
    ...endpointMotif("circle")
      .reverse()
      .flatMap((point) => motif(point, true)),
    ...shaft.slice(3),
    ...endpointMotif("triangle")
      .slice(1)
      .flatMap((point) => motif(point, false)),
  ];
}
