import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const executionUrl = new URL("../../../scripts/check-execution.mjs", import.meta.url).href;
let directory;
let runnerPath;
let leafPath;
let port;
const running = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "inkbook-check-execution-"));
  runnerPath = join(directory, "runner.mjs");
  leafPath = join(directory, "leaf.mjs");
  await writeFile(
    runnerPath,
    `import { runExclusiveChecks } from ${JSON.stringify(executionUrl)};
process.exitCode = await runExclusiveChecks(JSON.parse(process.argv[2]), {
  port: Number(process.argv[3]), cwd: process.cwd(), timeoutMs: Number(process.argv[4]) || undefined
});`,
  );
  await writeFile(
    leafPath,
    `process.on("SIGINT", () => console.log("interrupted"));
process.on("SIGTERM", () => console.log("terminated"));
process.stdin.on("data", () => process.exit(0));
process.stdin.on("end", () => process.exit(0));
console.log("ready");`,
  );
  port = await availablePort();
});

afterEach(async () => {
  const runners = running.splice(0);
  for (const runner of runners) runner.child.stdin.end();
  await Promise.all(runners.map(({ completed }) => completed));
  await rm(directory, { recursive: true, force: true });
});

function start(commands, cwd = directory, timeoutMs) {
  const child = spawn(
    process.execPath,
    [runnerPath, JSON.stringify(commands), String(port), String(timeoutMs)],
    {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const events = new EventEmitter();
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      output += chunk;
      events.emit("output");
    });
  }
  const completed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, output }));
  });
  const runner = {
    child,
    completed,
    async waitFor(message) {
      if (output.includes(message)) return;
      await new Promise((resolve, reject) => {
        const inspect = () => {
          if (!output.includes(message)) return;
          events.removeListener("output", inspect);
          resolve();
        };
        events.on("output", inspect);
        void completed.then(() => {
          events.removeListener("output", inspect);
          reject(new Error(`Process exited before ${message}: ${output}`));
        }, reject);
      });
    },
  };
  running.push(runner);
  return runner;
}

function command(source) {
  return {
    label: "fixture",
    command: process.execPath,
    args: ["--input-type=module", "-e", source],
  };
}

function holdCommand() {
  return { label: "holding fixture", command: process.execPath, args: [leafPath] };
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const selectedPort = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return selectedPort;
}

describe("exclusive check execution", () => {
  it("executes commands sequentially in the requested working directory", async () => {
    const runner = start([
      command('import { writeFile } from "node:fs/promises"; await writeFile("order", "first");'),
      command(
        'import { appendFile, readFile } from "node:fs/promises"; ' +
          'if (await readFile("order", "utf8") !== "first") process.exit(8); ' +
          'await appendFile("order", " second");',
      ),
    ]);
    expect(await runner.completed).toMatchObject({ code: 0, signal: null });
    expect(await readFile(join(directory, "order"), "utf8")).toBe("first second");
  });

  it("rejects a competing process from another working directory before running commands", async () => {
    const owner = start([holdCommand()]);
    await owner.waitFor("ready");
    const otherDirectory = join(directory, "other");
    await mkdir(otherDirectory);
    const competitor = start([command('console.log("MUST_NOT_RUN")')], otherDirectory);
    const result = await competitor.completed;
    expect(result.code).toBe(75);
    expect(result.output).toContain("Inkbook checks are busy");
    expect(result.output).toContain(`127.0.0.1:${port}`);
    expect(result.output).not.toContain("MUST_NOT_RUN");
    owner.child.stdin.write("exit\n");
    expect(await owner.completed).toMatchObject({ code: 0 });
    expect(await start([command("process.exit(0)")]).completed).toMatchObject({ code: 0 });
  });

  it("preserves a tool failure, skips successors, and releases the guard", async () => {
    const failed = await start([
      command("process.exit(23)"),
      command('console.log("MUST_NOT_RUN")'),
    ]).completed;
    expect(failed.code).toBe(23);
    expect(failed.output).not.toContain("MUST_NOT_RUN");
    expect(await start([]).completed).toMatchObject({ code: 0 });
  });

  it("reports spawn failure without running successors", async () => {
    const result = await start([
      { label: "missing", command: join(directory, "missing-command"), args: [] },
      command('console.log("MUST_NOT_RUN")'),
    ]).completed;
    expect(result.code).toBe(1);
    expect(result.output).toContain("Cannot run check");
    expect(result.output).not.toContain("MUST_NOT_RUN");
    expect(await start([]).completed).toMatchObject({ code: 0 });
  });
});

describe("nested and timed check execution", () => {
  it("drains a nested runner's ignored grandchild before releasing the outer guard", async () => {
    const nestedCommand = command(
      'import { spawn } from "node:child_process"; ' +
        'process.on("SIGTERM", () => console.log("nested terminated")); ' +
        `const child = spawn(process.execPath, [${JSON.stringify(leafPath)}], { stdio: "inherit" }); ` +
        "console.log(`grandchild pid ${child.pid}`);",
    );
    const owner = start([
      command(
        `import { executeCommands } from ${JSON.stringify(executionUrl)}; ` +
          `process.exitCode = await executeCommands(${JSON.stringify([nestedCommand])}, process.cwd(), { shutdownGraceMs: 500 });`,
      ),
      command('console.log("MUST_NOT_RUN")'),
    ]);
    await owner.waitFor("ready");
    owner.child.kill("SIGTERM");
    await owner.waitFor("nested terminated");
    expect(await start([]).completed).toMatchObject({ code: 75 });
    const result = await owner.completed;
    expect(result.code).toBe(137);
    expect(result.output).not.toContain("MUST_NOT_RUN");
    const pid = Number(result.output.match(/grandchild pid (\d+)/)[1]);
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch((error) => {
        expect(error.code).toBe("ENOENT");
        return undefined;
      });
      if (stat !== undefined)
        expect(["Z", "X"]).toContain(
          stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3),
        );
    } else expect(() => process.kill(pid, 0)).toThrow();
    expect(await start([]).completed).toMatchObject({ code: 0 });
  });

  it("cleans up a timed-out process group before releasing ownership or running successors", async () => {
    const owner = start(
      [
        command(
          'process.on("SIGTERM", () => { console.log("deadline stopped"); process.exit(0); }); console.log("ready"); process.stdin.resume();',
        ),
        command('console.log("MUST_NOT_RUN")'),
      ],
      directory,
      500,
    );
    await owner.waitFor("ready");
    const result = await owner.completed;
    expect(result.code).toBe(143);
    expect(result.output).toContain("Check execution exceeded its timeout.");
    expect(result.output).toContain("deadline stopped");
    expect(result.output).not.toContain("MUST_NOT_RUN");
    expect(await start([]).completed).toMatchObject({ code: 0 });
  });
});

describe("interrupted check execution", () => {
  it.each([
    ["SIGINT", "interrupted", 130],
    ["SIGTERM", "terminated", 143],
  ])("retains ownership until the child closes after %s", async (signal, message, status) => {
    const owner = start([holdCommand(), command('console.log("MUST_NOT_RUN")')]);
    await owner.waitFor("ready");
    owner.child.kill(signal);
    await owner.waitFor(message);
    expect(await start([]).completed).toMatchObject({ code: 75 });
    owner.child.stdin.write("exit\n");
    const result = await owner.completed;
    expect(result.code).toBe(status);
    expect(result.output).not.toContain("MUST_NOT_RUN");
    expect(await start([]).completed).toMatchObject({ code: 0 });
  });

  it("keeps the guard for a descendant after its direct parent exits on SIGTERM", async () => {
    const owner = start([
      command(
        'import { spawn } from "node:child_process"; ' +
          'process.on("SIGTERM", () => { console.log("parent terminated"); process.exit(0); }); ' +
          `const child = spawn(process.execPath, [${JSON.stringify(leafPath)}], { stdio: "inherit" }); ` +
          'child.on("close", () => console.log("descendant closed"));',
      ),
      command('console.log("MUST_NOT_RUN")'),
    ]);
    await owner.waitFor("ready");
    owner.child.kill("SIGTERM");
    await owner.waitFor("parent terminated");
    await owner.waitFor("\nterminated\n");
    expect(await start([]).completed).toMatchObject({ code: 75 });
    owner.child.stdin.write("exit\n");
    const result = await owner.completed;
    expect(result.code).toBe(143);
    expect(result.output).not.toContain("MUST_NOT_RUN");
    expect(await start([]).completed).toMatchObject({ code: 0 });
  });

  it("escalates an ignored termination signal without starting successors", async () => {
    const owner = start([holdCommand(), command('console.log("MUST_NOT_RUN")')]);
    await owner.waitFor("ready");
    owner.child.kill("SIGTERM");
    await owner.waitFor("terminated");
    const result = await owner.completed;
    expect(result.code).toBe(137);
    expect(result.output).not.toContain("MUST_NOT_RUN");
    expect(await start([]).completed).toMatchObject({ code: 0 });
  }, 10_000);
});
