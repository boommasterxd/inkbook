import { measureInteractionSequence } from "../interaction-refresh-profile";
import { renderAndDisposeActionMenu } from "../../fixtures/obsidian/owned-menu-operation";
import { createPhonePagePerformanceFixture } from "../../fixtures/obsidian/phone-sheet-page-performance";
import { expect } from "vitest";
import { Platform } from "obsidian";
import { installObsidianDomHelpers } from "../../adapters/obsidian/dom";
import type { ComparisonScenario } from "./contracts";
import { PHONE_MENU_SCENARIOS } from "./obsidian-menu-phone";

export const OBSIDIAN_MENU_SCENARIOS: readonly ComparisonScenario[] = [
  {
    id: "obsidian-owned-menu",
    modules: ["obsidian/menus/owned-menu-factory"],
    covers: [
      {
        file: "test/performance/obsidian/owned-menu-performance.test.ts",
        test: "renders and disposes a complete action menu",
        ordinals: [1],
      },
    ],
    statistics: [{ kind: "p99", population: "operations", minimumSamples: 600 }],
    execution: "sync",

    warmupOperations: 20,
    create(implementation) {
      const { createOwnedMenuFactory } = implementation.get<
        typeof import("../../../src/obsidian/menus/owned-menu-factory")
      >("obsidian/menus/owned-menu-factory");
      installObsidianDomHelpers();
      const anchor = window.createDiv();
      let scopes = 0;
      let disposed = 0;
      let oldPhone = false;
      let oldMobile = false;
      let active = false;
      let previousChildren: Element[] = [];
      const cleanup = () => {
        anchor.remove();
        if (active) {
          Platform.isPhone = oldPhone;
          Platform.isMobile = oldMobile;
          active = false;
        }
      };
      const factory = createOwnedMenuFactory({
        anchor,
        keymap: {
          pushScope: () => {
            scopes += 1;
          },
          popScope: () => {
            scopes -= 1;
          },
        },
      });
      return {
        reset() {
          previousChildren = Array.from(document.body.children);
          active = true;
          oldPhone = Platform.isPhone;
          oldMobile = Platform.isMobile;
          Platform.isPhone = false;
          Platform.isMobile = false;
          document.body.append(anchor);
          disposed = 0;
        },
        run() {
          renderAndDisposeActionMenu(factory, () => {
            disposed += 1;
          });
        },
        verify() {
          expect(disposed).toBe(1);
          expect(scopes).toBe(0);
          expect(Array.from(document.body.children)).toEqual([...previousChildren, anchor]);
          cleanup();
        },
        dispose: cleanup,
      };
    },
  },
  {
    id: "obsidian-phone-sheet-pages",
    modules: ["obsidian/menus/adaptive-panel-height", "obsidian/menus/phone-sheet-pages"],
    covers: [
      {
        file: "test/performance/obsidian/phone-sheet-pages-performance.test.ts",
        test: "swaps and restores a phone sheet page",
        ordinals: [1],
      },
    ],
    statistics: [{ kind: "p99", population: "samples", minimumSamples: 600 }],
    execution: "sequence",
    sequenceLength: 600,

    warmupOperations: 0,
    create(implementation) {
      const { AdaptivePanelHeight } = implementation.get<
        typeof import("../../../src/obsidian/menus/adaptive-panel-height")
      >("obsidian/menus/adaptive-panel-height");
      const { PhoneSheetPages } = implementation.get<
        typeof import("../../../src/obsidian/menus/phone-sheet-pages")
      >("obsidian/menus/phone-sheet-pages");
      installObsidianDomHelpers();
      let samples: number[] = [];
      const fixture = createPhonePagePerformanceFixture({
        height: AdaptivePanelHeight,
        pages: PhoneSheetPages,
      });
      return {
        reset() {
          document.body.append(fixture.layer);
          fixture.resetCounts();
          samples = [];
        },
        *run() {
          return yield* measureInteractionSequence(
            (frame) => {
              if (frame % 2 === 1) {
                fixture.back();
                return;
              }
              fixture.push();
            },
            600,
            samples,
          );
        },
        measurementSamples() {
          return samples;
        },
        verify() {
          expect(fixture.created).toBe(300);
          expect(fixture.disposed).toBe(300);
          expect(fixture.maximumNodes).toBeLessThanOrEqual(50);
          expect(fixture.scroll.children.length).toBe(1);
          expect(fixture.scroll.firstElementChild).toBe(fixture.rootContent);
          fixture.layer.remove();
        },
        dispose() {
          fixture.dispose();
        },
      };
    },
  },
  ...PHONE_MENU_SCENARIOS,
];
