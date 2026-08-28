import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const knipEntry = path.join(projectRoot, "node_modules", "knip", "bin", "knip.js");

const gate = runKnip([]);
if (gate.status !== 0) process.exit(gate.status ?? 1);

process.stdout.write(
  "\nProduction-only dead-source report (informational, existing findings do not fail CI):\n",
);
runKnip([
  "--production",
  "--include",
  "files,exports,types",
  "--no-exit-code",
  "--reporter",
  "compact",
]);

function runKnip(arguments_) {
  const result = spawnSync(process.execPath, [knipEntry, ...arguments_], {
    cwd: projectRoot,
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  return result;
}
