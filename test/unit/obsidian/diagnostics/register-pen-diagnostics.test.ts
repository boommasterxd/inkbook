import { Tasks } from "obsidian";
import { Notice } from "../../../adapters/obsidian/plugin";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { registerPenDiagnostics } from "../../../../src/obsidian/diagnostics/register-pen-diagnostics";
import { TestPlugin } from "../../../fixtures/obsidian/test-plugin";

const session = vi.hoisted(() => ({
  canStart: true,
  canStop: false,
  addWindow: vi.fn<(_window: Window) => () => void>(),
  dispose: vi.fn(),
  start: vi.fn(async () => undefined),
  stop: vi.fn(async (_reason?: string) => undefined),
}));
const construct = vi.hoisted(() => vi.fn());
vi.mock("../../../../src/obsidian/diagnostics/pen-diagnostic-session", () => ({
  PenDiagnosticSession: class {
    constructor(options: unknown) {
      construct(options);
      return session;
    }
  },
}));

function createHarness(
  ownerWindow: Window | null = {} as Window,
  leaves: Array<Window | null> = [],
) {
  const events = new Map<string, (...args: unknown[]) => void>();
  const detached = vi.fn();
  const vault = {};
  const plugin = new TestPlugin(
    {
      vault,
      workspace: {
        containerEl: { ownerDocument: { defaultView: ownerWindow } },
        iterateAllLeaves: (callback: (leaf: unknown) => void) => {
          for (const window of leaves)
            callback({ view: { containerEl: { ownerDocument: { defaultView: window } } } });
        },
        on: (name: string, callback: (...args: unknown[]) => void) => {
          events.set(name, callback);
          return { detach: detached };
        },
      },
    } as never,
    {} as never,
  );
  plugin.load();
  const commands = (
    plugin as unknown as {
      commands: Array<{ id: string; checkCallback: (checking: boolean) => boolean }>;
    }
  ).commands;
  return { plugin, ownerWindow, vault, commands, events, detached };
}

beforeEach(() => {
  vi.clearAllMocks();
  session.canStart = true;
  session.canStop = false;
  session.addWindow.mockImplementation(() => vi.fn());
});

describe("pen diagnostics registration", () => {
  it("gates start and stop commands without executing check-only calls", () => {
    const { plugin, commands, vault, ownerWindow } = createHarness();
    registerPenDiagnostics(plugin);
    const options = construct.mock.calls[0]![0] as { notify: (message: string) => void };
    expect(options).toMatchObject({
      vault,
      ownerWindow,
      pluginVersion: "0.0.0-test",
      obsidianVersion: "1.13.1",
    });
    options.notify("Recording started");
    expect(Notice.instances[Notice.instances.length - 1]?.message).toBe("Recording started");
    const start = commands.find((command) => command.id === "start-pen-diagnostics")!.checkCallback;
    const stop = commands.find((command) => command.id === "stop-pen-diagnostics")!.checkCallback;
    expect(start(true)).toBe(true);
    expect(stop(true)).toBe(false);
    expect(stop(false)).toBe(false);
    expect(session.start).not.toHaveBeenCalled();
    expect(session.stop).not.toHaveBeenCalled();
    expect(start(false)).toBe(true);
    expect(session.start).toHaveBeenCalledOnce();
    session.canStart = false;
    session.canStop = true;
    expect(start(false)).toBe(false);
    expect(stop(true)).toBe(true);
    expect(session.stop).not.toHaveBeenCalled();
    expect(stop(false)).toBe(true);
    expect(session.stop).toHaveBeenCalledOnce();
    plugin.unload();
  });

  it("deduplicates and bounds windows, releases closed windows, and drains on quit", async () => {
    const owner = {} as Window;
    const popout = {} as Window;
    const { plugin, events, detached } = createHarness(owner, [owner, popout, null]);
    const dispose = registerPenDiagnostics(plugin);
    expect(session.addWindow.mock.calls.map(([window]) => window)).toEqual([owner, popout]);
    const close = session.addWindow.mock.results[1]!.value as () => void;
    events.get("window-open")?.({}, popout);
    expect(session.addWindow).toHaveBeenCalledTimes(2);
    events.get("window-close")?.({}, popout);
    expect(close).toHaveBeenCalledOnce();
    events.get("window-close")?.({}, popout);
    expect(close).toHaveBeenCalledOnce();
    for (let index = 0; index < 9; index++) events.get("window-open")?.({}, {});
    expect(session.addWindow).toHaveBeenCalledTimes(9);
    const tasks = new Tasks();
    events.get("quit")?.(tasks);
    expect(session.stop).not.toHaveBeenCalled();
    await tasks.promise();
    expect(session.stop).toHaveBeenCalledWith("quit");
    dispose();
    expect(session.dispose).toHaveBeenCalledOnce();
    plugin.unload();
    expect(detached).toHaveBeenCalledTimes(3);
    expect(session.dispose).toHaveBeenCalledTimes(2);
  });

  it("does not register diagnostics without an owning window", () => {
    const { plugin, commands, events } = createHarness(null);
    registerPenDiagnostics(plugin)();
    expect(construct).not.toHaveBeenCalled();
    expect(commands).toEqual([]);
    expect(events.size).toBe(0);
    plugin.unload();
  });
});
