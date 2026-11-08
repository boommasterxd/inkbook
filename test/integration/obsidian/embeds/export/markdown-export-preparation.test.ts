// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import { createReadingViewPostProcessor } from "../../../../../src/obsidian/embeds/reading-view";
import { ExportGeometryCache } from "../../../../../src/obsidian/embeds/export/export-geometry-cache";
import type { WorkScheduler } from "../../../../../src/domain/scheduling/work-scheduler";
import * as staticSvg from "../../../../../src/obsidian/embeds/export/static-export-svg";
import * as geometryPreparation from "../../../../../src/persistence/export/export-geometry";
import * as fragmentPreparation from "../../../../../src/persistence/export/static-export-fragments";
import * as documentRuntime from "../../../../../src/persistence/worker/runtime/public";
import {
  createMarkdownExportFixture,
  validatedPreview,
} from "../../../../fixtures/obsidian/markdown-export";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

it.each(["worker", "graphic"] as const)(
  "starts both immutable-source consumers and waits for the other after %s preparation completes",
  async (first) => {
    const output = await overlappingPreparation();
    try {
      output.gates[first].resolve();
      await (first === "worker"
        ? output.geometry.mock.results[0]!.value
        : output.fused.mock.results[0]!.value);
      expect(output.fixture.root.querySelector("svg")).toBeNull();
      expect(output.prepared()!.svg.isConnected).toBe(false);
      expect(output.plain).not.toHaveBeenCalled();
      expect(output.cache.instrumentation.entries).toBe(0);
      output.gates[first === "worker" ? "graphic" : "worker"].resolve();
      await output.pending;
      expect(output.fused).toHaveBeenCalledOnce();
      expect(output.plain).not.toHaveBeenCalled();
      expect(output.fixture.root.querySelectorAll("svg[role='img']")).toHaveLength(1);
      expect(output.fixture.root.querySelector(".inkbook-export-definitions")).toBe(
        output.prepared()!.svg,
      );
      expect(output.prepared()!.svg.isConnected).toBe(true);
      expect(
        [...output.fixture.root.querySelectorAll("path")].map((path) => path.getAttribute("d")),
      ).toEqual(output.paths);
      expect(output.cache.instrumentation.entries).toBe(1);
    } finally {
      await output.dispose();
    }
  },
);

it("drops both overlapping preparations after renderer unload without late graphics or cached geometry", async () => {
  const output = await overlappingPreparation();
  const unhandled = vi.fn();
  window.addEventListener("unhandledrejection", unhandled);
  try {
    output.fixture.unload();
    expect(output.fused.mock.calls[0]?.[2].signal.aborted).toBe(true);
    output.gates.worker.resolve();
    output.gates.graphic.resolve();
    await expect(output.pending).resolves.toBeUndefined();
    expect(output.fixture.root.innerHTML).toBe(output.original);
    expect(output.fixture.root.querySelector("svg")).toBeNull();
    expect(output.prepared()!.svg.isConnected).toBe(false);
    expect(
      [...output.prepared()!.svg.querySelectorAll("path")].every((path) => !path.isConnected),
    ).toBe(true);
    expect(output.plain).not.toHaveBeenCalled();
    expect(output.cache.instrumentation).toEqual({ entries: 0, numericBytes: 0 });
    expect(unhandled).not.toHaveBeenCalled();
  } finally {
    window.removeEventListener("unhandledrejection", unhandled);
    await output.dispose();
  }
});

it("reuses warm numeric geometry with one fresh target-owned graphic and no fused parse or worker request", async () => {
  const output = await overlappingPreparation();
  const warm = createMarkdownExportFixture(
    "!inkbook[[drawing.svg]]",
    '<p>!inkbook<a href="drawing.svg">drawing.svg</a></p>',
    output.descriptor,
  );
  const target = document.implementation.createHTMLDocument("Warm export");
  target.body.append(target.adoptNode(warm.root));
  try {
    output.gates.worker.resolve();
    output.gates.graphic.resolve();
    await output.pending;
    const coldPaths = [...output.fixture.root.querySelectorAll("path")];
    output.fixture.unload();
    await createReadingViewPostProcessor({
      ...warm.ports,
      exportGeometryCache: output.cache,
      workScheduler: () => output.scheduler,
    })(warm.root, warm.context);
    expect(warm.recognize).toHaveBeenCalledOnce();
    expect(output.fused).toHaveBeenCalledOnce();
    expect(output.fragments).toHaveBeenCalledOnce();
    expect(output.worker).toHaveBeenCalledOnce();
    expect(output.plain).toHaveBeenCalledExactlyOnceWith(
      target,
      output.descriptor,
      expect.anything(),
    );
    const paths = [...warm.root.querySelectorAll("path")];
    expect(paths.map((path) => path.getAttribute("d"))).toEqual(output.paths);
    for (const [index, path] of paths.entries()) {
      expect(path.ownerDocument).toBe(target);
      expect(path).not.toBe(coldPaths[index]);
      expect(path.isConnected).toBe(true);
    }
    warm.unload();
    expect(warm.root.querySelector("svg")).toBeNull();
    expect(paths.every((path) => !path.isConnected)).toBe(true);
  } finally {
    warm.unload();
    await output.dispose();
  }
});

it("preserves a damaged canonical host block when fused preparation rejects instead of mounting a generic fallback", async () => {
  const descriptor = await validatedPreview();
  const safeSvg = descriptor.safeSvg.replace('id="inkbook-content"', 'id="unexpected"');
  expect(safeSvg).not.toBe(descriptor.safeSvg);
  expect(safeSvg).toContain('data-inkbook-format="inkbook"');
  const fixture = createMarkdownExportFixture(
    "!inkbook[[drawing.svg]]",
    '<p>!inkbook<a href="drawing.svg">drawing.svg</a></p>',
    { ...descriptor, safeSvg },
  );
  const original = [...fixture.root.childNodes];
  const cache = new ExportGeometryCache();
  const fused = vi.spyOn(staticSvg, "createPreparedStaticExportSvg");
  const plain = vi.spyOn(staticSvg, "createStaticExportSvg");
  try {
    await createReadingViewPostProcessor({ ...fixture.ports, exportGeometryCache: cache })(
      fixture.root,
      fixture.context,
    );
    expect(fused).toHaveBeenCalledOnce();
    await expect(fused.mock.results[0]!.value).resolves.toBeUndefined();
    expect(plain).not.toHaveBeenCalled();
    expect([...fixture.root.childNodes]).toEqual(original);
    expect(fixture.root.querySelector("a")?.getAttribute("href")).toBe("drawing.svg");
    expect(fixture.root.querySelector("svg, [data-inkbook-export]")).toBeNull();
    expect(cache.instrumentation).toEqual({ entries: 0, numericBytes: 0 });
  } finally {
    fixture.unload();
    cache.dispose();
  }
});

async function overlappingPreparation() {
  const descriptor = await validatedPreview();
  const fixture = createMarkdownExportFixture(
    "!inkbook[[drawing.svg]]",
    '<p>!inkbook<a href="drawing.svg">drawing.svg</a></p>',
    descriptor,
  );
  document.body.append(fixture.root);
  const original = fixture.root.innerHTML;
  const saved = new DOMParser().parseFromString(descriptor.safeSvg, "image/svg+xml");
  const paths = [...saved.querySelectorAll("path")].map((path) => path.getAttribute("d"));
  const gates = { worker: preparationGate(), graphic: preparationGate() };
  const scheduler = immediateWorkScheduler();
  const worker = controlWorkerResponse(gates.worker, scheduler);
  const graphic = controlGraphicResult(gates.graphic);
  const fragments = vi.spyOn(fragmentPreparation, "prepareStaticExportFragments");
  const geometry = vi.spyOn(geometryPreparation, "prepareExportGeometry");
  const plain = vi.spyOn(staticSvg, "createStaticExportSvg");
  const cache = new ExportGeometryCache();
  const pending = Promise.resolve(
    createReadingViewPostProcessor({
      ...fixture.ports,
      exportGeometryCache: cache,
      workScheduler: () => scheduler,
    })(fixture.root, fixture.context),
  );
  const dispose = async () => {
    fixture.unload();
    gates.worker.resolve();
    gates.graphic.resolve();
    await pending;
    cache.dispose();
  };
  try {
    await vi.waitFor(() => {
      expect(worker).toHaveBeenCalledOnce();
      expect(graphic.fused).toHaveBeenCalledOnce();
      expect(graphic.prepared()).toBeDefined();
    });
    expect(graphic.fused.mock.calls[0]?.[1]).toBe(descriptor);
    expect(graphic.fused.mock.calls[0]?.[2].workScheduler).toBe(scheduler);
    expect(geometry.mock.calls[0]?.[1].workScheduler).toBe(scheduler);
    expect(geometry.mock.calls[0]?.[1].signal).toBe(graphic.fused.mock.calls[0]?.[2].signal);
    expect(plain).not.toHaveBeenCalled();
    expect(graphic.prepared()!.svg.isConnected).toBe(false);
    expect(
      [...graphic.prepared()!.svg.querySelectorAll("path")].map((path) => path.getAttribute("d")),
    ).toEqual(paths);
    return {
      fixture,
      descriptor,
      scheduler,
      original,
      paths,
      gates,
      fragments,
      geometry,
      plain,
      worker,
      ...graphic,
      cache,
      pending,
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

function controlWorkerResponse(gate: ReturnType<typeof preparationGate>, scheduler: WorkScheduler) {
  const worker = vi.fn<documentRuntime.DocumentWorkerRuntime["execute"]>();
  vi.spyOn(documentRuntime, "createDocumentRuntime").mockImplementation(
    async (sessionId, workerEpoch) => {
      const runtime = new documentRuntime.DocumentWorkerRuntime(
        { sessionId, workerEpoch },
        new documentRuntime.GestureAwareSliceScheduler({
          isInputActive: () => false,
          workScheduler: scheduler,
        }),
      );
      const execute = runtime.execute.bind(runtime);
      worker.mockImplementation(async (request) => {
        const result = await execute(request);
        await gate.promise;
        return result;
      });
      vi.spyOn(runtime, "execute").mockImplementation(worker);
      return runtime;
    },
  );
  return worker;
}

function controlGraphicResult(gate: ReturnType<typeof preparationGate>) {
  let prepared: staticSvg.PreparedStaticExportSvg | undefined;
  const prepare = staticSvg.createPreparedStaticExportSvg;
  const fused = vi
    .spyOn(staticSvg, "createPreparedStaticExportSvg")
    .mockImplementation(async (...args) => {
      const result = await prepare(...args);
      prepared = result;
      await gate.promise;
      return result;
    });
  return { fused, prepared: () => prepared };
}

function preparationGate() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
