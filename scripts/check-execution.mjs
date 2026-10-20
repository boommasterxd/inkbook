import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { constants } from "node:os";
import { clearTimeout as cancelTimer, setTimeout as scheduleTimer } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_CHECK_PORT = 47839;

export async function runExclusiveChecks(commands, options = {}) {
  const server = createServer((socket) => socket.destroy());
  const port = options.port ?? DEFAULT_CHECK_PORT;
  try {
    await listen(server, port);
  } catch (error) {
    process.stderr.write(
      error.code === "EADDRINUSE"
        ? `Inkbook checks are busy: another local check or service owns 127.0.0.1:${port}.\n`
        : `Cannot acquire the Inkbook check guard: ${error.message}\n`,
    );
    return error.code === "EADDRINUSE" ? 75 : 1;
  }
  try {
    return await executeCommands(commands, options.cwd ?? process.cwd(), options);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

export async function executeCommands(commands, cwd, options = {}) {
  const shutdownGraceMs = options.shutdownGraceMs ?? 5_000;
  let activeChild;
  let interrupted;
  let killTimer;
  let stopTimer;
  let shutdownDeadline;
  let finishTimeout;
  const timeout = new Promise((resolve) => (finishTimeout = resolve));
  const interrupt = (signal) => {
    if (interrupted === undefined) {
      shutdownDeadline = performance.now() + shutdownGraceMs + 1_000;
      killTimer = scheduleTimer(() => {
        if (activeChild !== undefined) forwardSignal(activeChild, "SIGKILL");
      }, shutdownGraceMs);
      stopTimer = scheduleTimer(() => {
        activeChild?.unref();
        finishTimeout(1);
      }, shutdownGraceMs + 1_000);
    }
    interrupted ??= signal;
    if (activeChild !== undefined) forwardSignal(activeChild, signal);
  };
  const interruptHandler = () => interrupt("SIGINT");
  const terminateHandler = () => interrupt("SIGTERM");
  process.on("SIGINT", interruptHandler);
  process.on("SIGTERM", terminateHandler);
  const executionTimer =
    options.timeoutMs === undefined
      ? undefined
      : scheduleTimer(() => {
          process.stderr.write("Check execution exceeded its timeout.\n");
          interrupt("SIGTERM");
        }, options.timeoutMs);
  try {
    for (const { label, command, args } of commands) {
      if (interrupted) return signalStatus(interrupted);
      process.stdout.write(`\nRunning ${label}...\n`);
      activeChild = spawn(command, args, {
        cwd,
        detached: process.platform !== "win32",
        stdio: "inherit",
      });
      const status = await Promise.race([childStatus(activeChild), timeout]);
      if (interrupted && !(await waitForShutdown(activeChild, shutdownDeadline))) return 1;
      activeChild = undefined;
      if (status !== 0) return status;
      if (interrupted) return signalStatus(interrupted);
    }
    return 0;
  } finally {
    cancelTimer(executionTimer);
    cancelTimer(killTimer);
    cancelTimer(stopTimer);
    process.removeListener("SIGINT", interruptHandler);
    process.removeListener("SIGTERM", terminateHandler);
  }
}

async function waitForShutdown(child, deadline) {
  if (process.platform === "win32" || child.pid === undefined) return true;
  try {
    while (await groupIsRunning(child.pid)) {
      if (performance.now() >= deadline) {
        process.stderr.write("Check process group did not stop after SIGKILL; shutdown failed.\n");
        return false;
      }
      await delay(25);
    }
  } catch (error) {
    forwardSignal(child, "SIGKILL");
    process.stderr.write(`Cannot verify check process group shutdown: ${error.message}\n`);
    return false;
  }
  return true;
}

async function groupIsRunning(groupId) {
  if (process.platform === "linux") {
    // Orphaned zombies may survive under container PID 1, but cannot run checks.
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const stat = await readFile(`/proc/${entry}/stat`, "utf8");
        const [state, , group] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (Number(group) === groupId && state !== "Z" && state !== "X") return true;
      } catch (error) {
        if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
      }
    }
    return false;
  }
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
    return false;
  }
}

function forwardSignal(child, signal) {
  if (process.platform === "win32") {
    child.kill(signal);
    return;
  }
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function childStatus(child) {
  return new Promise((resolve) => {
    let spawnFailed = false;
    child.once("error", (error) => {
      spawnFailed = true;
      process.stderr.write(`Cannot run check: ${error.message}\n`);
    });
    child.once("close", (code, signal) => {
      resolve(spawnFailed ? 1 : (code ?? signalStatus(signal)));
    });
  });
}

function signalStatus(signal) {
  return 128 + (constants.signals[signal] ?? 1);
}
