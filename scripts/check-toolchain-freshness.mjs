import { execFile } from "node:child_process";
import { promisify } from "node:util";

import semver from "semver";

import { fail, readJson } from "./lib-files.mjs";

const execute = promisify(execFile);
const policy = await readJson("toolchain-policy.json");
const packageJson = await readJson("package.json");

await verifyNode();
await verifyNpm();
await verifyPackages();
await verifyGitleaks();
await verifyActions();
console.log("Toolchain freshness validation passed.");

async function verifyNode() {
  const releases = await fetchJson("https://nodejs.org/dist/index.json");
  const selectedMajor = semver.major(policy.node.version);
  const latestSelectedMajor = releases.find(
    (release) => semver.major(release.version.slice(1)) === selectedMajor,
  );
  if (
    !latestSelectedMajor ||
    latestSelectedMajor.version.slice(1) !== policy.node.version
  ) {
    fail(`Node ${selectedMajor} stable changed from ${policy.node.version}`);
  }
}

async function verifyNpm() {
  const latest = await npmView("npm", "version");
  if (latest !== policy.npm)
    fail(`npm stable changed from ${policy.npm} to ${latest}`);
}

async function verifyPackages() {
  const dependencies = Object.entries(packageJson.devDependencies);
  await Promise.all(
    dependencies.map(async ([name, range]) => {
      const constraint = policy.compatibilityConstraints[name];
      const selector = constraint ? `${name}@${constraint}` : name;
      const latest = await npmView(selector, "version");
      if (!semver.satisfies(latest, range)) {
        fail(`${name} ${latest} is outside declared range ${range}`);
      }
    }),
  );
}

async function verifyGitleaks() {
  const release = await fetchJson(
    "https://api.github.com/repos/gitleaks/gitleaks/releases/latest",
  );
  if (release.tag_name !== `v${policy.gitleaks.version}`) {
    fail(`gitleaks stable changed from ${policy.gitleaks.version}`);
  }
}

async function verifyActions() {
  await Promise.all(
    Object.entries(policy.actions).map(async ([repository, expected]) => {
      const release = await fetchJson(
        `https://api.github.com/repos/${repository}/releases/latest`,
      );
      if (release.tag_name !== expected.tag)
        fail(`${repository} stable changed from ${expected.tag}`);
      const resolved = await resolveTag(repository, expected.tag);
      if (resolved !== expected.sha)
        fail(`${repository} tag no longer resolves to recorded SHA`);
    }),
  );
}

async function resolveTag(repository, tag) {
  const reference = await fetchJson(
    `https://api.github.com/repos/${repository}/git/ref/tags/${tag}`,
  );
  if (reference.object.type === "commit") return reference.object.sha;
  const annotated = await fetchJson(reference.object.url);
  return annotated.object.sha;
}

async function npmView(selector, field) {
  const { stdout } = await execute("npm", ["view", selector, field, "--json"]);
  const value = JSON.parse(stdout);
  return Array.isArray(value) ? value.at(-1) : value;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!response.ok) fail(`Freshness request failed: ${response.status} ${url}`);
  return response.json();
}
