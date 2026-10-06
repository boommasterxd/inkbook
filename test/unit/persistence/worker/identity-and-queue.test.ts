import { describe, expect, it } from "vitest";

import { WorkerJobQueue } from "../../../../src/persistence/worker/job-queue";
import type { WorkerJob, WorkerJobKind } from "../../../../src/persistence/worker/protocol";

const job = (id: string, kind: WorkerJobKind): WorkerJob<string> => ({ id, kind, payload: id });

describe("bounded non-preemptive worker queue", () => {
  it("retains one suspended job within required capacity until foreground completion", () => {
    const queue = new WorkerJobQueue<string>({ requiredCapacity: 2 });
    queue.admit(job("speculative", "required"));
    queue.startNext();
    queue.suspendActive();
    expect(queue.pendingCount).toBe(1);
    expect(queue.admit(job("speculative", "required"))).toBe("duplicate");
    expect(queue.admit(job("required", "required"))).toBe("accepted");
    expect(queue.admit(job("overflow", "required"))).toBe("full");
    expect(queue.admit(job("unlock", "unlock"))).toBe("busy");
    expect(() => queue.suspendActive()).toThrow();
    expect(queue.startNext()?.id).toBe("required");
    expect(() => queue.resumeActive()).toThrow();
    expect(queue.complete("speculative")).toBeNull();
    expect(queue.active?.id).toBe("required");
    queue.complete("required");
    queue.resumeActive();
    expect(queue.active?.id).toBe("speculative");
    expect(queue.pendingCount).toBe(0);
    queue.suspendActive();
    expect(queue.clearPending()).toEqual([job("speculative", "required")]);
    expect(queue.pendingCount).toBe(0);
    expect(() => queue.resumeActive()).toThrow();
  });
  it("retains ineligible queued work while eligible jobs proceed within the original capacities", () => {
    const queue = new WorkerJobQueue<string>({ requiredCapacity: 2 });
    queue.admit(job("verify", "required"));
    queue.admit(job("scene", "required"));
    queue.admit(job("clipboard", "clipboard"));
    queue.admit(job("export", "export"));
    const sceneOnly = (candidate: WorkerJob<string>) => candidate.id === "scene";
    expect(queue.pendingCount).toBe(4);
    expect(queue.admit(job("overflow", "required"))).toBe("full");
    expect(queue.startNext(sceneOnly)?.id).toBe("scene");
    expect(queue.complete("scene", sceneOnly)).toBeNull();
    expect(queue.pendingCount).toBe(3);
    expect(queue.startNext()?.id).toBe("verify");
    expect(queue.complete("verify")?.id).toBe("clipboard");
    expect(queue.complete("clipboard")?.id).toBe("export");
    expect(queue.complete("export")).toBeNull();
  });

  it("retains a gated exclusive unlock and clears blocked jobs without starting them", () => {
    const queue = new WorkerJobQueue<string>();
    queue.admit(job("unlock", "unlock"));
    expect(queue.startNext(() => false)).toBeNull();
    expect(queue.clearPending()).toEqual([job("unlock", "unlock")]);
    expect(queue.pendingCount).toBe(0);
    expect(queue.startNext()).toBeNull();
  });

  it("does not preempt an active job and then starts pending work by priority", () => {
    const queue = new WorkerJobQueue<string>();
    expect(queue.admit(job("export", "export"))).toBe("accepted");
    expect(queue.startNext()?.id).toBe("export");

    expect(queue.admit(job("clipboard", "clipboard"))).toBe("accepted");
    expect(queue.admit(job("read-back", "required"))).toBe("accepted");
    expect(queue.startNext()?.id).toBe("export");
    expect(queue.complete("export")?.id).toBe("read-back");
    expect(queue.complete("read-back")?.id).toBe("clipboard");
    expect(queue.complete("clipboard")).toBeNull();
  });

  it("admits at most one clipboard and one export job", () => {
    const queue = new WorkerJobQueue<string>();
    expect(queue.admit(job("clipboard-1", "clipboard"))).toBe("accepted");
    expect(queue.admit(job("clipboard-2", "clipboard"))).toBe("busy");
    expect(queue.admit(job("export-1", "export"))).toBe("accepted");
    expect(queue.admit(job("export-2", "export"))).toBe("busy");
    expect(queue.admit(job("export-1", "required"))).toBe("duplicate");
  });

  it("bounds required work and keeps unlock exclusive", () => {
    const queue = new WorkerJobQueue<string>({ requiredCapacity: 2 });
    expect(queue.admit(job("required-1", "required"))).toBe("accepted");
    expect(queue.admit(job("required-2", "required"))).toBe("accepted");
    expect(queue.admit(job("required-3", "required"))).toBe("full");
    expect(queue.admit(job("unlock", "unlock"))).toBe("busy");

    expect(queue.clearPending().map(({ id }) => id)).toEqual(["required-1", "required-2"]);
    expect(queue.admit(job("unlock", "unlock"))).toBe("accepted");
    expect(queue.startNext()?.id).toBe("unlock");
    expect(queue.admit(job("other-unlock", "unlock"))).toBe("busy");
  });

  it("rejects invalid required capacity and ignores a mismatched completion", () => {
    expect(() => new WorkerJobQueue({ requiredCapacity: 0 })).toThrow(RangeError);
    const queue = new WorkerJobQueue<string>();
    queue.admit(job("active", "required"));
    expect(queue.startNext()?.id).toBe("active");
    expect(queue.complete("wrong-id")).toBeNull();
    expect(queue.active?.id).toBe("active");
  });
});
