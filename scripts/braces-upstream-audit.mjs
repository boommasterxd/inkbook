const REVIEWED_ADVISORY = {
  url: "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm",
  title: "braces vulnerable to stack-exhaustion denial of service through deeply nested patterns",
  severity: "high",
  vulnerable_versions: "<=3.0.3",
};

export function verifyBracesArtifact(lockfile) {
  const packages = Object.values(lockfile.packages ?? {}).filter(
    (entry) => entry.name === "@dieub/braces-depth-guard",
  );
  if (
    packages.length !== 1 ||
    packages[0].version !== "3.0.3-pn.3" ||
    packages[0].integrity !==
      "sha512-QY+Uq4s42STyIMPoRkBuUZfYyvz0uZuwuUburLwMx5N+lWqnHHaBxcKPtgKVKjTyFnS1q4ivKu9Wxi4VG7FE9Q=="
  ) {
    throw new Error("The reviewed braces backport artifact changed; repeat security review.");
  }
}

export function verifyBracesAdvisories(response) {
  if (!response || !Array.isArray(response.braces) || response.braces.length === 0) {
    throw new Error("Cannot verify upstream braces advisories.");
  }
  for (const advisory of response.braces) {
    if (
      !advisory ||
      !Object.entries(REVIEWED_ADVISORY).every(([key, value]) => advisory[key] === value)
    ) {
      throw new Error("Unreviewed upstream braces advisory; reassess the temporary backport.");
    }
  }
}

function requestRegistryBody(endpoint, options) {
  return new Promise((resolve, reject) => {
    const pending = request(endpoint, options, (body) => {
      if (body.statusCode !== 200) {
        body.destroy();
        reject(new Error("Cannot read upstream braces advisories."));
        return;
      }
      resolve({ ok: true, body });
    });
    pending.once("error", reject);
    pending.end(options.body);
  });
}

export async function readBracesAdvisories(registry, fetchRegistry = requestRegistryBody) {
  const endpoint = new URL("-/npm/v1/security/advisories/bulk", registry);
  if (endpoint.protocol !== "https:") throw new Error("The advisory registry must use HTTPS.");
  const response = await fetchRegistry(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ braces: ["3.0.3"] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || !response.body) throw new Error("Cannot read upstream braces advisories.");
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 64 * 1024) throw new Error("The braces advisory response exceeds its byte limit.");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
import { request } from "node:https";
