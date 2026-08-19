import { describe, expect, it } from "vitest";

import type {
  Disposable,
  ReadingSectionReport,
} from "../../../../src/adapters/obsidian/views";
import { ReadingSectionCoordinator } from "../../../../src/adapters/obsidian/views";

const SECOND_GENERATION = 2;
const THIRD_GENERATION = 3;
const INVALID_GENERATION = -1;

function report(
  generation: number,
  sectionIdentity = "0:10",
  trustworthySourceEvidence = true,
): ReadingSectionReport {
  return {
    documentIdentity: "note.md",
    generation,
    previewInstanceIdentity: "preview-1",
    sectionIdentity,
    sourcePath: "note.md",
    trustworthySourceEvidence,
  };
}

function disposable(label: string, events: string[]): Disposable {
  let disposed = false;
  return {
    dispose: (): void => {
      if (disposed) {
        return;
      }
      disposed = true;
      events.push(`dispose:${label}`);
    },
  };
}

describe("ReadingSectionCoordinator", () => {
  it("owns one overlay and one child per distinct current section", () => {
    const events: string[] = [];
    const added: Disposable[] = [];
    const coordinator = new ReadingSectionCoordinator(
      disposable("overlay", events),
      {
        create: ({ sectionIdentity, generation }): Disposable =>
          disposable(`${sectionIdentity}:${String(generation)}`, events),
      },
    );
    const context = {
      addChild: (child: Disposable): void => {
        added.push(child);
      },
    };

    expect(coordinator.report(report(1, "0:10"), context)).toBe("accepted");
    expect(coordinator.report(report(1, "11:20"), context)).toBe("accepted");
    expect(added).toHaveLength(SECOND_GENERATION);

    coordinator.dispose();
    coordinator.dispose();
    expect(events).toEqual([
      "dispose:0:10:1",
      "dispose:11:20:1",
      "dispose:overlay",
    ]);
  });

  it("deduplicates retries and replaces only a newer generation", () => {
    const events: string[] = [];
    const added: Disposable[] = [];
    const coordinator = new ReadingSectionCoordinator(
      disposable("overlay", events),
      {
        create: ({ generation }): Disposable =>
          disposable(String(generation), events),
      },
    );
    const context = {
      addChild: (child: Disposable): void => {
        added.push(child);
      },
    };

    expect(coordinator.report(report(SECOND_GENERATION), context)).toBe(
      "accepted",
    );
    expect(coordinator.report(report(SECOND_GENERATION), context)).toBe(
      "duplicate",
    );
    expect(coordinator.report(report(1), context)).toBe("stale");
    expect(coordinator.report(report(THIRD_GENERATION), context)).toBe(
      "accepted",
    );

    expect(added).toHaveLength(SECOND_GENERATION);
    expect(events).toEqual(["dispose:2"]);
    coordinator.dispose();
    expect(events).toEqual(["dispose:2", "dispose:3", "dispose:overlay"]);
  });
});

describe("ReadingSectionCoordinator failure boundaries", () => {
  it("fails closed for missing evidence and malformed identities or generations", () => {
    const events: string[] = [];
    let createCount = 0;
    const coordinator = new ReadingSectionCoordinator(
      disposable("overlay", events),
      {
        create: (): Disposable => {
          createCount += 1;
          return disposable("section", events);
        },
      },
    );
    const context = { addChild: (): void => undefined };

    expect(coordinator.report(report(1, "0:10", false), context)).toBe(
      "untrusted",
    );
    expect(
      coordinator.report({ ...report(1), documentIdentity: "" }, context),
    ).toBe("invalid");
    expect(coordinator.report(report(INVALID_GENERATION), context)).toBe(
      "invalid",
    );
    expect(
      coordinator.report(report(Number.MAX_SAFE_INTEGER + 1), context),
    ).toBe("invalid");
    expect(createCount).toBe(0);
  });

  it("bounds retained sections and permits replacement at capacity", () => {
    const events: string[] = [];
    const coordinator = new ReadingSectionCoordinator(
      disposable("overlay", events),
      {
        create: ({ generation }): Disposable =>
          disposable(String(generation), events),
      },
      1,
    );
    const context = { addChild: (): void => undefined };

    expect(coordinator.report(report(1, "0:10"), context)).toBe("accepted");
    expect(coordinator.report(report(1, "11:20"), context)).toBe(
      "capacity-exceeded",
    );
    expect(coordinator.report(report(SECOND_GENERATION, "0:10"), context)).toBe(
      "accepted",
    );
    expect(
      () =>
        new ReadingSectionCoordinator(
          disposable("x", []),
          { create: (): Disposable => disposable("x", []) },
          0,
        ),
    ).toThrow(RangeError);
  });

  it("disposes a child when host ownership registration fails", () => {
    const events: string[] = [];
    const coordinator = new ReadingSectionCoordinator(
      disposable("overlay", events),
      { create: (): Disposable => disposable("section", events) },
    );

    expect(() =>
      coordinator.report(report(1), {
        addChild: (): void => {
          throw new Error("addChild failed");
        },
      }),
    ).toThrow("addChild failed");
    expect(events).toEqual(["dispose:section"]);
  });
});

describe("ReadingSectionCoordinator disposal failures", () => {
  it("rejects reports after disposal without constructing resources", () => {
    let createCount = 0;
    const coordinator = new ReadingSectionCoordinator(
      disposable("overlay", []),
      {
        create: (): Disposable => {
          createCount += 1;
          return disposable("section", []);
        },
      },
    );
    coordinator.dispose();

    expect(
      coordinator.report(report(1), { addChild: (): void => undefined }),
    ).toBe("disposed");
    expect(createCount).toBe(0);
  });

  it("releases all children and the overlay when one disposer fails", () => {
    const events: string[] = [];
    const coordinator = new ReadingSectionCoordinator(
      disposable("overlay", events),
      {
        create: ({ sectionIdentity }): Disposable =>
          sectionIdentity === "0:10"
            ? {
                dispose: (): void => {
                  throw new Error("section disposal failed");
                },
              }
            : disposable("second", events),
      },
    );
    const context = { addChild: (): void => undefined };
    coordinator.report(report(1, "0:10"), context);
    coordinator.report(report(1, "11:20"), context);

    expect(() => coordinator.dispose()).toThrow("section disposal failed");
    expect(events).toEqual(["dispose:second", "dispose:overlay"]);
    expect(() => coordinator.dispose()).not.toThrow();
  });
});
