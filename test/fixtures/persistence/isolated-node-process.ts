import { spawn } from "node:child_process";
import { clearTimeout, setTimeout } from "node:timers";

const MAXIMUM_STDERR_BYTES = 64 * 1024;

interface IsolatedNodeOptions {
  readonly args: readonly string[];
  readonly outputDescriptor: number;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

/** Settles only after the owned process and its stderr stream have closed. */
export function executeIsolatedNode(options: IsolatedNodeOptions): Promise<void> {
  options.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...options.args], {
      stdio: ["ignore", options.outputDescriptor, "pipe"],
    });
    let failure: Error | undefined;
    let stderr = "";
    let stderrBytes = 0;
    const stop = (error: Error): void => {
      failure ??= error;
      child.kill("SIGKILL");
    };
    const abort = (): void => stop(new Error("Memory lifecycle runner was aborted."));
    const timeout = setTimeout(
      () => stop(new Error("Memory lifecycle runner exceeded its execution timeout.")),
      options.timeoutMs,
    );
    options.signal.addEventListener("abort", abort, { once: true });
    child.once("error", stop);
    child.stderr?.on("error", stop);
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > MAXIMUM_STDERR_BYTES) {
        stop(new Error("Memory lifecycle runner stderr exceeded 64 KiB."));
      } else {
        stderr += chunk;
      }
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      options.signal.removeEventListener("abort", abort);
      if (failure !== undefined) reject(failure);
      else if (code === 0) resolve();
      else reject(new Error(`Memory lifecycle runner failed (${signal ?? code}): ${stderr}`));
    });
  });
}
