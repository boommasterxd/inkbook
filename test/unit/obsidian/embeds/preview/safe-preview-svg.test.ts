// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";

import { FILE_SCHEMA_LIMITS } from "../../../../../src/domain/schema/public";
import { serializeInkbookDocument } from "../../../../../src/persistence/serialization/public";
import {
  inspectPreviewSvg,
  loadValidatedPreviewSvg,
} from "../../../../../src/obsidian/embeds/preview/safe-preview-svg";
import { createPreviewSvgAsync } from "../../../../../src/obsidian/embeds/preview/safe-preview-builder";
import { createSnapshot } from "../../../persistence/serialization/fixtures";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { SafeStaticProof } from "../../../../../src/persistence/serialization/input/safe-static-proof";

const workScheduler = immediateWorkScheduler();

interface PreviewResponse {
  readonly arrayBuffer: ReturnType<typeof vi.fn>;
  readonly headers: { get(name: string): string | null };
  readonly ok: boolean;
}

function response(
  body: ArrayBuffer,
  options: { readonly contentLength?: string; readonly ok?: boolean } = {},
): PreviewResponse {
  return {
    arrayBuffer: vi.fn(async () => body),
    headers: {
      get: (name) => (name === "content-length" ? (options.contentLength ?? null) : null),
    },
    ok: options.ok ?? true,
  };
}

interface LoaderWindow {
  readonly window: Window;
  readonly fetchMock: ReturnType<typeof vi.fn>;
}

function loaderWindow(previewResponse: PreviewResponse): LoaderWindow {
  const fetchMock = vi.fn(async () => previewResponse);
  return {
    window: { fetch: fetchMock } as unknown as Window,
    fetchMock,
  };
}

describe("safe locked-preview SVG validation", () => {
  it("mounts only presentation paths after complete safe-envelope validation", async () => {
    const serialized = serializeInkbookDocument(createSnapshot());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;

    const safeSvg =
      (await inspectPreviewSvg(serialized.value.svg, { workScheduler }))?.safeSvg ?? null;
    expect(safeSvg).toBe(serialized.value.svg);
    if (safeSvg === null) return;
    const preview = await createPreviewSvgAsync(document, safeSvg, {
      checkpoint: async () => {},
      isCancelled: () => false,
      workScheduler: immediateWorkScheduler(),
    });
    if (preview === undefined) throw new Error("Preview was unexpectedly cancelled.");

    expect(preview.classList.contains("inkbook-locked-preview-svg")).toBe(true);
    expect(preview.getAttribute("preserveAspectRatio")).toBe("xMidYMin meet");
    expect(preview.querySelector("metadata")).toBeNull();
    expect(preview.querySelector("style")).toBeNull();
    expect(preview.querySelectorAll("path").length).toBeGreaterThan(0);
  });

  it("rejects executable or unknown markup before DOM parsing", async () => {
    const serialized = serializeInkbookDocument(createSnapshot());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const unsafe = serialized.value.svg.replace(
      '<g id="inkbook-content">',
      '<script>bad()</script><g id="inkbook-content">',
    );

    await expect(inspectPreviewSvg(unsafe, { workScheduler })).resolves.toBeNull();
  });
});

describe("safe locked-preview SVG source loading", () => {
  it("rejects an unavailable source before reading its body", async () => {
    const body = response(new ArrayBuffer(0), { ok: false });
    const loaded = loaderWindow(body);

    await expect(
      loadValidatedPreviewSvg("app://vault/missing.svg", loaded.window, { workScheduler }),
    ).rejects.toThrow("could not be loaded");
    expect(loaded.fetchMock).toHaveBeenCalledWith("app://vault/missing.svg", undefined);
    expect(body.arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects a declared body that exceeds the schema limit before reading it", async () => {
    const body = response(new ArrayBuffer(0), {
      contentLength: String(FILE_SCHEMA_LIMITS.totalInputBytes + 1),
    });

    await expect(
      loadValidatedPreviewSvg("app://vault/large.svg", loaderWindow(body).window, {
        workScheduler,
      }),
    ).rejects.toThrow("exceeds the file limit");
    expect(body.arrayBuffer).not.toHaveBeenCalled();
  });

  it("rejects an actual body that exceeds the schema limit", async () => {
    const body = response(new ArrayBuffer(FILE_SCHEMA_LIMITS.totalInputBytes + 1));

    await expect(
      loadValidatedPreviewSvg("app://vault/large.svg", loaderWindow(body).window, {
        workScheduler,
      }),
    ).rejects.toThrow("exceeds the file limit");
    expect(body.arrayBuffer).toHaveBeenCalledOnce();
  });

  it("fails closed when a loaded source is not a validated Inkbook SVG", async () => {
    const body = response(new TextEncoder().encode("<svg></svg>").buffer);

    await expect(
      loadValidatedPreviewSvg("app://vault/unsafe.svg", loaderWindow(body).window, {
        workScheduler,
      }),
    ).rejects.toThrow("not safe SVG");
  });

  it("returns a loaded source after complete safe-envelope validation", async () => {
    const serialized = serializeInkbookDocument(createSnapshot());
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const body = response(new TextEncoder().encode(serialized.value.svg).buffer);

    const preview = await loadValidatedPreviewSvg(
      "app://vault/safe.svg",
      loaderWindow(body).window,
      { workScheduler },
    );
    expect(preview).toMatchObject({
      aspectRatio: 2_048.6 / serialized.value.lockedHeight,
      contentIdentity: {
        outputHash: serialized.value.hash,
        revision: serialized.value.snapshot.revision,
      },
      safeSvg: serialized.value.svg,
    });
    expect(preview.safeStaticProof).toBeInstanceOf(SafeStaticProof);
    expect(body.arrayBuffer).toHaveBeenCalledOnce();
  });
});
