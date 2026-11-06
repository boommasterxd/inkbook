// @vitest-environment happy-dom
import "../../../../fixtures/obsidian/menu-motion";

import { type App, Platform } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DeleteEmbedOutcome,
  ObsidianEmbedActions,
  OpenSvgOutcome,
} from "../../../../../src/obsidian/commands";
import type { PresentationAttachment } from "../../../../../src/obsidian/embeds/presentation/presentation-port";
import type { WorkspaceFeedbackHost } from "../../../../../src/obsidian/embeds/workspace/workspace-feedback-router";
import { bindWorkspaceLockedMenu } from "../../../../../src/obsidian/embeds/workspace/workspace-locked-menu";
import { createPhoneSheetHost } from "../../../../../src/obsidian/menus/panels/phone-sheet-host";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";
import { nativeModalStack, simulateNativeModalBack } from "../../../../adapters/obsidian/settings";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";
import { createLockedEmbedPreview } from "../../../../fixtures/obsidian/locked-embed-preview";

const disposables: Array<{ dispose(): void }> = [];

beforeEach(() => {
  installObsidianDomHelpers();
  vi.useFakeTimers();
  Platform.isMobile = false;
  Platform.isPhone = false;
});

afterEach(() => {
  for (const menu of disposables.splice(0)) menu.dispose();
  document.body.replaceChildren();
  Platform.isMobile = false;
  Platform.isPhone = false;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function harness(hostPorts: Pick<WorkspaceFeedbackHost, "keymap" | "createPhoneSheetHost"> = {}) {
  const { root, preview } = createLockedEmbedPreview(document);
  const removal = { begin: vi.fn(async () => true), reset: vi.fn() };
  const attachment: PresentationAttachment = {
    attachmentGeneration: 1,
    attachmentId: "invoking-embed",
    documentId: "drawing.svg",
    embedReference: {
      documentId: "drawing.svg",
      kind: "live-preview",
      sourcePath: "note.md",
      from: 0,
      to: 23,
    },
    preview,
    removal,
    root,
    scrollOwner: () => root,
  };
  const actions = {
    openSvg: vi.fn(async (): Promise<OpenSvgOutcome> => ({
      kind: "opened",
      path: attachment.documentId,
    })),
    deleteEmbed: vi.fn(async (): Promise<DeleteEmbedOutcome> => ({
      kind: "deleted",
      fileDeleted: false,
    })),
  };
  const activate = vi.fn();
  const showInPresentation = vi.fn();
  const mount = bindWorkspaceLockedMenu(
    { workScheduler: () => workSchedulerFromFrames(window) },
    actions as unknown as ObsidianEmbedActions,
    {
      fallbackOwnerWindow: () => window,
      manager: { showInPresentation },
      ...hostPorts,
    } as unknown as WorkspaceFeedbackHost,
  );
  const menu = mount(attachment, activate);
  if (menu !== undefined) disposables.push(menu);
  return { actions, activate, attachment, mount, preview, removal, root, showInPresentation };
}

function openMenu(preview: HTMLElement): void {
  preview.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
}

function clickAction(title: string): void {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (candidate) => candidate.textContent === title,
  );
  if (item === undefined) throw new Error(`Missing menu action: ${title}`);
  item.click();
}

describe("workspace locked menu action binding", () => {
  it("cancels the phone sheet with Back, then opens its SVG without activating the editor", async () => {
    Platform.isMobile = true;
    Platform.isPhone = true;
    const app = { workspace: { containerEl: document.body } } as App;
    const test = harness({
      keymap: { pushScope: vi.fn(), popScope: vi.fn() },
      createPhoneSheetHost: () => createPhoneSheetHost(app),
    });
    openMenu(test.preview);
    expect(nativeModalStack(document)).toHaveLength(1);
    vi.advanceTimersToNextFrame();

    simulateNativeModalBack(document);

    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(test.actions.openSvg).not.toHaveBeenCalled();
    expect(test.actions.deleteEmbed).not.toHaveBeenCalled();
    expect(test.activate).not.toHaveBeenCalled();
    openMenu(test.preview);
    clickAction("Open SVG file");
    await Promise.resolve();

    expect(test.actions.openSvg).toHaveBeenCalledExactlyOnceWith(test.attachment.embedReference);
    expect(nativeModalStack(document)).toHaveLength(0);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(test.activate).not.toHaveBeenCalled();
    expect(test.showInPresentation).not.toHaveBeenCalled();
  });

  it("activates only when Edit embed is chosen from the actual owned menu", () => {
    const test = harness();

    openMenu(test.preview);

    expect(test.activate).not.toHaveBeenCalled();
    expect(test.actions.openSvg).not.toHaveBeenCalled();
    expect(test.actions.deleteEmbed).not.toHaveBeenCalled();
    expect(test.root.dataset.inkbookState).toBe("locked");
    clickAction("Edit embed");
    expect(test.activate).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it("opens the invoking SVG without starting an editor session", async () => {
    const test = harness();
    openMenu(test.preview);

    clickAction("Open SVG file");
    await Promise.resolve();

    expect(test.actions.openSvg).toHaveBeenCalledExactlyOnceWith(test.attachment.embedReference);
    expect(test.activate).not.toHaveBeenCalled();
    expect(test.showInPresentation).not.toHaveBeenCalled();
  });

  it("deletes the locked invoking embed through its removal owner without a scene", async () => {
    const test = harness();
    openMenu(test.preview);

    clickAction("Delete embed");
    await Promise.resolve();

    expect(test.actions.deleteEmbed).toHaveBeenCalledExactlyOnceWith(
      test.attachment.embedReference,
      test.removal,
    );
    expect(test.activate).not.toHaveBeenCalled();
    expect(test.showInPresentation).not.toHaveBeenCalled();
  });

  it.each(["open", "delete"])("shows %s failure at the invoking presentation", async (action) => {
    const test = harness();
    test.actions.openSvg.mockResolvedValueOnce({ kind: "unavailable", reason: "embed-not-found" });
    test.actions.deleteEmbed.mockResolvedValueOnce({
      kind: "unavailable",
      reason: "metadata-unresolved",
    });
    openMenu(test.preview);

    clickAction(action === "open" ? "Open SVG file" : "Delete embed");
    await Promise.resolve();

    expect(test.showInPresentation).toHaveBeenCalledExactlyOnceWith(test.root, {
      code: action === "open" ? "embed-open-failed" : "embed-delete-references-unavailable",
    });
    expect(test.activate).not.toHaveBeenCalled();
  });

  it("does not mount a menu for an attachment without a locked preview", () => {
    const test = harness();
    const { preview: _preview, ...attachment } = test.attachment;

    expect(test.mount(attachment, test.activate)).toBeUndefined();
  });
});
