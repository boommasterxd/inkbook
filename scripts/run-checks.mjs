import { checkProjectRoot, createCheckCommandPlan } from "./check-command-plan.mjs";
import { runExclusiveChecks } from "./check-execution.mjs";

try {
  const [name, ...extraArgs] = process.argv.slice(2);
  const commands = createCheckCommandPlan(name, extraArgs);
  process.exitCode = await runExclusiveChecks(commands, { cwd: checkProjectRoot });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
