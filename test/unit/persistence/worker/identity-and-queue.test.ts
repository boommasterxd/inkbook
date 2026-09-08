import { describe, expect, it } from "vitest";

import { WorkerJobQueue } from "../../../../src/persistence/worker/job-queue";
import type { WorkerJob, WorkerJobKind } from "../../../../src/persistence/worker/protocol";

const job = (id: string, kind: WorkerJobKind): WorkerJob<string> => ({ id, kind, payload: id });

describe("bounded non-preemptive worker queue", () => {
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
