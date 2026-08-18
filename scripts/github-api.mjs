import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
const GH_BINARY = "/usr/bin/gh";

export async function ghApi(endpoint, options = {}) {
  const method = options.method ?? "GET";
  const args = ["api", endpoint, "--method", method];
  if (options.body !== undefined) args.push("--input", "-");
  const output = await spawnGh(args, options.body);
  return output ? JSON.parse(output) : null;
}

export async function ghCommand(args) {
  return execute(GH_BINARY, args, { maxBuffer: 10 * 1024 * 1024 });
}

function spawnGh(args, body) {
  return new Promise((resolve, reject) => {
    const child = spawn(GH_BINARY, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`gh ${args.join(" ")} failed: ${stderr.trim()}`));
    });
    child.stdin.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
