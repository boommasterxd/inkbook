import { recordPenEvent, type PenDiagnosticRecord } from "./pen-event-record";

export type { PenDiagnosticRecord } from "./pen-event-record";
export const PEN_DIAGNOSTIC_MAX_EVENTS = 12_000;
const maxWindows = 8;
const eventTypes = [
  "pointerdown",
  "pointermove",
  "pointerrawupdate",
  "pointerup",
  "pointercancel",
  "pointerover",
  "pointerout",
  "pointerenter",
  "pointerleave",
  "gotpointercapture",
  "lostpointercapture",
  "mousedown",
  "mouseup",
  "mousemove",
  "contextmenu",
  "touchstart",
  "touchmove",
  "touchend",
  "touchcancel",
  "blur",
  "focus",
  "pagehide",
  "resize",
] as const;

interface CapturedWindow {
  readonly dispose: () => void;
  readonly now: () => number;
  readonly environment: () => PenDiagnosticRecord;
  startedAt: number;
}

/** Early passive capture observes host-consumed input without altering its delivery. */
export class PenEventCapture {
  private readonly windows = new Map<Window, CapturedWindow>();
  private records: PenDiagnosticRecord[] = [];
  private enabled = false;
  private disposed = false;
  private count = 0;
  private nextWindowId = 0;
  private startedAt = 0;

  constructor(private readonly options: { readonly onLimit: () => void }) {}

  get eventCount(): number {
    return this.count;
  }

  addWindow(window: Window): () => void {
    if (this.disposed || this.windows.has(window) || this.windows.size >= maxWindows) {
      return () => undefined;
    }
    const windowId = ++this.nextWindowId;
    const now = () => window.performance.now();
    const owner: CapturedWindow = {
      now,
      environment: () => ({
        type: "environment",
        windowId,
        relativeTimeMs: Math.max(0, now() - owner.startedAt),
        // Diagnostic provenance only, never used to choose platform behavior.
        userAgent: window.navigator.userAgent.slice(0, 512),
        maxTouchPoints: window.navigator.maxTouchPoints,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        visualViewportWidth: window.visualViewport?.width ?? 0,
        visualViewportHeight: window.visualViewport?.height ?? 0,
        pointerEvents: "PointerEvent" in window,
        pointerRawUpdate: "onpointerrawupdate" in window,
      }),
      startedAt: now() - (Date.now() - this.startedAt),
      dispose: () => {
        if (this.windows.get(window) !== owner) return;
        for (const type of eventTypes) window.removeEventListener(type, listener, true);
        window.document.removeEventListener("visibilitychange", listener, true);
        this.windows.delete(window);
      },
    };
    const listener = (event: Event) => {
      if (!this.enabled) return;
      this.append(recordPenEvent(event, windowId, Math.max(0, now() - owner.startedAt)));
      if (event.type === "resize" && this.enabled) this.append(owner.environment());
    };
    for (const type of eventTypes)
      window.addEventListener(type, listener, { capture: true, passive: true });
    window.document.addEventListener("visibilitychange", listener, {
      capture: true,
      passive: true,
    });
    this.windows.set(window, owner);
    if (this.enabled) this.append(owner.environment());
    return owner.dispose;
  }

  start(): void {
    if (this.disposed) return;
    this.records = [];
    this.count = 0;
    this.startedAt = Date.now();
    for (const owner of this.windows.values()) owner.startedAt = owner.now();
    this.enabled = true;
    for (const owner of this.windows.values()) this.append(owner.environment());
  }

  stop(): void {
    this.enabled = false;
  }

  drain(): readonly PenDiagnosticRecord[] {
    const result = this.records;
    this.records = [];
    return result;
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
    for (const owner of this.windows.values()) owner.dispose();
  }

  private append(record: PenDiagnosticRecord): void {
    this.records.push(record);
    this.count += 1;
    if (this.count === PEN_DIAGNOSTIC_MAX_EVENTS) {
      this.stop();
      this.options.onLimit();
    }
  }
}
