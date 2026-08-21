import { stat } from "node:fs/promises";

const maximumBundleBytes = 512 * 1024;
const { size } = await stat("dist/main.js");

if (size > maximumBundleBytes) {
  throw new Error(
    `Production bundle is ${size} bytes, exceeding the ${maximumBundleBytes}-byte budget.`,
  );
}

process.stdout.write(`Production bundle: ${size} / ${maximumBundleBytes} bytes\n`);
