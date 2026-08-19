import { describe, expect, it } from "vitest";

import {
  EDITOR_INPUT_PROBE_LIMITS,
  EditorInputProbe,
} from "../../../src/input/phase-zero";

function recordPassingEvidence(probe: EditorInputProbe): void {
  probe.observeNativeTextSelection({
    claimedByPlugin: false,
    defaultPrevented: false,
    before: { from: 2, to: 2 },
    after: { from: 2, to: 8 },
  });
  probe.observeCodeMirrorViewport({
    documentLength: 1_000,
    visibleRanges: [{ from: 100, to: 200 }],
    queriedRanges: [{ from: 75, to: 225 }],
    mountedRanges: [{ from: 100, to: 200 }],
    overscanCodeUnits: 25,
    forcedOffscreenMount: false,
    projectionRequestsInFrame: 1,
  });
  probe.observeIme({
    events: [
      { phase: "start", claimedByPlugin: false, defaultPrevented: false },
      { phase: "update", claimedByPlugin: false, defaultPrevented: false },
      { phase: "end", claimedByPlugin: false, defaultPrevented: false },
    ],
    nativeInputApplied: true,
  });
  probe.observeSoftwareKeyboard({
    beforeInputObserved: true,
    inputObserved: true,
    claimedByPlugin: false,
    defaultPrevented: false,
    nativeInputApplied: true,
  });
}

// eslint-disable-next-line max-lines-per-function -- The four proof channels share one cohesive production contract suite.
describe("EditorInputProbe", () => {
  it("reports complete production-shaped native editor evidence", () => {
    const probe = new EditorInputProbe();
    recordPassingEvidence(probe);

    expect(probe.report()).toEqual({
      nativeTextSelectionPasses: true,
      codeMirrorVirtualizationPasses: true,
      imePasses: true,
      softwareKeyboardPasses: true,
      complete: true,
      disposed: false,
    });
  });

  it("rejects claimed or prevented native input", () => {
    const selection = new EditorInputProbe();
    expect(
      selection.observeNativeTextSelection({
        claimedByPlugin: true,
        defaultPrevented: false,
        before: { from: 0, to: 0 },
        after: { from: 0, to: 2 },
      }),
    ).toBe(false);

    const ime = new EditorInputProbe();
    expect(
      ime.observeIme({
        events: [
          { phase: "start", claimedByPlugin: false, defaultPrevented: false },
          { phase: "end", claimedByPlugin: false, defaultPrevented: true },
        ],
        nativeInputApplied: true,
      }),
    ).toBe(false);

    const keyboard = new EditorInputProbe();
    expect(
      keyboard.observeSoftwareKeyboard({
        beforeInputObserved: true,
        inputObserved: true,
        claimedByPlugin: false,
        defaultPrevented: true,
        nativeInputApplied: true,
      }),
    ).toBe(false);
  });

  it("enforces viewport overscan, mounting, range, and frame bounds", () => {
    const base = {
      documentLength: 1_000,
      visibleRanges: [{ from: 100, to: 200 }],
      queriedRanges: [{ from: 90, to: 210 }],
      mountedRanges: [{ from: 100, to: 200 }],
      overscanCodeUnits: 10,
      forcedOffscreenMount: false,
      projectionRequestsInFrame: 1,
    } as const;
    expect(new EditorInputProbe().observeCodeMirrorViewport(base)).toBe(true);
    expect(
      new EditorInputProbe().observeCodeMirrorViewport({
        ...base,
        queriedRanges: [{ from: 89, to: 210 }],
      }),
    ).toBe(false);
    expect(
      new EditorInputProbe().observeCodeMirrorViewport({
        ...base,
        forcedOffscreenMount: true,
      }),
    ).toBe(false);
    expect(
      new EditorInputProbe().observeCodeMirrorViewport({
        ...base,
        projectionRequestsInFrame: 2,
      }),
    ).toBe(false);
  });

  it("rejects malformed and abusive evidence within deterministic limits", () => {
    const probe = new EditorInputProbe();
    expect(
      probe.observeCodeMirrorViewport({
        documentLength: 10,
        visibleRanges: [{ from: 0, to: 10 }],
        queriedRanges: [],
        mountedRanges: [],
        overscanCodeUnits: EDITOR_INPUT_PROBE_LIMITS.maxOverscanCodeUnits + 1,
        forcedOffscreenMount: false,
        projectionRequestsInFrame: 0,
      }),
    ).toBe(false);
    expect(
      probe.observeIme({
        events: Array.from(
          { length: EDITOR_INPUT_PROBE_LIMITS.maxCompositionEvents + 1 },
          () => ({
            phase: "update" as const,
            claimedByPlugin: false,
            defaultPrevented: false,
          }),
        ),
        nativeInputApplied: true,
      }),
    ).toBe(false);
  });

  it("keeps a failed proof failed and makes disposal idempotent", () => {
    const probe = new EditorInputProbe();
    expect(
      probe.observeSoftwareKeyboard({
        beforeInputObserved: false,
        inputObserved: true,
        claimedByPlugin: false,
        defaultPrevented: false,
        nativeInputApplied: true,
      }),
    ).toBe(false);
    recordPassingEvidence(probe);
    expect(probe.report().softwareKeyboardPasses).toBe(false);

    probe.dispose();
    probe.dispose();
    expect(probe.report().disposed).toBe(true);
    expect(
      probe.observeNativeTextSelection({
        claimedByPlugin: false,
        defaultPrevented: false,
        before: { from: 0, to: 0 },
        after: { from: 0, to: 1 },
      }),
    ).toBe(false);
  });
});
