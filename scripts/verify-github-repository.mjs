import { ghApi } from "./github-api.mjs";
import { fail } from "./lib-files.mjs";

const REPOSITORY = "boommasterxd/inkbook";
const repository = await ghApi(`repos/${REPOSITORY}`);
const workflowPermissions = await ghApi(
  `repos/${REPOSITORY}/actions/permissions/workflow`,
);
const labels = await ghApi(`repos/${REPOSITORY}/labels?per_page=100`);
const rulesets = await ghApi(`repos/${REPOSITORY}/rulesets`);

verifyRepository(repository);
verifyWorkflowPermissions(workflowPermissions);
verifyLabels(labels);
await verifyRulesets(rulesets);
await ghApi(`repos/${REPOSITORY}/vulnerability-alerts`);
await ghApi(`repos/${REPOSITORY}/automated-security-fixes`);
reportSecurityCapabilities(repository.security_and_analysis);
console.log(`GitHub repository validation passed for ${REPOSITORY}.`);

function verifyRepository(value) {
  const expected = {
    allow_auto_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    allow_squash_merge: true,
    default_branch: "main",
    delete_branch_on_merge: true,
    has_discussions: false,
    has_issues: true,
    has_projects: true,
    has_wiki: false,
    private: true,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) fail(`Repository setting drift: ${key}`);
  }
}

function verifyWorkflowPermissions(value) {
  if (value.default_workflow_permissions !== "read")
    fail("Workflow token is not read-only by default");
  if (value.can_approve_pull_request_reviews !== true)
    fail("Actions cannot approve pull requests");
}

function verifyLabels(values) {
  const expected = new Map([
    ["dependencies", "0366d6"],
    ["github-actions", "2088ff"],
  ]);
  for (const [name, color] of expected) {
    const label = values.find((candidate) => candidate.name === name);
    if (label?.color.toLowerCase() !== color) fail(`Label drift: ${name}`);
  }
}

async function verifyRulesets(values) {
  const branch = values.find((ruleset) => ruleset.name === "Protect main");
  const tags = values.find(
    (ruleset) => ruleset.name === "Protect release tags",
  );
  if (!branch || !tags) fail("Required ruleset is missing");
  const branchDetails = await ghApi(
    `repos/${REPOSITORY}/rulesets/${branch.id}`,
  );
  const tagDetails = await ghApi(`repos/${REPOSITORY}/rulesets/${tags.id}`);
  verifyBranchRules(branchDetails);
  verifyTagRules(tagDetails);
}

function verifyBranchRules(ruleset) {
  if (ruleset.enforcement !== "active") fail("Protect main is not active");
  const types = new Set(ruleset.rules.map((rule) => rule.type));
  for (const type of [
    "deletion",
    "non_fast_forward",
    "pull_request",
    "required_status_checks",
  ]) {
    if (!types.has(type)) fail(`Protect main lacks ${type}`);
  }
  if (types.has("update")) fail("Protect main must not use the update rule");
  const statusRule = ruleset.rules.find(
    (rule) => rule.type === "required_status_checks",
  );
  const contexts = statusRule.parameters.required_status_checks
    .map((check) => check.context)
    .sort();
  if (
    contexts.join("|") !==
    ["CI", "Validate PR Title", "gitleaks"].sort().join("|")
  ) {
    fail("Protect main required checks differ");
  }
}

function verifyTagRules(ruleset) {
  if (ruleset.enforcement !== "active")
    fail("Release tag ruleset is not active");
  const types = new Set(ruleset.rules.map((rule) => rule.type));
  for (const type of ["deletion", "non_fast_forward", "update"]) {
    if (!types.has(type)) fail(`Release tag ruleset lacks ${type}`);
  }
}

function reportSecurityCapabilities(value) {
  for (const feature of [
    "secret_scanning",
    "secret_scanning_push_protection",
  ]) {
    if (value?.[feature]?.status !== "enabled") {
      console.warn(
        `GitHub plan capability unavailable or disabled: ${feature}`,
      );
    }
  }
}
