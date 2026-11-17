// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  loadMathJax: vi.fn(async () => {}),
  renderMath: vi.fn<(source: string, display: boolean) => HTMLElement>(),
  finishRenderMath: vi.fn(async () => {}),
}));
vi.mock("obsidian", () => host);

import { PortableMathModuleLoader } from "../../../../src/obsidian/text/portable-math-loader";
import type { WorkScheduler } from "../../../../src/domain/scheduling/work-scheduler";
import { ObsidianTextMathRenderer } from "../../../../src/obsidian/text/math-renderer";
import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";

vi.mock("../../../../src/obsidian/text/portable-math-source", () => ({
  PORTABLE_MATH_GZIP:
    "<Ah!!!!!9-SOx5;6=n}85SXsqn,*>3h^H>}Exb9V{|jvA7Y:d=.UqU,ZbU-W<0z#{mr4#O5Q(g)*!!!!",
}));

import { createEmbeddedModuleWindow } from "../../../fixtures/obsidian/embedded-module-window";
import { createPortableMathLoader } from "../../../fixtures/obsidian/portable-math-loader";

function createRenderer() {
  return new ObsidianTextMathRenderer(createTestWorkScheduler(), createPortableMathLoader());
}

describe("public Obsidian math adaptation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    host.renderMath.mockImplementation(() => document.createElement("mjx-container"));
  });

  it("reflows a cold width-bound equation and reverses width without unused public host work", async () => {
    const renderer = createRenderer();
    try {
      const initial = await renderer.resolve("x+1", false, 24, undefined, 120);
      const narrow = await renderer.resolve("x+1", false, 24, undefined, 20);
      const reversed = await renderer.resolve("x+1", false, 24, undefined, 120);
      expect(initial.paths).toHaveLength(3);
      expect(initial.width).toBeGreaterThan(50);
      expect(narrow.width).toBeLessThanOrEqual(20);
      expect(narrow.paths.length).toBeGreaterThan(0);
      expect(reversed).toBe(initial);
      expect(host.loadMathJax).not.toHaveBeenCalled();
      expect(host.renderMath).not.toHaveBeenCalled();
      expect(host.finishRenderMath).not.toHaveBeenCalled();
    } finally {
      renderer.dispose();
    }
  });

  it("detects native CHTML once and reuses the canonical offline SVG engine", async () => {
    const renderer = createRenderer();
    try {
      const initial = await renderer.resolve("x+1", false, 24);
      const repeated = await renderer.resolve("x+1", false, 24);
      expect(repeated).toBe(initial);
      expect(initial.paths.length).toBeGreaterThan(0);
      expect(host.loadMathJax).toHaveBeenCalledTimes(1);
      expect(host.renderMath).toHaveBeenCalledWith("x+1", false);
      expect(host.finishRenderMath).toHaveBeenCalledTimes(1);
    } finally {
      renderer.dispose();
    }
  });

  it("normalizes public SVG references, transforms and rectangles without retaining DOM or markup", async () => {
    host.renderMath.mockImplementation(() => {
      const node = document.createElement("span");
      const svg = new DOMParser().parseFromString(
        '<svg viewBox="0 -1000 2000 1500"><defs><path id="glyph" d="M0 0h1000v1000z"/></defs><g transform="scale(1 -1)"><use href="#glyph" x="200"/><rect x="0" y="-200" width="2000" height="50"/></g></svg>',
        "image/svg+xml",
      );
      node.append(document.importNode(svg.documentElement, true));
      return node;
    });
    const renderer = createRenderer();
    try {
      await renderer.resolve("x", true, 20, undefined, 120);
      expect(host.renderMath).not.toHaveBeenCalled();
      const result = await renderer.resolve("x", true, 20);
      expect(result).toMatchObject({ width: 40, height: 30, ascent: 20, descent: 10 });
      expect(result.paths).toEqual([
        { d: "M4 20 L24 20 L24 0 Z" },
        { d: "M0 24 L40 24 L40 23 L0 23 Z" },
      ]);
      await renderer.resolve("x", true, 20, undefined, undefined, { bold: true });
      expect(host.renderMath).toHaveBeenLastCalledWith("\\boldsymbol{x\n}", true);
      await renderer.resolve("x", true, 20, undefined, undefined, { bold: false });
      expect(host.renderMath).toHaveBeenLastCalledWith("x", true);
    } finally {
      renderer.dispose();
    }
  });

  it("falls back to a complete portable equation when native inline SVG is fragmented", async () => {
    host.renderMath.mockImplementation(() => {
      const node = document.createElement("span");
      for (let index = 0; index < 2; index += 1)
        node.append(document.createElementNS("http://www.w3.org/2000/svg", "svg"));
      return node;
    });
    const renderer = createRenderer();
    try {
      const value = await renderer.resolve("x+1", false, 24);
      expect(value.paths).toHaveLength(3);
      expect(value.width).toBeGreaterThan(50);
      expect(await renderer.resolve("x+1", false, 24)).toBe(value);
      expect(host.renderMath).toHaveBeenCalledOnce();
    } finally {
      renderer.dispose();
    }
  });

  it("rejects a stale formula before invoking native rendering", async () => {
    const aborted = new AbortController();
    aborted.abort(new Error("obsolete revision"));
    const renderer = createRenderer();
    await expect(renderer.resolve("x", false, 24, aborted.signal)).rejects.toThrow(
      "obsolete revision",
    );
    expect(host.renderMath).not.toHaveBeenCalled();
    renderer.dispose();
    await expect(renderer.resolve("x", false, 24)).rejects.toThrow("disposed");
  });
});

function moduleFixture() {
  const engines: { resolve: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }[] = [];
  const createPortableMathRenderer = vi.fn((_scheduler: WorkScheduler) => {
    const engine = {
      resolve: vi.fn(async () => ({ width: 1, height: 1, ascent: 1, descent: 0, paths: [] })),
      dispose: vi.fn(),
    };
    engines.push(engine);
    return engine;
  });
  return { module: { createPortableMathRenderer }, engines, factory: createPortableMathRenderer };
}

function deferredModule() {
  let resolve = (_value: unknown): void => undefined;
  const promise = new Promise<unknown>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function recoverableImportFixture(name: string) {
  const owner = createEmbeddedModuleWindow(name);
  const ready = moduleFixture();
  const pending = deferredModule();
  const importer = vi
    .fn()
    .mockImplementationOnce(() => pending.promise)
    .mockResolvedValue(ready.module);
  const loader = new PortableMathModuleLoader(importer, owner.window);
  const renderer = new ObsidianTextMathRenderer(createTestWorkScheduler(), loader);
  return { owner, ready, pending, importer, loader, renderer };
}

describe("on-demand offline math ownership", () => {
  it("does no engine decode or evaluation for an unused renderer or native SVG", async () => {
    const owner = createEmbeddedModuleWindow("native");
    const importer = vi.fn();
    const renderer = new ObsidianTextMathRenderer(
      createTestWorkScheduler(),
      new PortableMathModuleLoader(importer, owner.window),
    );
    expect(owner.blobs).toHaveLength(0);
    host.renderMath.mockImplementation(() => {
      const node = document.createElement("span");
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 10 10");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M0 0L1 1");
      svg.append(path);
      node.append(svg);
      return node;
    });
    await renderer.resolve("x", false, 24);
    renderer.dispose();
    expect(importer).not.toHaveBeenCalled();
    expect(owner.blobs).toHaveLength(0);
  });

  it("shares one import realm across main and popout sessions with separate engines and schedulers", async () => {
    const owner = createEmbeddedModuleWindow("import-realm");
    const pending = deferredModule();
    const ready = moduleFixture();
    const importer = vi.fn((_url: string, _window: unknown) => pending.promise);
    const loader = new PortableMathModuleLoader(importer, owner.window);
    const mainScheduler = createTestWorkScheduler();
    const popoutScheduler = createTestWorkScheduler();
    const main = new ObsidianTextMathRenderer(mainScheduler, loader);
    const popout = new ObsidianTextMathRenderer(popoutScheduler, loader);
    const stale = new AbortController();
    const prepared = main.prepare(stale.signal);
    const active = popout.resolve("x", false, 24, undefined, 100);
    await vi.waitFor(() => expect(importer).toHaveBeenCalledOnce());
    stale.abort(new Error("obsolete source"));
    await expect(prepared).resolves.toBe(false);
    expect(owner.revoked).toHaveLength(0);
    expect(ready.factory).not.toHaveBeenCalled();
    pending.resolve(ready.module);
    await active;
    await main.resolve("x", false, 24, undefined, 100);
    expect(ready.factory.mock.calls.map((call) => call[0])).toEqual([
      popoutScheduler,
      mainScheduler,
    ]);
    expect(ready.engines).toHaveLength(2);
    expect(ready.engines[0]).not.toBe(ready.engines[1]);
    main.dispose();
    popout.dispose();
    expect(ready.engines.every((engine) => engine.dispose.mock.calls.length === 1)).toBe(true);
    const reopened = new ObsidianTextMathRenderer(mainScheduler, loader);
    await expect(reopened.prepare()).resolves.toBe(true);
    expect(ready.factory).toHaveBeenCalledTimes(2);
    await reopened.resolve("x", false, 24, undefined, 100);
    expect(importer).toHaveBeenCalledExactlyOnceWith("blob:import-realm", owner.window);
    expect(ready.factory).toHaveBeenCalledTimes(3);
    expect(owner.blobs).toHaveLength(1);
    expect(owner.revoked).toEqual(["blob:import-realm"]);
    reopened.dispose();
    expect(ready.engines.every((engine) => engine.dispose.mock.calls.length === 1)).toBe(true);
  });
});

describe("on-demand offline math recovery", () => {
  it("retries rejected and malformed modules without caching a failed load", async () => {
    const owner = createEmbeddedModuleWindow("retry");
    const ready = moduleFixture();
    const importer = vi
      .fn()
      .mockRejectedValueOnce(new Error("blocked module"))
      .mockResolvedValueOnce({ createPortableMathRenderer: 1 })
      .mockResolvedValue(ready.module);
    const renderer = new ObsidianTextMathRenderer(
      createTestWorkScheduler(),
      new PortableMathModuleLoader(importer, owner.window),
    );
    await expect(renderer.prepare()).resolves.toBe(false);
    await expect(renderer.resolve("x", false, 24, undefined, 100)).rejects.toThrow(
      "module is invalid",
    );
    await renderer.resolve("x", false, 24, undefined, 100);
    expect(importer).toHaveBeenCalledTimes(3);
    expect(owner.revoked).toHaveLength(3);
    expect(ready.factory).toHaveBeenCalledOnce();
    renderer.dispose();
  });

  it("releases the last pending consumer on dispose and ignores its late engine", async () => {
    const {
      owner,
      ready,
      pending: deferred,
      importer,
      loader,
      renderer,
    } = recoverableImportFixture("disposed");
    const active = renderer.resolve("x", false, 24, undefined, 100);
    await vi.waitFor(() => expect(importer).toHaveBeenCalledOnce());
    renderer.dispose();
    await expect(active).rejects.toThrow("disposed");
    expect(owner.revoked).toEqual(["blob:disposed"]);
    deferred.resolve(ready.module);
    await expect(renderer.prepare()).resolves.toBe(false);
    expect(ready.factory).not.toHaveBeenCalled();
    const next = new ObsidianTextMathRenderer(createTestWorkScheduler(), loader);
    await next.resolve("x", false, 24, undefined, 100);
    expect(importer).toHaveBeenCalledTimes(2);
    next.dispose();
  });

  it("bounds a hung import in the fixed realm and permits retry after URL cleanup", async () => {
    const { owner, ready, pending, importer, renderer } = recoverableImportFixture("timeout");
    const active = renderer.resolve("x", false, 24, undefined, 100);
    await vi.waitFor(() => expect(importer).toHaveBeenCalledOnce());
    owner.runTimers();
    await expect(active).rejects.toThrow("timed out");
    expect(owner.revoked).toEqual(["blob:timeout"]);
    pending.resolve(ready.module);
    expect(ready.factory).not.toHaveBeenCalled();
    await renderer.resolve("x", false, 24, undefined, 100);
    expect(importer).toHaveBeenCalledTimes(2);
    expect(ready.factory).toHaveBeenCalledOnce();
    expect(owner.revoked).toHaveLength(2);
    renderer.dispose();
  });

  it("rejects an unsupported import realm and pre-aborted source without decoding", async () => {
    const owner = createEmbeddedModuleWindow("aborted");
    const importer = vi.fn();
    const loader = new PortableMathModuleLoader(importer, owner.window);
    const renderer = new ObsidianTextMathRenderer(createTestWorkScheduler(), loader);
    const abort = new AbortController();
    abort.abort(new Error("obsolete source"));
    await expect(renderer.prepare(abort.signal)).resolves.toBe(false);
    expect(owner.blobs).toHaveLength(0);
    vi.stubGlobal("window", undefined);
    const unsupportedRealm = new PortableMathModuleLoader(importer);
    vi.unstubAllGlobals();
    const invalid = new ObsidianTextMathRenderer(createTestWorkScheduler(), unsupportedRealm);
    await expect(invalid.resolve("x", false, 24, undefined, 100)).rejects.toThrow(
      "embedded module APIs",
    );
    expect(importer).not.toHaveBeenCalled();
    renderer.dispose();
    invalid.dispose();
  });
});
