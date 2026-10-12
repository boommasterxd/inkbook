import {
  OwnerWindowRegistry,
  resolveFallbackWindow,
} from "../../../src/obsidian/embeds/owner-window-registry";
import { WorkspaceRefreshProfiles } from "../../../src/obsidian/embeds/workspace-refresh-profiles";
import { createWorkspaceDocumentRuntimes } from "../../../src/obsidian/embeds/workspace-runtime-workers";
import { ManualHost } from "../scheduling/manual-frame-host";

export function observedSchedulingWindow() {
  const host = new ManualHost();
  host.frameInterval = 1_000 / 120;
  host.budget = host.frameInterval * 0.55;
  const accesses = { closed: 0, document: 0, performance: 0, now: 0, presentation: 0 };
  const events = new EventTarget();
  const ownerDocument = { defaultView: events, visibilityState: "visible" };
  const clock = {
    now: () => {
      accesses.now += 1;
      return host.time;
    },
  };
  const ownerWindow = Object.assign(events, {
    requestAnimationFrame: host.requestFrame,
    cancelAnimationFrame: host.cancelFrame,
    setTimeout: host.setTimer,
    clearTimeout: host.clearTimer,
  });
  Object.defineProperties(ownerWindow, {
    closed: {
      get: () => {
        accesses.closed += 1;
        return false;
      },
    },
    document: {
      get: () => {
        accesses.document += 1;
        return ownerDocument;
      },
    },
    performance: {
      get: () => {
        accesses.performance += 1;
        return clock;
      },
    },
  });
  const root = {
    get ownerDocument() {
      accesses.presentation += 1;
      return ownerDocument;
    },
  } as unknown as HTMLElement;
  return { accesses, host, ownerWindow: ownerWindow as unknown as Window, root };
}

export function windowBindingHarness() {
  const first = observedSchedulingWindow();
  const second = observedSchedulingWindow();
  const profiles = new WorkspaceRefreshProfiles(120);
  const registry = new OwnerWindowRegistry((owner) => profiles.isWindowAvailable(owner));
  const attachment = { documentId: "drawing.svg", root: first.root };
  const presentations = [{ attachment }];
  profiles.observeDefault(second.ownerWindow);
  registry.observe(attachment.documentId, first.ownerWindow);
  const fallback = () =>
    resolveFallbackWindow(attachment.documentId, presentations, registry, () => second.ownerWindow);
  const runtimes = createWorkspaceDocumentRuntimes({
    fallbackWindow: fallback,
    owningWindow: (id) => registry.require(id, presentations, fallback),
    ownerWindowVersion: () => profiles.ownerWindowVersion(),
    subscribeSchedulingProfile: (listener) => profiles.subscribe(listener),
    workScheduler: (owner) => profiles.workScheduler(owner),
  });
  return { first, second, profiles, registry, attachment, presentations, runtimes };
}
