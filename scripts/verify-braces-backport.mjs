import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  readBracesAdvisories,
  verifyBracesAdvisories,
  verifyBracesArtifact,
} from "./braces-upstream-audit.mjs";

const BACKPORT_SPEC = "npm:@dieub/braces-depth-guard@3.0.3-pn.3";

export async function verifyBracesBackport(readManifest, readVersions, readAdvisories) {
  const manifest = await readManifest();
  const overrides = manifest.overrides ?? {};
  const backport = overrides["braces@3.0.3"];
  const braceKeys = Object.keys(overrides).filter((key) => /^braces(?:@|$)/.test(key));
  const hasAlias = JSON.stringify(overrides).includes("@dieub/braces-depth-guard");
  if (braceKeys.length === 0 && !hasAlias) return;
  if (backport !== BACKPORT_SPEC || braceKeys.length !== 1) {
    throw new Error("The braces backport changed; review its artifact and retirement guard.");
  }
  const versions = await readVersions();
  if (
    !Array.isArray(versions) ||
    !versions.includes("3.0.3") ||
    !versions.every(
      (version) =>
        typeof version === "string" && /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version),
    )
  ) {
    throw new Error("Cannot verify official braces releases.");
  }
  const release = versions.find((version) => {
    if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
    const [major, minor, patch] = version.split(".").map(Number);
    return major > 3 || (major === 3 && (minor > 0 || (minor === 0 && patch > 3)));
  });
  if (release !== undefined) {
    throw new Error(
      `Official braces ${release} is available. Review the upstream fix, remove the temporary ` +
        "braces override when fixed, regenerate package-lock.json, and rerun npm run ci.",
    );
  }
  verifyBracesAdvisories(await readAdvisories());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const npmEntry = process.env["npm_execpath"];
    const npmRead = (args) => {
      if (!npmEntry) throw new Error("Run the braces backport check through npm run.");
      return execFileSync(process.execPath, [npmEntry, ...args], {
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 64 * 1024,
      });
    };
    await verifyBracesBackport(
      () => JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")),
      () => JSON.parse(npmRead(["view", "braces", "versions", "--json", "--fetch-retries=0"])),
      () => {
        verifyBracesArtifact(
          JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8")),
        );
        return readBracesAdvisories(npmRead(["config", "get", "registry"]).trim());
      },
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
