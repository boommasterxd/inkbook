import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { mountEditorChrome } from "../../../../src/rendering/ui/mount-editor-chrome";
import { createEditorChromeProps } from "../../../fixtures/editor-chrome";
import { INTERACTION_REFRESH_PROFILE } from "../../interaction-refresh-profile";
import { DocumentSaveStatusSource } from "../../../../src/obsidian/embeds/document-save-status";
import { AutosaveCoordinator } from "../../../../src/persistence/saving/autosave/public";
import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import {
  AutosaveDocumentFixture,
  FakeClock,
  MemoryVault,
  serializeSnapshot,
} from "../../../integration/persistence/saving/fixtures";

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

  it("bounds save-status renders across 10,000 commits and preserves the inactivity debounce", () => {
    const ownerDocument = {} as Document;
    const initial = createEditorChromeProps(ownerDocument);
    const status = new DocumentSaveStatusSource();
    const mounted = mountEditorChrome({ ownerDocument } as HTMLElement, {
      ...initial,
      toolbarState: { ...initial.toolbarState, saveStatus: status.current() },
    });
    const unsubscribe = status.subscribe(() =>
      mounted.update({
        ...initial,
        toolbarState: { ...initial.toolbarState, saveStatus: status.current() },
      }),
    );
    const documentSource = new AutosaveDocumentFixture();
    const clock = new FakeClock();
    const serialized = serializeSnapshot();
    const execute = vi.fn(() => new Promise<never>(() => undefined));
    const coordinator = new AutosaveCoordinator({
      clock,
      confirmedBase: { outputHash: serialized.hash, revision: 0, type: "confirmed" },
      documentSource,
      executor: { execute, terminate: vi.fn() },
      initialSnapshot: documentSource.snapshot(),
      observer: {
        statusChanged: (value) => status.update({ dirty: coordinator.dirty, status: value }),
      },
      path: "drawing.svg",
      sessionId: "session-a",
      vault: new MemoryVault(serialized.svg),
      workScheduler: createTestWorkScheduler(),
    });
    for (let revision = 1; revision <= 10_000; revision += 1) {
      documentSource.commit(revision, 100);
      coordinator.recordCommit({ modelRevision: revision });
    }
    expect(reactRoot.render).toHaveBeenCalledTimes(2);
    clock.advance(999);
    expect(execute).not.toHaveBeenCalled();
    clock.advance(1);
    expect(execute).toHaveBeenCalledOnce();
    expect(reactRoot.render).toHaveBeenCalledTimes(3);
    unsubscribe();
    status.dispose();
    coordinator.dispose();
    expect(reactRoot.render).toHaveBeenCalledTimes(3);
    mounted.unmount();
    expect(reactRoot.unmount).toHaveBeenCalledOnce();
  });
});
