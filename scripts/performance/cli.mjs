import path from "node:path";
import { fileURLToPath } from "node:url";

export function runAsCli(moduleUrl, main) {
  const isMain =
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(moduleUrl);
  if (isMain) {
    main().catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
