import type { InputPoint } from "../../../../editor/input/index";
import type { ActiveEditorViewState } from "./navigation-types";
import type { NavigationLayoutRead } from "./navigation-layout";

export interface PinchFrameTarget {
  readonly pagePoint: InputPoint;
  readonly clientPoint: { readonly clientX: number; readonly clientY: number };
  readonly zoom: number;
}

export function validPinchSample(anchor: InputPoint, factor = 1): boolean {
  return (
    Number.isFinite(anchor.x) && Number.isFinite(anchor.y) && Number.isFinite(factor) && factor >= 0
  );
}

/** Keep the gesture's original content point under its latest screen midpoint. */
export class NavigationPinch {
  #origin:
    | (ActiveEditorViewState & {
        readonly pagePoint: InputPoint;
        readonly left: number;
        readonly top: number;
      })
    | undefined;
  #pending: PinchFrameTarget | undefined;

  public begin(
    anchor: InputPoint,
    view: ActiveEditorViewState,
    layout: NavigationLayoutRead,
  ): void {
    this.#origin = {
      ...view,
      pagePoint: { x: anchor.x / view.zoom - view.cameraX, y: anchor.y / view.zoom },
      left: layout.containerBounds.left,
      top: layout.containerBounds.top,
    };
    this.#pending = undefined;
  }

  public update(anchor: InputPoint, factor: number): void {
    const origin = this.#origin;
    if (origin === undefined) return;
    this.#pending = {
      pagePoint: origin.pagePoint,
      clientPoint: { clientX: origin.left + anchor.x, clientY: origin.top + anchor.y },
      zoom: origin.zoom * factor,
    };
  }

  public take(): PinchFrameTarget | undefined {
    const pending = this.#pending;
    this.#pending = undefined;
    return pending;
  }

  public get pending(): boolean {
    return this.#pending !== undefined;
  }

  public get active(): boolean {
    return this.#origin !== undefined;
  }

  public finish(): void {
    this.#origin = undefined;
  }

  public reset(): void {
    this.finish();
    this.#pending = undefined;
  }
}
