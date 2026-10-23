import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { BrowserScrollElement } from "../../scrolling/index";
import { HostZoomMeasureThrottle } from "./host-zoom-measure-throttle";

export interface HostZoomScroll {
  readonly geometryRevision?: number;
  retain(owner: BrowserScrollElement, scrollTop: number, anchor?: HostZoomScrollAnchor): void;
  cancel(): void;
  dispose(): void;
}

export interface HostZoomScrollAnchor {
  readonly container: HTMLElement;
  readonly contentTop: number;
}

class LivePreviewZoomScroll {
  #pending: LivePreviewZoomScrollBinding | undefined;
  geometryRevision = 0;

  invalidateGeometry(): void {
    this.geometryRevision += 1;
  }

  retain(binding: LivePreviewZoomScrollBinding): void {
    if (this.#pending !== binding) this.#pending?.cancel();
    this.#pending = binding;
  }

  release(binding: LivePreviewZoomScrollBinding): void {
    if (this.#pending === binding) this.#pending = undefined;
  }

  settle(update: ViewUpdate): void {
    if (update.docChanged || update.geometryChanged || update.viewportChanged)
      this.invalidateGeometry();
    if (update.docChanged) this.#pending?.cancel();
    else this.#pending?.settle();
  }

  destroy(): void {
    this.#pending?.cancel();
  }
}

const zoomScrollPlugin = ViewPlugin.fromClass(LivePreviewZoomScroll);

export const LIVE_PREVIEW_ZOOM_SCROLL_EXTENSION = [
  zoomScrollPlugin,
  EditorView.updateListener.of((update) => update.view.plugin(zoomScrollPlugin)?.settle(update)),
];

/** Restores the input anchor after CodeMirror reconciles the changed widget height. */
export class LivePreviewZoomScrollBinding implements HostZoomScroll {
  readonly #view: EditorView;
  readonly #root: HTMLElement;
  readonly #scheduler: WorkScheduler;
  readonly #throttle: HostZoomMeasureThrottle;
  #owner: BrowserScrollElement | undefined;
  #anchor: HostZoomScrollAnchor | undefined;
  #scrollTop = 0;
  #epoch = 0;
  #measured = false;
  #measureQueued = false;
  #expiryFrame: number | undefined;
  #disposed = false;

  constructor(view: EditorView, root: HTMLElement, scheduler: WorkScheduler) {
    this.#view = view;
    this.#root = root;
    this.#scheduler = scheduler;
    const ownerWindow = root.ownerDocument.defaultView;
    if (ownerWindow === null) throw new Error("Missing zoom-scroll owner window.");
    this.#throttle = new HostZoomMeasureThrottle(ownerWindow, scheduler);
  }

  get geometryRevision(): number {
    return this.#view.plugin(zoomScrollPlugin)?.geometryRevision ?? -1;
  }

  retain(owner: BrowserScrollElement, scrollTop: number, anchor?: HostZoomScrollAnchor): void {
    const coordinator = this.#view.plugin(zoomScrollPlugin);
    if (
      this.#disposed ||
      owner !== this.#view.scrollDOM ||
      !Number.isFinite(scrollTop) ||
      coordinator === null
    ) {
      this.cancel();
      return;
    }
    this.#epoch += 1;
    this.#clearMeasurement();
    if (this.#owner !== owner) {
      if (this.#owner !== undefined) this.#listen(this.#owner, false);
      this.#listen(owner, true);
    }
    this.#owner = owner;
    this.#scrollTop = scrollTop;
    this.#anchor = anchor;
    coordinator.retain(this);
    if (!this.#measureQueued) this.#throttle.request(this.#requestMeasure);
  }

  readonly #requestMeasure = (): void => {
    if (
      this.#owner !== this.#view.scrollDOM ||
      !this.#root.isConnected ||
      !(this.#anchor?.container.isConnected ?? true)
    ) {
      this.cancel();
      return;
    }
    this.#measureQueued = true;
    this.#view.requestMeasure({
      key: this,
      read: () => {
        this.#measureQueued = false;
        return this.#epoch;
      },
      write: (measuredEpoch) => {
        if (measuredEpoch !== this.#epoch || this.#owner === undefined) return;
        this.#view.plugin(zoomScrollPlugin)?.invalidateGeometry();
        this.#measured = true;
        // Empty measurements have no update listener. Reconcile once in the next admitted frame.
        this.#expiryFrame = this.#scheduler.requestFrame(() => this.settle());
      },
    });
  };

  settle(): void {
    const owner = this.#owner;
    if (!this.#measured || owner === undefined) return;
    const anchor = this.#anchor;
    const attached =
      this.#root.isConnected &&
      owner === this.#view.scrollDOM &&
      (anchor?.container.isConnected ?? true);
    const currentScrollTop = attached ? owner.scrollTop : 0;
    const originDelta =
      !attached || anchor === undefined
        ? 0
        : anchor.container.getBoundingClientRect().top + currentScrollTop - anchor.contentTop;
    const desired = this.#scrollTop + originDelta;
    this.cancel();
    if (attached && Number.isFinite(desired) && Math.abs(currentScrollTop - desired) > 0.5) {
      owner.scrollTop = desired;
    }
  }

  cancel(): void {
    this.#epoch += 1;
    this.#clearMeasurement();
    this.#throttle.cancel();
    if (this.#owner !== undefined) this.#listen(this.#owner, false);
    this.#owner = undefined;
    this.#anchor = undefined;
    this.#view.plugin(zoomScrollPlugin)?.release(this);
  }

  #clearMeasurement(): void {
    this.#measured = false;
    if (this.#expiryFrame !== undefined) this.#scheduler.cancelFrame(this.#expiryFrame);
    this.#expiryFrame = undefined;
  }

  dispose(): void {
    this.cancel();
    this.#disposed = true;
  }

  readonly #cancelForInput = (): void => this.cancel();

  #listen(owner: BrowserScrollElement, attach: boolean): void {
    for (const event of ["wheel", "touchmove", "pointerdown"]) {
      if (attach)
        owner.addEventListener(event, this.#cancelForInput, { capture: true, passive: true });
      else owner.removeEventListener(event, this.#cancelForInput, true);
    }
    const document = owner.ownerDocument;
    const window = document.defaultView;
    if (attach) {
      document.addEventListener("keydown", this.#cancelForInput, true);
      window?.addEventListener("resize", this.#cancelForInput);
    } else {
      document.removeEventListener("keydown", this.#cancelForInput, true);
      window?.removeEventListener("resize", this.#cancelForInput);
    }
  }
}
