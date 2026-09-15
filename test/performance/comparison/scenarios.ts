import { validateComparisonStatistics } from "../../../scripts/performance-statistics.mjs";
import { validateComparisonIds } from "./paired-groups";
import type { ComparisonScenario, TimingCoverage } from "./contracts";
import { heightScenarios as EDITOR_HEIGHT_SCENARIOS } from "./editor-height";
import { largeSelectionScenarios as EDITOR_LARGE_SELECTION_SCENARIOS } from "./editor-large-selection";
import { DOMAIN_ARRANGE_SCENARIOS } from "./domain-arrange";
import { DOMAIN_GEOMETRY_SCENARIOS } from "./domain-geometry";
import { DOMAIN_HYDRATION_SCENARIOS } from "./domain-hydration";
import { DOMAIN_LIVE_STROKE_SCENARIOS } from "./domain-live-stroke";
import { DOMAIN_MUTATION_SCENARIOS } from "./domain-mutation";
import { DOMAIN_REPLACEMENT_SCENARIOS } from "./domain-replacement";
import { DOMAIN_SPATIAL_SCENARIOS } from "./domain-spatial";
import { DOMAIN_STORE_SCENARIOS } from "./domain-store";
import { EDITOR_ERASER_SCENARIOS } from "./editor-eraser";
import { EDITOR_GESTURE_SCENARIOS } from "./editor-gestures";
import { EDITOR_INPUT_SCENARIOS } from "./editor-input";
import { EDITOR_SELECTION_SCENARIOS } from "./editor-selection";
import { EDITOR_SNAPPING_SCENARIOS } from "./editor-snapping";
import { OBSIDIAN_EMBED_SCENARIOS } from "./obsidian-embeds";
import { OBSIDIAN_MENU_SCENARIOS } from "./obsidian-menus";
import { OBSIDIAN_NAVIGATION_SCENARIOS } from "./obsidian-navigation";
import { OBSIDIAN_PEN_TAP_SCENARIOS } from "./obsidian-pen-tap";
import { OBSIDIAN_RESIZE_SCENARIOS } from "./obsidian-resize";
import { OBSIDIAN_SETTINGS_SCENARIOS } from "./obsidian-settings";
import { PERSISTENCE_CLIPBOARD_SCENARIOS } from "./persistence-clipboard";
import { PERSISTENCE_EXPORT_SCENARIOS } from "./persistence-exports";
import { PERSISTENCE_FALLBACK_SCENARIOS } from "./persistence-fallback";
import { PERSISTENCE_SAVE_SCENARIOS } from "./persistence-save";
import { PERSISTENCE_TRANSFER_SCENARIOS } from "./persistence-transfer";
import { PERSISTENCE_VALIDATION_SCENARIOS } from "./persistence-validation";
import { RENDERING_BASIC_SCENARIOS } from "./rendering-basic";
import { RENDERING_CHROME_SCENARIOS } from "./rendering-chrome";
import { RENDERING_HANDOFF_SCENARIOS } from "./rendering-handoff";
import { RENDERING_LIVE_SCENARIOS } from "./rendering-live";
import { RENDERING_RECONCILIATION_SCENARIOS } from "./rendering-reconciliation";

export const COMPARISON_SCENARIOS: readonly ComparisonScenario[] = [
  ...EDITOR_HEIGHT_SCENARIOS,
  ...EDITOR_LARGE_SELECTION_SCENARIOS,
  ...DOMAIN_ARRANGE_SCENARIOS,
  ...DOMAIN_GEOMETRY_SCENARIOS,
  ...DOMAIN_HYDRATION_SCENARIOS,
  ...DOMAIN_LIVE_STROKE_SCENARIOS,
  ...DOMAIN_MUTATION_SCENARIOS,
  ...DOMAIN_REPLACEMENT_SCENARIOS,
  ...DOMAIN_SPATIAL_SCENARIOS,
  ...DOMAIN_STORE_SCENARIOS,
  ...EDITOR_ERASER_SCENARIOS,
  ...EDITOR_GESTURE_SCENARIOS,
  ...EDITOR_INPUT_SCENARIOS,
  ...EDITOR_SELECTION_SCENARIOS,
  ...EDITOR_SNAPPING_SCENARIOS,
  ...OBSIDIAN_EMBED_SCENARIOS,
  ...OBSIDIAN_MENU_SCENARIOS,
  ...OBSIDIAN_NAVIGATION_SCENARIOS,
  ...OBSIDIAN_PEN_TAP_SCENARIOS,
  ...OBSIDIAN_RESIZE_SCENARIOS,
  ...OBSIDIAN_SETTINGS_SCENARIOS,
  ...PERSISTENCE_CLIPBOARD_SCENARIOS,
  ...PERSISTENCE_EXPORT_SCENARIOS,
  ...PERSISTENCE_FALLBACK_SCENARIOS,
  ...PERSISTENCE_SAVE_SCENARIOS,
  ...PERSISTENCE_TRANSFER_SCENARIOS,
  ...PERSISTENCE_VALIDATION_SCENARIOS,
  ...RENDERING_BASIC_SCENARIOS,
  ...RENDERING_CHROME_SCENARIOS,
  ...RENDERING_HANDOFF_SCENARIOS,
  ...RENDERING_LIVE_SCENARIOS,
  ...RENDERING_RECONCILIATION_SCENARIOS,
];

export interface ComparisonTimingPhase {
  readonly file: string;
  readonly testName: string;
  readonly ordinal: number;
  readonly refreshRate: number;
}

function matches(coverage: TimingCoverage, record: ComparisonTimingPhase): boolean {
  return (
    coverage.file === record.file &&
    record.testName.includes(coverage.test) &&
    (coverage.ordinals === undefined || coverage.ordinals.includes(record.ordinal))
  );
}

function validateScenarioIdentities(scenarios: readonly ComparisonScenario[]): void {
  validateComparisonIds(scenarios);
  for (const scenario of scenarios) {
    validateComparisonStatistics(scenario.statistics);
    if (
      scenario.covers.length === 0 ||
      scenario.covers.some(
        (coverage) =>
          !coverage.file ||
          !coverage.test ||
          (coverage.ordinals !== undefined &&
            (coverage.ordinals.length === 0 ||
              coverage.ordinals.some((ordinal) => !Number.isSafeInteger(ordinal) || ordinal <= 0))),
      )
    ) {
      throw new Error(`Invalid comparison coverage: ${scenario.id}`);
    }
  }
}

/** Require both directions of coverage, permitting multiple kernels for one original phase. */
export function validateComparisonCoverage(
  scenarios: readonly ComparisonScenario[],
  records: readonly ComparisonTimingPhase[],
): void {
  validateScenarioIdentities(scenarios);
  if (records.length === 0 || scenarios.length === 0)
    throw new Error("Empty comparison coverage population.");
  for (const record of records) {
    if (
      !record.file ||
      !record.testName ||
      !Number.isSafeInteger(record.ordinal) ||
      record.ordinal <= 0 ||
      ![60, 90, 120, 144, 240].includes(record.refreshRate)
    )
      throw new Error("Invalid original timing phase.");
    if (
      !scenarios.some((scenario) => scenario.covers.some((coverage) => matches(coverage, record)))
    ) {
      throw new Error(`Uncovered original timing phase: ${JSON.stringify(record)}`);
    }
  }
  for (const scenario of scenarios) {
    if (!records.some((record) => scenario.covers.some((coverage) => matches(coverage, record)))) {
      throw new Error(`Comparison scenario matches no original timing phase: ${scenario.id}`);
    }
  }
}

/** Select every registered kernel for the measured files; never silently omit an unmatched kernel. */
export function selectComparisonScenarios(
  records: readonly ComparisonTimingPhase[],
  registry: readonly ComparisonScenario[] = COMPARISON_SCENARIOS,
): readonly ComparisonScenario[] {
  validateScenarioIdentities(registry);
  const files = new Set(records.map((record) => record.file));
  const selected = registry.filter((scenario) =>
    scenario.covers.some((coverage) => files.has(coverage.file)),
  );
  validateComparisonCoverage(selected, records);
  return selected;
}
