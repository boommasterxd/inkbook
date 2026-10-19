import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import path from "node:path";

const commandPrefixes = {
  GITHUB_OUTPUT: "set_output_",
  GITHUB_STEP_SUMMARY: "step_summary_",
};

async function commandTarget(variable) {
  const configured = process.env[variable];
  if (!configured) return null;
  const temporary = process.env["RUNNER_TEMP"];
  if (!temporary || !path.isAbsolute(temporary) || !path.isAbsolute(configured)) {
    throw new Error(`Invalid runner file command configuration for ${variable}.`);
  }
  // The runner creates these files before the step; RUNNER_TEMP is trusted runner configuration.
  // https://github.com/actions/runner/blob/main/src/Runner.Worker/FileCommandManager.cs
  const root = await realpath(temporary);
  const directory = path.join(root, "_runner_file_commands");
  const normalized = path.resolve(configured);
  const filename = path.basename(normalized);
  const prefix = commandPrefixes[variable];
  if (
    !prefix ||
    path.dirname(normalized) !== path.resolve(temporary, "_runner_file_commands") ||
    !filename.startsWith(prefix) ||
    filename.length <= prefix.length ||
    !/^[a-zA-Z0-9_-]+$/.test(filename) ||
    (await realpath(directory)) !== directory
  ) {
    throw new Error(`Invalid runner file command target for ${variable}.`);
  }
  return { target: path.join(directory, filename), directory };
}

export async function appendRunnerCommand(variable, content) {
  const command = await commandTarget(variable);
  if (!command) return;
  const before = await lstat(command.target);
  const owner = await stat(command.directory);
  if (!before.isFile() || before.nlink !== 1 || before.uid !== owner.uid) {
    throw new Error(`Runner file command must be an owned regular file for ${variable}.`);
  }
  // Never create a missing file, follow a final symlink, or block on a substituted FIFO.
  const flags =
    constants.O_WRONLY |
    constants.O_APPEND |
    (constants.O_NOFOLLOW ?? 0) |
    (constants.O_NONBLOCK ?? 0);
  const handle = await open(command.target, flags);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.uid !== before.uid
    ) {
      throw new Error(`Runner file command changed before append for ${variable}.`);
    }
    await handle.appendFile(content);
  } finally {
    await handle.close();
  }
}
