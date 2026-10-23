import type { Plugin } from "obsidian";
import { vi } from "vitest";

import { WorkspaceDocumentStatus } from "../../../src/obsidian/embeds/workspace/workspace-document-status";
import type { ObsidianWorkspaceRuntime } from "../../../src/obsidian/embeds/workspace/workspace-runtime";
import {
  registerDocumentStatusBar,
  resolveDocumentStatusPane,
} from "../../../src/obsidian/runtime/document-status-bar-binding";
import type { InkbookSettingsStore } from "../../../src/obsidian/settings/storage";
import type { MotionPreference } from "../../../src/rendering/motion/transitions";
import { createHtmlElement, installObsidianDomHelpers } from "../../adapters/obsidian/dom";
import { ManualFrameScheduler } from "./manual-frame-scheduler";
import { workSchedulerFromFrames } from "./work-scheduler";

export function documentStatusBarBindingFixture() {
  installObsidianDomHelpers();
  const item = createHtmlElement("div");
  const pane = createHtmlElement("div");
  const root = createHtmlElement("div");
  pane.append(root);
  document.body.append(item, pane);
  const frames = new ManualFrameScheduler();
  const scheduler = workSchedulerFromFrames(frames);
  const requestFrame = vi.spyOn(scheduler, "requestFrame");
  let selectedPane: HTMLElement | null = pane;
  let ready = (): void => undefined;
  let registeredRelease = (): void => undefined;
  let motion: MotionPreference = "system";
  let settingsListener = (_value: { motion: MotionPreference }): void => undefined;
  const unsubscribeSettings = vi.fn();
  const events = new Map<string, () => void>();
  const readPane = vi.fn(() => (selectedPane === null ? null : { containerEl: selectedPane }));
  const workScheduler = vi.fn(() => scheduler);
  const getLeaves = vi.fn(() => [{ view: { containerEl: pane } }]);
  const containment = vi.spyOn(pane, "contains");
  const plugin = {
    addStatusBarItem: () => item,
    app: {
      workspace: {
        getActiveViewOfType: readPane,
        getLeavesOfType: getLeaves,
        onLayoutReady: (callback: () => void) => {
          ready = callback;
        },
        on: (name: string, callback: () => void) => {
          events.set(name, callback);
          return {};
        },
      },
    },
    register: (callback: () => void) => {
      registeredRelease = callback;
    },
    registerEvent: vi.fn(),
  } as unknown as Plugin;
  const source = new WorkspaceDocumentStatus((root) =>
    resolveDocumentStatusPane(plugin.app.workspace, root),
  );
  source.bind(
    { attachmentGeneration: 1, attachmentId: "a", documentId: "drawing.svg", root },
    { getSaveStatus: () => "saved", subscribeSaveStatus: () => () => undefined },
  );
  const refresh = vi.spyOn(source, "setActivePane");
  const runtime = {
    documentStatus: source,
    getMotionPreference: () => motion,
    refreshRateProfiles: { workScheduler },
  } as unknown as ObsidianWorkspaceRuntime;
  const settings = {
    subscribeDeviceSettings: (listener: typeof settingsListener) => {
      settingsListener = listener;
      return unsubscribeSettings;
    },
  } as unknown as InkbookSettingsStore;
  const dispose = registerDocumentStatusBar(plugin, runtime, settings);
  return {
    item,
    pane,
    root,
    source,
    frames,
    scheduler,
    requestFrame,
    getLeaves,
    containment,
    refresh,
    readPane,
    workScheduler,
    unsubscribeSettings,
    dispose,
    ready: () => ready(),
    release: () => registeredRelease(),
    emit: (name = "active-leaf-change") => events.get(name)?.(),
    select: (next: HTMLElement | null) => {
      selectedPane = next;
    },
    setMotion: (next: MotionPreference) => {
      motion = next;
      settingsListener({ motion });
    },
    cleanup: () => {
      dispose();
      source.dispose();
      pane.remove();
    },
  };
}
