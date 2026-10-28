import { afterEach } from "vitest";

import { Keymap } from "../../adapters/obsidian/keymap";

/** Own each test's native capture listeners independently of settings DOM cleanup. */
export function keymapCaptureFixture(): (ownerWindow: Window) => Keymap {
  const releases: Array<() => void> = [];
  afterEach(() => {
    for (const release of releases.splice(0)) release();
  });
  return (ownerWindow) => {
    const keymap = new Keymap();
    releases.push(keymap.installCapture(ownerWindow));
    return keymap;
  };
}
