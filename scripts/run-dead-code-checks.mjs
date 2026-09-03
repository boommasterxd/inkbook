import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const knipEntry = path.join(projectRoot, "node_modules", "knip", "bin", "knip.js");

const gate = runKnip([]);
if (gate.status !== 0) process.exit(gate.status ?? 1);

process.stdout.write("\nProduction-only dead-code gate:\n");
const productionGate = runKnip([
  "--production",
  "--include",
  "files,exports,types",
  "--reporter",
  "compact",
]);
if (productionGate.status !== 0) process.exit(productionGate.status ?? 1);

function runKnip(arguments_) {
  const result = spawnSync(process.execPath, [knipEntry, ...arguments_], {
    cwd: projectRoot,
    stdio: "inherit",
  });
  if (result.error !== undefined) throw result.error;
  return result;
}
