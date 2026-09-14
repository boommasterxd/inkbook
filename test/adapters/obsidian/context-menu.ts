import { vi } from "vitest";

import type { ContextMenuHandlers } from "../../../src/obsidian/menus/context-menu";

export function createContextMenuHandlers(): ContextMenuHandlers {
  return {
    copy: vi.fn(),
    cut: vi.fn(),
    delete: vi.fn(),
    bringForward: vi.fn(),
    sendBackward: vi.fn(),
    bringToFront: vi.fn(),
    sendToBack: vi.fn(),
    paste: vi.fn(),
    copyEmbed: vi.fn(),
    eraseAll: vi.fn(),
    deleteEmbed: vi.fn(),
  };
}
