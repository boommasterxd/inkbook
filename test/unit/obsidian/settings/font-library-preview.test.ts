// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createEnglishLocalization } from "../../../../src/domain/localization";
import type { FontResourceV2 } from "../../../../src/domain/schema/public";
import type { VaultFontLibrary } from "../../../../src/obsidian/fonts/vault-font-library";
import { FontLibraryPreview } from "../../../../src/obsidian/settings/fonts/font-library-preview";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { TestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import {
  installFontPreviewHost,
  previewFontResource,
} from "../../../fixtures/obsidian/native-font-preview";

const transitions = vi.hoisted(() => [] as { finish(): void }[]);
vi.mock("../../../../src/obsidian/settings/settings-panel-motion", () => ({
  SettingsPanelMotion: class {
    #collapsed: (() => void) | undefined;
    public constructor(private readonly panel: HTMLElement) {
      transitions.push({ finish: () => this.#finish() });
    }
    public setExpanded(expanded: boolean, collapsed?: () => void): void {
      this.panel.inert = !expanded;
      this.#collapsed = expanded ? undefined : collapsed;
      if (expanded) this.panel.hidden = false;
      else if (this.panel.hidden) this.#finish();
    }
    #finish(): void {
      this.panel.hidden = true;
      const collapsed = this.#collapsed;
      this.#collapsed = undefined;
      collapsed?.();
    }
    public dispose(): void {
      this.#collapsed = undefined;
    }
  },
}));

let resources: readonly FontResourceV2[];
beforeAll(async () => {
  resources = await Promise.all([
    previewFontResource(),
    previewFontResource("inter", 700),
    previewFontResource("inter", 400, "italic"),
  ]);
});
beforeEach(() => {
  installObsidianDomHelpers();
  transitions.length = 0;
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function fixture() {
  const host = installFontPreviewHost(document);
  const read = vi.fn(async (face: { id: string }, _signal?: AbortSignal) => {
    expect(host.retained.size).toBe(0);
    return resources.find((resource) => resource.id === face.id)!;
  });
  const error = vi.fn();
  const preview = new FontLibraryPreview(
    {
      localization: createEnglishLocalization(),
      library: { resource: read } as unknown as VaultFontLibrary,
      scheduler: new TestWorkScheduler(),
      changed: () => undefined,
      confirmRemove: async () => true,
      readMotion: () => "full",
    },
    error,
  );
  const rows = resources.map((resource, index) => {
    const row = document.body.createDiv();
    const button = row.createEl("button", { attr: { "aria-label": `Preview font ${index}` } });
    button.setAttribute("aria-expanded", "false");
    const face = {
      ...resource,
      displayName: `Font ${index}`,
      path: `Inkbook Fonts/${resource.id}.woff2`,
    };
    return { row, button, toggle: () => preview.toggle(face, row, button) };
  });
  return {
    host,
    read,
    error,
    preview,
    rows,
    expectReads: (...indices: number[]) => {
      expect(read.mock.calls.map(([face]) => face.id)).toEqual(
        indices.map((index) => resources[index]!.id),
      );
    },
    ready: async (index: number) => {
      const row = rows[index]!;
      await vi.waitFor(() => expect(row.row.querySelector("p")?.hidden).toBe(false));
      const panel = row.row.querySelector<HTMLElement>("[aria-busy]")!;
      expect(panel.getAttribute("aria-busy")).toBe("false");
      expect(panel.getAttribute("role")).toBe("region");
      expect(panel.getAttribute("aria-label")).toBe(`Preview Font ${index}`);
      expect(panel.hidden).toBe(false);
      expect(row.button.getAttribute("aria-controls")).toBe(panel.id);
      expect(row.button.getAttribute("aria-expanded")).toBe("true");
    },
    cleanup: () => {
      preview.dispose();
      expect(host.retained.size).toBe(0);
      host.restore();
    },
  };
}

async function holdNativeLoad(view: ReturnType<typeof fixture>): Promise<() => void> {
  let release!: () => void;
  view.host.defer(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  view.rows[0]!.toggle();
  await vi.waitFor(() => expect(view.host.loading()).toBe(1));
  return release;
}

it("retains the outgoing font through collapse and admits only the latest requested row", async () => {
  const view = fixture();
  try {
    view.rows[0]!.toggle();
    await view.ready(0);
    const retained = [...view.host.retained][0];
    view.rows[1]!.toggle();
    view.rows[2]!.toggle();
    expect(view.host.retained).toEqual(new Set([retained]));
    expect(view.read).toHaveBeenCalledOnce();
    expect(view.rows[0]!.button.getAttribute("aria-expanded")).toBe("false");
    expect(view.rows[1]!.button.getAttribute("aria-expanded")).toBe("false");
    expect(view.rows[2]!.button.getAttribute("aria-expanded")).toBe("true");
    transitions[0]!.finish();
    await view.ready(2);
    view.expectReads(0, 2);
    expect(view.host.retained.size).toBe(1);
    expect(view.host.retained.has(retained)).toBe(false);
    expect(view.rows[0]!.row.querySelector("p")).toBeNull();
    expect(view.rows[0]!.button.hasAttribute("aria-controls")).toBe(false);
    expect(view.rows[1]!.row.querySelector("p")).toBeNull();
  } finally {
    view.cleanup();
  }
});

it("cancels a pending resource read without allowing its late result to replace the next preview", async () => {
  const view = fixture();
  let release!: (resource: FontResourceV2) => void;
  view.read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  try {
    view.rows[0]!.toggle();
    const signal = view.read.mock.calls[0]![1]!;
    view.rows[1]!.toggle();
    expect(signal.aborted).toBe(true);
    expect(view.read).toHaveBeenCalledOnce();
    release(resources[0]!);
    await view.ready(1);
    expect(view.rows[0]!.row.querySelector("p")).toBeNull();
    expect(view.rows[0]!.button.getAttribute("aria-expanded")).toBe("false");
    expect(view.host.created).toHaveLength(1);
    expect(view.host.retained.size).toBe(1);
    expect(view.error).not.toHaveBeenCalled();
  } finally {
    view.cleanup();
  }
});

it.each(["collapse", "clear"])(
  "serializes native admissions through %s and admits only the latest queued target",
  async (retirement) => {
    const view = fixture();
    const release = await holdNativeLoad(view);
    try {
      if (retirement === "clear") view.preview.clear();
      view.rows[1]!.toggle();
      view.rows[2]!.toggle();
      expect(view.read).toHaveBeenCalledOnce();
      expect(view.host.created).toHaveLength(1);
      expect(view.host.retained.size).toBe(0);
      expect(view.rows[0]!.row.querySelector("p")).toBeNull();
      release();
      await view.ready(2);
      view.expectReads(0, 2);
      expect(view.host.maximumLoading()).toBe(1);
      expect(view.host.created).toHaveLength(2);
      expect(view.host.retained.size).toBe(1);
      expect(view.rows[1]!.row.querySelector("p")).toBeNull();
    } finally {
      release();
      view.cleanup();
    }
  },
);

it("disposes a pending native load without retaining or publishing its late face", async () => {
  const view = fixture();
  const release = await holdNativeLoad(view);
  try {
    view.preview.dispose();
    release();
    await vi.waitFor(() => expect(view.host.loading()).toBe(0));
    expect(view.host.retained.size).toBe(0);
    expect(view.rows[0]!.row.querySelector("p")).toBeNull();
    expect(view.rows[0]!.button.hasAttribute("aria-controls")).toBe(false);
    expect(view.rows[0]!.button.getAttribute("aria-expanded")).toBe("false");
    expect(view.error).not.toHaveBeenCalled();
    view.rows[1]!.toggle();
    expect(view.read).toHaveBeenCalledOnce();
  } finally {
    release();
    view.cleanup();
  }
});

it("resets the disclosure after a failed load, reports the error and permits retry", async () => {
  const view = fixture();
  view.read.mockRejectedValueOnce(new Error("Font file unavailable"));
  try {
    view.rows[0]!.toggle();
    await vi.waitFor(() => expect(view.error).toHaveBeenCalledOnce());
    expect(view.rows[0]!.button.getAttribute("aria-expanded")).toBe("false");
    expect(view.rows[0]!.button.hasAttribute("aria-controls")).toBe(false);
    expect(view.rows[0]!.row.querySelector("p")).toBeNull();
    expect(view.host.retained.size).toBe(0);
    view.rows[0]!.toggle();
    await view.ready(0);
    expect(view.read).toHaveBeenCalledTimes(2);
    expect(view.host.retained.size).toBe(1);
  } finally {
    view.cleanup();
  }
});
