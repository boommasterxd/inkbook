import { measureInteractionSequence } from "../interaction-refresh-profile";
import { freshRenderingKernel } from "./rendering-fixture";
import { expect } from "vitest";
import { createEditorChromeProps } from "../../fixtures/editor-chrome";
import type { ComparisonScenario } from "./contracts";
import { readRootProbe, resetRootProbe } from "./react-root-probe";

export const RENDERING_CHROME_SCENARIOS: readonly ComparisonScenario[] = [
  {
    id: "rendering-semantic-chrome",
    statistics: [{ kind: "p99", population: "samples", minimumSamples: 100 }],
    modules: ["rendering/ui/mount-editor-chrome"],
    covers: [
      {
        file: "test/performance/rendering/ui/chrome-refresh-profile.test.ts",
        test: "skips semantically unchanged chrome renders during continuous input",
        ordinals: [1],
      },
    ],
    execution: "sequence",
    sequenceLength: 600,

    warmupOperations: 0,
    create(impl) {
      return freshRenderingKernel(() => {
        const { mountEditorChrome } = impl.get<
          typeof import("../../../src/rendering/ui/mount-editor-chrome")
        >("rendering/ui/mount-editor-chrome");
        const ownerDocument = {} as Document;
        const initial = createEditorChromeProps(ownerDocument);
        resetRootProbe();
        const mounted = mountEditorChrome({ ownerDocument } as HTMLElement, initial);
        expect(readRootProbe().renders).toBe(1);
        let samples: number[] = [];
        return {
          reset: resetRootProbe,
          *run() {
            samples = [];
            yield* measureInteractionSequence(
              () =>
                mounted.update({
                  ...initial,
                  shapeIcon: { ...initial.shapeIcon },
                  styleIcon: { ...initial.styleIcon },
                  toolbarState: { ...initial.toolbarState },
                }),
              600,
              samples,
            );
          },
          measurementSamples: () => samples,
          verify() {
            expect(readRootProbe()).toEqual({ renders: 0, unmounts: 0 });
          },
          dispose() {
            resetRootProbe();
            mounted.unmount();
            expect(readRootProbe().unmounts).toBe(1);
          },
        };
      });
    },
  },
];
