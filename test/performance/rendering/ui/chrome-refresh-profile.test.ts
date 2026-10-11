import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { ElementStore } from "../../../../src/domain/store/public";
import * as StyleSummary from "../../../../src/editor/tools/style-summary";
import { createActiveEditorChromeProps } from "../../../../src/obsidian/embeds/active-editor/controller-chrome";
import { ActiveEditorChromeState } from "../../../../src/obsidian/embeds/active-editor/controller-chrome-state";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import { ActiveEditorStyleSession } from "../../../../src/obsidian/embeds/active-editor/style-session";
import { mountEditorChrome } from "../../../../src/rendering/ui/mount-editor-chrome";
import { createEditorChromeProps } from "../../../fixtures/editor-chrome";
import { activeEditorStoreHistory } from "../../../fixtures/obsidian/active-editor";
import { immediateWorkScheduler } from "../../../fixtures/obsidian/immediate-work-scheduler";
import { createStandardRuntimeDomainFixture } from "../../domain/standard-domain-fixture";
import { INTERACTION_REFRESH_PROFILE } from "../../interaction-refresh-profile";

const reactRoot = vi.hoisted(() => ({ render: vi.fn(), unmount: vi.fn() }));

vi.mock("react-dom/client", () => ({ createRoot: vi.fn(() => reactRoot) }));

beforeEach(() => {
  vi.mocked(createRoot).mockClear();
  reactRoot.render.mockClear();
  reactRoot.unmount.mockClear();
});

describe(`${INTERACTION_REFRESH_PROFILE.refreshRate} Hz React chrome profile`, () => {
  it("skips semantically unchanged chrome renders during continuous input", () => {
    const ownerDocument = {} as Document;
    const initial = createEditorChromeProps(ownerDocument);
    const mounted = mountEditorChrome({ ownerDocument } as HTMLElement, initial);

    for (let update = 0; update < 12; update += 1) {
      mounted.update({
        ...initial,
        shapeIcon: { ...initial.shapeIcon },
        styleIcon: { ...initial.styleIcon },
        toolbarState: { ...initial.toolbarState },
      });
    }
    expect(createRoot).toHaveBeenCalledOnce();
    expect(reactRoot.render).toHaveBeenCalledOnce();
    mounted.unmount();
    expect(reactRoot.unmount).toHaveBeenCalledOnce();
  });

  it(
    "defers the 10K selected-style summary until controls are read after history updates",
    verifySelectedStyleCache,
  );
});

async function verifySelectedStyleCache(): Promise<void> {
  const source = createStandardRuntimeDomainFixture();
  const scheduler = immediateWorkScheduler();
  const builder = ElementStore.createBuilder({
    shouldYield: () => scheduler.shouldYield(),
    yieldControl: () => scheduler.checkpoint(undefined, "frame") ?? Promise.resolve(),
  });
  await builder.appendOwnedRuntime(source.elements.slice(0, source.strokeCount));
  const store = (await builder.finalize())!;
  const sceneStore = new ElementSceneStore(store);
  const history = activeEditorStoreHistory(store);
  let selection: ReadonlySet<string> = new Set(source.strokeIds);
  const styles = new ActiveEditorStyleSession({
    defaults: createBuiltInSettings().toolDefaults,
    history,
    onSelectionGeometryChanged: () => undefined,
    onStateChanged: () => undefined,
    sceneStore,
    selection: () => selection,
    selectionIdentity: () => selection,
    store,
  });
  const chromeState = new ActiveEditorChromeState(() => undefined);
  const initial = createEditorChromeProps({} as Document);
  const reads = vi.spyOn(store, "get");
  const summaries = vi.spyOn(StyleSummary, "summarizeSelectionStyle");
  const refresh = (canUndo: boolean, canRedo = false) =>
    createActiveEditorChromeProps(
      [chromeState, styles],
      [
        "select",
        false,
        initial.onToolbarAction,
        initial.ownerDocument,
        initial.renderIcon,
        { ...initial.toolbarState, activeTool: "select", hasSelection: true, canUndo, canRedo },
      ],
    );
  const mounted = mountEditorChrome(
    { ownerDocument: initial.ownerDocument } as HTMLElement,
    refresh(false),
  );
  const assertWork = (selectedCount: number) => {
    expect(reads).toHaveBeenCalledTimes(selectedCount);
    expect(summaries).toHaveBeenCalledOnce();
    expect(summaries.mock.calls[0]?.[0]).toHaveLength(selectedCount);
    reads.mockClear();
    summaries.mockClear();
  };
  expect(reads).not.toHaveBeenCalled();
  expect(summaries).not.toHaveBeenCalled();
  const retained = styles.presentation("select").controls;
  assertWork(10_000);
  for (const [canUndo, canRedo] of [
    [false, false],
    [true, false],
    [false, true],
  ] as const) {
    mounted.update(refresh(canUndo, canRedo));
    expect(styles.presentation("select").controls).toBe(retained);
  }
  expect(reads).not.toHaveBeenCalled();
  expect(summaries).not.toHaveBeenCalled();

  const previous = store.get(source.strokeIds[0]!)!.element as InkElementV1;
  if (previous.kind !== "stroke") throw new Error("Expected a stroke fixture.");
  expect(
    history.replace([previous], [{ ...previous, style: { ...previous.style, opacity: 0.5 } }]),
  ).toBe(true);
  for (const traverse of [() => undefined, () => history.undo(), () => history.redo()]) {
    traverse();
    reads.mockClear();
    summaries.mockClear();
    mounted.update(refresh(history.canUndo, history.canRedo));
    expect(reads).not.toHaveBeenCalled();
    expect(summaries).not.toHaveBeenCalled();
    expect(styles.presentation("select").controls).toHaveLength(3);
    assertWork(10_000);
    mounted.update(refresh(false));
    expect(reads).not.toHaveBeenCalled();
    expect(summaries).not.toHaveBeenCalled();
  }
  selection = new Set(source.strokeIds.slice(0, 1));
  styles.invalidateSelection();
  mounted.update(refresh(true));
  expect(reads).not.toHaveBeenCalled();
  expect(summaries).not.toHaveBeenCalled();
  expect(styles.presentation("select").controls).toHaveLength(3);
  assertWork(1);
  styles.dispose();
  mounted.unmount();
  history.dispose();
  sceneStore.release();
  reads.mockRestore();
  summaries.mockRestore();
}
