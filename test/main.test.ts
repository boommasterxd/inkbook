// @vitest-environment happy-dom

import { Notice, type App, type PluginManifest } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";

import InkbookPlugin from "../src/main";

const REPEATED_LOAD_CYCLES = 3;

interface PluginRegistrations {
  readonly commands: readonly unknown[];
  readonly editorExtensions: readonly unknown[];
  readonly events: readonly unknown[];
  readonly postProcessors: readonly unknown[];
}

function createPlugin(): InkbookPlugin {
  return new InkbookPlugin({} as App, { id: "inkbook" } as PluginManifest);
}

function registrations(plugin: InkbookPlugin): PluginRegistrations {
  return plugin as unknown as PluginRegistrations;
}

function noticeMessages(): string[] {
  return (Notice as unknown as { readonly messages: string[] }).messages;
}

describe("InkbookPlugin production composition", () => {
  beforeEach(() => {
    noticeMessages().splice(0);
  });

  it("registers only one editor history bridge during bounded startup", async () => {
    const timeout = vi.spyOn(globalThis, "setTimeout");
    const plugin = createPlugin();

    await expect(plugin.onload()).resolves.toBeUndefined();
    await expect(plugin.onload()).resolves.toBeUndefined();

    expect(registrations(plugin)).toMatchObject({
      commands: [],
      events: [],
      postProcessors: [],
    });
    expect(registrations(plugin).editorExtensions).toHaveLength(1);
    expect(noticeMessages()).toEqual([]);
    expect(timeout).not.toHaveBeenCalled();
  });

  it("does not access background resources during load", async () => {
    const priorIndexedDb = Object.getOwnPropertyDescriptor(
      globalThis,
      "indexedDB",
    );
    const indexedDbAccess = vi.fn();
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      get: indexedDbAccess,
    });
    const appAccess = vi.fn();
    const plugin = new InkbookPlugin(
      new Proxy(
        {},
        {
          get: (_target, property): never => {
            appAccess(property);
            throw new Error("Startup accessed the Obsidian application.");
          },
        },
      ) as App,
      { id: "inkbook" } as PluginManifest,
    );

    try {
      await expect(plugin.onload()).resolves.toBeUndefined();
      expect(appAccess).not.toHaveBeenCalled();
      expect(indexedDbAccess).not.toHaveBeenCalled();
      expect(document.body.childElementCount).toBe(0);
    } finally {
      plugin.onunload();
      if (priorIndexedDb === undefined) {
        Reflect.deleteProperty(globalThis, "indexedDB");
      } else {
        Object.defineProperty(globalThis, "indexedDB", priorIndexedDb);
      }
    }
  });

  it("unloads idempotently and supports independent repeated load cycles", async () => {
    for (let cycle = 0; cycle < REPEATED_LOAD_CYCLES; cycle += 1) {
      const plugin = createPlugin();
      await plugin.onload();

      expect(registrations(plugin).editorExtensions).toHaveLength(1);
      expect(plugin.onunload()).toBeUndefined();
      expect(plugin.onunload()).toBeUndefined();
    }

    expect(noticeMessages()).toEqual([]);
  });
});
