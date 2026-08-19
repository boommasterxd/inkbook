import type { ViewResourceContext } from "../../../../src/adapters/obsidian/views";
import { PhaseZeroViewRegistry } from "../../../../src/adapters/obsidian/views";
import {
  RESOURCE_BUDGET_V1,
  ResourceCoordinatorV1,
  type ResourceBudgetProfileV1,
} from "../../../../src/application/resource-coordinator";

export interface PhaseZeroRegistryHarness {
  readonly coordinator: ResourceCoordinatorV1;
  readonly registry: PhaseZeroViewRegistry;
}

export interface TestTouchPoint {
  readonly clientX: number;
  readonly clientY?: number;
  readonly identifier: number;
}

export function phaseZeroRegistryHarness(
  profile: ResourceBudgetProfileV1 = RESOURCE_BUDGET_V1.desktopOrAndroidTablet,
): PhaseZeroRegistryHarness {
  const coordinator = new ResourceCoordinatorV1(profile);
  return { coordinator, registry: new PhaseZeroViewRegistry(coordinator) };
}

export function phaseZeroViewRegistry(): PhaseZeroViewRegistry {
  return phaseZeroRegistryHarness().registry;
}

export function installObsidianElementProperties(
  element: HTMLElement,
  pointerCapture?: Readonly<{
    has: (pointerId: number) => boolean;
    release: (pointerId: number) => void;
    set: (pointerId: number) => void;
  }>,
): void {
  Object.defineProperties(element, {
    doc: { get: (): Document => document },
    hasPointerCapture: {
      value: pointerCapture?.has ?? ((): boolean => true),
    },
    releasePointerCapture: {
      value: pointerCapture?.release ?? ((): void => undefined),
    },
    setPointerCapture: {
      value: pointerCapture?.set ?? ((): void => undefined),
    },
    win: { get: (): Window => window },
  });
}

export function phaseZeroViewContext(
  container: HTMLElement,
  surface: "live-preview" | "reading" | "source",
): ViewResourceContext {
  const environment = {
    doc: document,
    instanceOf: (): boolean => true,
    onWindowMigrated: (): { dispose(): void } => ({
      dispose: (): void => undefined,
    }),
    win: window,
  };
  return {
    document,
    element: environment,
    fileIdentity: "note.md",
    leaf: {
      isDeferred: false,
      readView: (): never => {
        throw new Error();
      },
    },
    surface,
    viewIdentity: { containerEl: container },
    window,
  };
}

export function pointer(type: string, options: PointerEventInit): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    ...options,
  });
}

export function directTouch(
  type: string,
  changed: readonly TestTouchPoint[],
  active: readonly TestTouchPoint[],
  cancelable = type !== "touchcancel",
): TouchEvent {
  const event = new Event(type, { bubbles: true, cancelable }) as TouchEvent;
  Object.defineProperties(event, {
    changedTouches: { value: touchList(changed) },
    targetTouches: { value: touchList(active) },
    touches: { value: touchList(active) },
  });
  return event;
}

function touchList(points: readonly TestTouchPoint[]): TouchList {
  const values = points.map(
    (point) =>
      ({
        clientX: point.clientX,
        clientY: point.clientY ?? 0,
        identifier: point.identifier,
      }) as Touch,
  );
  return Object.assign(values, {
    item: (index: number): Touch | null => values[index] ?? null,
  });
}
