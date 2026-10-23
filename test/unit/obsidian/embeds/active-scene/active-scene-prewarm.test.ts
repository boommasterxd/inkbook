import { describe, expect, it, vi } from "vitest";

import { ActiveScenePrewarmBinding } from "../../../../../src/obsidian/embeds/active-scene/active-scene-prewarm";

function fixture(observed = true) {
  const ownerDocument = new EventTarget() as Document;
  const ownerWindow = new EventTarget();
  let hidden = false;
  let connected = true;
  let receive!: IntersectionObserverCallback;
  const observe = vi.fn();
  const disconnect = vi.fn();
  const observer = { observe, disconnect } as unknown as IntersectionObserver;
  const Observer = vi.fn(function (callback: IntersectionObserverCallback) {
    receive = callback;
    return observer;
  });
  if (observed) Object.assign(ownerWindow, { IntersectionObserver: Observer });
  Object.defineProperties(ownerDocument, {
    hidden: { get: () => hidden },
    defaultView: { value: ownerWindow },
  });
  const root = {
    ownerDocument,
    get isConnected() {
      return connected;
    },
  } as HTMLElement;
  const setEnabled = vi.fn();
  const binding = new ActiveScenePrewarmBinding(root, setEnabled);
  return {
    binding,
    ownerDocument,
    ownerWindow,
    root,
    observer,
    observe,
    disconnect,
    Observer,
    setEnabled,
    expectEnabled: (...states: readonly boolean[]) =>
      expect(setEnabled.mock.calls).toEqual(states.map((enabled) => [enabled])),
    receive: (entries: IntersectionObserverEntry[]) => receive(entries, observer),
    intersection: (visible: boolean, width = 100, height = 100) =>
      receive(
        [
          { target: root, isIntersecting: visible, intersectionRect: { width, height } },
        ] as unknown as IntersectionObserverEntry[],
        observer,
      ),
    hide: (value: boolean) => {
      hidden = value;
      ownerDocument.dispatchEvent(new Event("visibilitychange"));
    },
    detach: () => {
      connected = false;
    },
  };
}

describe("active scene speculative admission", () => {
  it("waits for the exact presentation intersection and ignores focus changes", () => {
    const h = fixture();
    expect(h.Observer).toHaveBeenCalledOnce();
    expect(h.observe).toHaveBeenCalledExactlyOnceWith(h.root);
    h.expectEnabled(false);
    h.receive([]);
    h.receive([{ target: {} }] as IntersectionObserverEntry[]);
    expect(h.setEnabled).toHaveBeenCalledOnce();
    h.intersection(true);
    h.ownerWindow.dispatchEvent(new Event("blur"));
    h.ownerWindow.dispatchEvent(new Event("focus"));
    h.expectEnabled(false, true);
    h.intersection(false);
    h.intersection(true, 0);
    h.intersection(true, 100, 0);
    h.expectEnabled(false, true, false);
    h.intersection(true);
    h.detach();
    h.intersection(false);
    h.expectEnabled(false, true, false, true, false);
    h.binding.dispose();
  });

  it("combines lock and owning-document visibility without reopening a hidden presentation", () => {
    const h = fixture();
    h.intersection(true);
    h.hide(true);
    h.binding.setEnabled(false);
    h.hide(false);
    h.expectEnabled(false, true, false);
    h.binding.setEnabled(true);
    h.intersection(false);
    h.binding.setEnabled(false);
    h.binding.setEnabled(true);
    h.expectEnabled(false, true, false, true, false);
    h.binding.dispose();
  });

  it("releases its one observer and listener and rejects late deliveries", () => {
    const h = fixture();
    const removeListener = vi.spyOn(h.ownerDocument, "removeEventListener");
    h.intersection(true);
    h.binding.dispose();
    h.binding.dispose();
    h.hide(true);
    h.hide(false);
    h.intersection(true);
    h.binding.setEnabled(true);
    h.expectEnabled(false, true, false);
    expect(h.disconnect).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledExactlyOnceWith(
      "visibilitychange",
      expect.any(Function),
    );
  });

  it("uses owning-document visibility when intersection observation is unavailable", () => {
    const h = fixture(false);
    expect(h.setEnabled).toHaveBeenCalledExactlyOnceWith(true);
    h.hide(true);
    h.hide(false);
    h.expectEnabled(true, false, true);
    expect(h.Observer).not.toHaveBeenCalled();
    h.binding.dispose();
  });
});
