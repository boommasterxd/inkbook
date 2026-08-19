import type { EditorView, ViewUpdate } from "@codemirror/view";

import type {
  CompositionEventObservation,
  EditorInputProbeContract,
  EditorRange,
} from "../../../input/phase-zero";
import { EDITOR_INPUT_PROBE_LIMITS } from "../../../input/phase-zero";

const OVERSCAN_CODE_UNITS = 2_000;
const MAX_BUFFERED_COMPOSITION_EVENTS =
  EDITOR_INPUT_PROBE_LIMITS.maxCompositionEvents + 1;

export class CodeMirrorInputProbeBinding {
  readonly #compositionEvents: CompositionEventObservation[] = [];
  readonly #measureKey = {};
  readonly #view: EditorView;
  readonly #probe: EditorInputProbeContract;
  #selectionBefore: EditorRange | undefined;
  #compositionChanged = false;
  #beforeInputObserved = false;
  #inputObserved = false;
  #disposed = false;

  public constructor(view: EditorView, probe: EditorInputProbeContract) {
    this.#view = view;
    this.#probe = probe;
    this.#listen("selectstart", this.#onSelectStart);
    this.#listen("compositionstart", this.#onCompositionStart);
    this.#listen("compositionupdate", this.#onCompositionUpdate);
    this.#listen("compositionend", this.#onCompositionEnd);
    this.#listen("beforeinput", this.#onBeforeInput, true);
    this.#listen("input", this.#onInput, true);
    this.#scheduleViewportObservation();
  }

  public update(update: ViewUpdate): void {
    if (this.#disposed) return;
    if (update.selectionSet && this.#selectionBefore !== undefined) {
      this.#probe.observeNativeTextSelection({
        after: toRange(update.state.selection.main),
        before: this.#selectionBefore,
        claimedByPlugin: false,
        defaultPrevented: false,
      });
      this.#selectionBefore = undefined;
    }
    if (update.docChanged) {
      this.#compositionChanged ||= this.#compositionEvents.length > 0;
      if (this.#beforeInputObserved && this.#inputObserved) {
        this.#probe.observeSoftwareKeyboard({
          beforeInputObserved: true,
          claimedByPlugin: false,
          defaultPrevented: false,
          inputObserved: true,
          nativeInputApplied: true,
        });
        this.#beforeInputObserved = false;
        this.#inputObserved = false;
      }
    }
    if (update.viewportChanged || update.docChanged) {
      this.#scheduleViewportObservation();
    }
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unlisten("selectstart", this.#onSelectStart);
    this.#unlisten("compositionstart", this.#onCompositionStart);
    this.#unlisten("compositionupdate", this.#onCompositionUpdate);
    this.#unlisten("compositionend", this.#onCompositionEnd);
    this.#unlisten("beforeinput", this.#onBeforeInput, true);
    this.#unlisten("input", this.#onInput, true);
    this.#probe.dispose();
  }

  readonly #onSelectStart = (event: Event): void => {
    if (event.defaultPrevented || this.#disposed) return;
    this.#selectionBefore = toRange(this.#view.state.selection.main);
  };

  readonly #onCompositionStart = (event: Event): void => {
    this.#compositionEvents.length = 0;
    this.#compositionChanged = false;
    this.#recordComposition("start", event);
  };

  readonly #onCompositionUpdate = (event: Event): void => {
    this.#recordComposition("update", event);
  };

  readonly #onCompositionEnd = (event: Event): void => {
    this.#recordComposition("end", event);
    this.#probe.observeIme({
      events: [...this.#compositionEvents],
      nativeInputApplied: this.#compositionChanged,
    });
    this.#compositionEvents.length = 0;
    this.#compositionChanged = false;
  };

  readonly #onBeforeInput = (event: Event): void => {
    if (!event.defaultPrevented) this.#beforeInputObserved = true;
  };

  readonly #onInput = (event: Event): void => {
    if (!event.defaultPrevented) this.#inputObserved = true;
  };

  #recordComposition(
    phase: CompositionEventObservation["phase"],
    event: Event,
  ): void {
    if (this.#disposed) return;
    const observation: CompositionEventObservation = {
      claimedByPlugin: false,
      defaultPrevented: event.defaultPrevented,
      phase,
    };
    if (this.#compositionEvents.length < MAX_BUFFERED_COMPOSITION_EVENTS) {
      this.#compositionEvents.push(observation);
    } else if (phase === "end") {
      this.#compositionEvents[MAX_BUFFERED_COMPOSITION_EVENTS - 1] =
        observation;
    }
  }

  #scheduleViewportObservation(): void {
    this.#view.requestMeasure({
      key: this.#measureKey,
      read: (view): void => {
        if (this.#disposed) return;
        const visibleRanges = view.visibleRanges.map(toRange);
        this.#probe.observeCodeMirrorViewport({
          documentLength: view.state.doc.length,
          forcedOffscreenMount: false,
          mountedRanges: visibleRanges,
          overscanCodeUnits: OVERSCAN_CODE_UNITS,
          projectionRequestsInFrame: 1,
          queriedRanges: visibleRanges.map((range) => ({
            from: Math.max(0, range.from - OVERSCAN_CODE_UNITS),
            to: Math.min(view.state.doc.length, range.to + OVERSCAN_CODE_UNITS),
          })),
          visibleRanges,
        });
      },
    });
  }

  #listen(type: string, listener: EventListener, capture = false): void {
    this.#view.dom.addEventListener(type, listener, capture);
  }

  #unlisten(type: string, listener: EventListener, capture = false): void {
    this.#view.dom.removeEventListener(type, listener, capture);
  }
}

function toRange(range: {
  readonly from: number;
  readonly to: number;
}): EditorRange {
  return { from: range.from, to: range.to };
}
