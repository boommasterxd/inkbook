const MAX_FRAMES = 7200;
const MAX_EVENTS = 256;
const MAX_DURATION_MS = 60_000;
const MAX_REPORT_CHARS = 1_900_000;
const EVENT_TYPES = [
  "pointerdown",
  "pointermove",
  "pointerup",
  "pointercancel",
  "gotpointercapture",
  "lostpointercapture",
  "contextmenu",
] as const;

type FinishReason = "released" | "cancelled" | "timeout" | "frame-limit";
interface PointerSample {
  readonly type: string;
  readonly time: number;
  readonly eventTime: number;
  readonly target: "surface" | "descendant" | "outside";
  readonly captured: boolean;
  readonly pointerId: number;
  readonly pointerType: string;
  readonly clientX: number;
  readonly clientY: number;
  readonly screenX: number;
  readonly screenY: number;
}
interface AnimationSample {
  readonly playState: AnimationPlayState;
  readonly currentTime: number | null;
  readonly properties: readonly string[];
}
interface FrameSample {
  readonly connected: boolean;
  readonly time: number;
  readonly top: number;
  readonly height: number;
  readonly translate: string;
  readonly inlineTranslate: string;
  readonly transform: string;
  readonly opacity: string;
  readonly scrollTop: number;
  readonly viewportTop: number;
  readonly viewportHeight: number;
  readonly swipeState: string;
  readonly presence: string;
  readonly pointer: PointerSample | undefined;
  readonly animations: readonly AnimationSample[] | undefined;
}
export interface PhoneSheetDiagnosticReport {
  readonly version: 1;
  readonly kind: string;
  readonly durationMs: number;
  readonly reason: FinishReason;
  readonly truncated: boolean;
  readonly events: readonly PointerSample[];
  readonly frames: readonly FrameSample[];
}
interface DiagnosticOptions {
  readonly claim: () => boolean;
  readonly complete: (report: PhoneSheetDiagnosticReport) => void;
}
interface Recording {
  readonly surface: HTMLElement;
  readonly scroll: HTMLElement | null;
  readonly start: number;
  readonly pointerId: number;
  readonly events: PointerSample[];
  readonly frames: FrameSample[];
  claimed: boolean;
  lastAnimationTime: number;
  pointer: PointerSample | undefined;
}

/** Records bounded geometry-only traces; never reads labels, values, or note content. */
export function installPhoneSheetDiagnostics(
  ownerDocument: Document,
  options: DiagnosticOptions,
): () => void {
  const ownerWindow = ownerDocument.defaultView;
  if (ownerWindow === null) return () => undefined;
  const recorder = new PhoneSheetDiagnostics(ownerDocument, ownerWindow, options);
  return () => recorder.dispose();
}

class PhoneSheetDiagnostics {
  readonly #document: Document;
  readonly #window: Window;
  readonly #options: DiagnosticOptions;
  #recording: Recording | undefined;
  #frame: number | undefined;
  #timeout: number | undefined;
  #terminal: number | undefined;

  public constructor(ownerDocument: Document, ownerWindow: Window, options: DiagnosticOptions) {
    this.#document = ownerDocument;
    this.#window = ownerWindow;
    this.#options = options;
    for (const type of EVENT_TYPES) ownerDocument.addEventListener(type, this.#event, true);
  }

  public dispose(): void {
    for (const type of EVENT_TYPES) this.#document.removeEventListener(type, this.#event, true);
    this.#clear();
  }

  #event = (event: Event): void => {
    if (event.type === "pointerdown" && this.#recording === undefined) this.#start(event);
    const recording = this.#recording;
    if (recording === undefined) return;
    const pointer = event as PointerEvent;
    if (event.type !== "contextmenu" && pointer.pointerId !== recording.pointerId) return;
    const sample = pointerSample(
      pointer,
      this.#window.performance.now() - recording.start,
      recording.surface,
    );
    if (event.type === "pointermove") recording.pointer = sample;
    else if (recording.events.length < MAX_EVENTS) recording.events.push(sample);
    if (event.type === "pointerup" || event.type === "pointercancel") {
      if (this.#terminal !== undefined) return;
      const reason = event.type === "pointerup" ? "released" : "cancelled";
      this.#terminal = this.#window.setTimeout(() => this.#finish(reason), 300);
    }
  };

  #start(event: Event): void {
    const target = event.target;
    if (target === null || !("closest" in target)) return;
    const surface = (target as Element).closest<HTMLElement>(".inkbook-adaptive-panel");
    if (surface?.closest('[data-platform="phone"]') === null || !surface) return;
    const pointer = event as PointerEvent;
    if (pointer.pointerType === "mouse") return;
    this.#recording = {
      surface,
      scroll: surface.querySelector(".inkbook-adaptive-panel-scroll"),
      start: this.#window.performance.now(),
      pointerId: pointer.pointerId,
      events: [],
      frames: [],
      claimed: false,
      lastAnimationTime: -250,
      pointer: undefined,
    };
    this.#timeout = this.#window.setTimeout(() => this.#finish("timeout"), MAX_DURATION_MS);
    this.#frame = this.#window.requestAnimationFrame(this.#sample);
  }

  #sample = (): void => {
    this.#frame = undefined;
    const recording = this.#recording;
    if (recording === undefined) return;
    const distance = (recording.pointer?.clientY ?? 0) - (recording.events[0]?.clientY ?? 0);
    if (
      !recording.claimed &&
      distance >= 6 &&
      recording.surface.dataset.swipeState === "dragging"
    ) {
      if (!this.#options.claim()) {
        this.#clear();
        return;
      }
      recording.claimed = true;
    }
    if (recording.claimed) this.#readFrame(recording);
    if (recording.frames.length >= MAX_FRAMES) {
      this.#finish("frame-limit");
      return;
    }
    this.#frame = this.#window.requestAnimationFrame(this.#sample);
  };

  #readFrame(recording: Recording): void {
    const time = this.#window.performance.now() - recording.start;
    const surface = recording.surface;
    const rect = surface.getBoundingClientRect();
    const style = this.#window.getComputedStyle(surface);
    const viewport = this.#window.visualViewport;
    const animations =
      time - recording.lastAnimationTime >= 250 ? sampleAnimations(surface) : undefined;
    if (animations !== undefined) recording.lastAnimationTime = time;
    recording.frames.push({
      time,
      connected: surface.isConnected,
      top: rect.top,
      height: rect.height,
      translate: style.translate.slice(0, 128),
      inlineTranslate: surface.style.translate.slice(0, 128),
      transform: style.transform.slice(0, 128),
      opacity: style.opacity.slice(0, 32),
      scrollTop: recording.scroll?.scrollTop ?? 0,
      viewportTop: viewport?.offsetTop ?? 0,
      viewportHeight: viewport?.height ?? this.#window.innerHeight,
      swipeState: knownState(surface.dataset.swipeState),
      presence: knownState(surface.dataset.presence),
      pointer: recording.pointer,
      animations,
    });
    recording.pointer = undefined;
  }

  #finish(reason: FinishReason): void {
    const recording = this.#recording;
    this.#clear();
    if (recording === undefined || !recording.claimed) return;
    const report: PhoneSheetDiagnosticReport = {
      version: 1,
      kind: knownKind(recording.surface.dataset.kind),
      durationMs: this.#window.performance.now() - recording.start,
      reason,
      truncated: reason === "frame-limit",
      events: recording.events,
      frames: recording.frames,
    };
    let bounded = report;
    while (JSON.stringify(bounded).length > MAX_REPORT_CHARS) {
      bounded = {
        ...bounded,
        truncated: true,
        frames: bounded.frames.filter((_, i) => i % 2 === 0),
      };
    }
    this.#options.complete(bounded);
  }

  #clear(): void {
    if (this.#frame !== undefined) this.#window.cancelAnimationFrame(this.#frame);
    if (this.#timeout !== undefined) this.#window.clearTimeout(this.#timeout);
    if (this.#terminal !== undefined) this.#window.clearTimeout(this.#terminal);
    this.#frame = undefined;
    this.#timeout = undefined;
    this.#terminal = undefined;
    this.#recording = undefined;
  }
}

function pointerSample(event: PointerEvent, time: number, surface: HTMLElement): PointerSample {
  return {
    eventTime: event.timeStamp,
    target:
      event.target === surface
        ? "surface"
        : event.target !== null &&
            "nodeType" in event.target &&
            surface.contains(event.target as Node)
          ? "descendant"
          : "outside",
    captured: surface.hasPointerCapture?.(event.pointerId) ?? false,
    type: event.type,
    time,
    pointerId: event.pointerId ?? 0,
    pointerType: ["touch", "pen", "mouse"].includes(event.pointerType)
      ? event.pointerType
      : "unknown",
    clientX: event.clientX ?? 0,
    clientY: event.clientY ?? 0,
    screenX: event.screenX ?? 0,
    screenY: event.screenY ?? 0,
  };
}

function sampleAnimations(surface: HTMLElement): readonly AnimationSample[] {
  return (surface.getAnimations?.() ?? []).slice(0, 8).map((animation) => ({
    playState: animation.playState,
    currentTime: typeof animation.currentTime === "number" ? animation.currentTime : null,
    properties:
      animation.effect && "getKeyframes" in animation.effect
        ? [
            ...new Set((animation.effect as KeyframeEffect).getKeyframes().flatMap(Object.keys)),
          ].slice(0, 16)
        : [],
  }));
}

function knownKind(value: string | undefined): string {
  return value !== undefined && ["style", "background", "dialog"].includes(value)
    ? value
    : "unknown";
}

function knownState(value: string | undefined): string {
  return value !== undefined && ["dragging", "settling", "entering", "exiting"].includes(value)
    ? value
    : "none";
}
