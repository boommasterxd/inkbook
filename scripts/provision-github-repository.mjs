import { ghApi, ghCommand } from "./github-api.mjs";

const REPOSITORY = "boommasterxd/inkbook";

await configureRepository();
await configureLabels();
await configureSecurity();
await upsertRuleset(branchRuleset());
await upsertRuleset(tagRuleset());
console.log(`Provisioned ${REPOSITORY}.`);

async function configureRepository() {
  await ghApi(`repos/${REPOSITORY}`, {
    method: "PATCH",
    body: {
      allow_auto_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      allow_squash_merge: true,
      delete_branch_on_merge: true,
      has_discussions: false,
      has_issues: true,
      has_projects: true,
      has_wiki: false,
      squash_merge_commit_message: "PR_BODY",
      squash_merge_commit_title: "PR_TITLE",
    },
  });
  await ghApi(`repos/${REPOSITORY}/actions/permissions/workflow`, {
    method: "PUT",
    body: {
      can_approve_pull_request_reviews: true,
      default_workflow_permissions: "read",
    },
  });
  await ghApi(`repos/${REPOSITORY}/actions/permissions`, {
    method: "PUT",
    body: { allowed_actions: "selected", enabled: true },
  });
  await ghApi(`repos/${REPOSITORY}/actions/permissions/selected-actions`, {
    method: "PUT",
    body: {
      github_owned_allowed: true,
      patterns_allowed: [
        "dependabot/fetch-metadata@*",
        "amannn/action-semantic-pull-request@*",
      ],
      verified_allowed: false,
    },
  });
  await ghApi(
    `repos/${REPOSITORY}/actions/permissions/fork-pr-workflows-private-repos`,
    {
      method: "PUT",
      body: {
        require_approval_for_fork_pr_workflows: true,
        run_workflows_from_fork_pull_requests: true,
        send_secrets_and_variables: false,
        send_write_tokens_to_workflows: false,
      },
    },
  );
}

async function configureLabels() {
  const labels = [
    ["dependencies", "0366d6", "Pull requests that update a dependency file"],
    [
      "github-actions",
      "2088ff",
      "Pull requests that update GitHub Actions code",
    ],
  ];
  for (const [name, color, description] of labels) {
    await ghCommand([
      "label",
      "create",
      name,
      "--color",
      color,
      "--description",
      description,
      "--force",
      "--repo",
      REPOSITORY,
    ]);
  }
}

async function configureSecurity() {
  await ghApi(`repos/${REPOSITORY}/vulnerability-alerts`, { method: "PUT" });
  await ghApi(`repos/${REPOSITORY}/automated-security-fixes`, {
    method: "PUT",
  });
}

async function upsertRuleset(desired) {
  const rulesets = await ghApi(`repos/${REPOSITORY}/rulesets`);
  const existing = rulesets.find((ruleset) => ruleset.name === desired.name);
  const endpoint = existing
    ? `repos/${REPOSITORY}/rulesets/${existing.id}`
    : `repos/${REPOSITORY}/rulesets`;
  await ghApi(endpoint, { method: existing ? "PUT" : "POST", body: desired });
}

function branchRuleset() {
  return {
    name: "Protect main",
    target: "branch",
    enforcement: "active",
    bypass_actors: [
      { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
    ],
    conditions: { ref_name: { exclude: [], include: ["~DEFAULT_BRANCH"] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          allowed_merge_methods: ["squash"],
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: 0,
          required_review_thread_resolution: false,
        },
      },
      {
        type: "required_status_checks",
        parameters: {
          do_not_enforce_on_create: true,
          required_status_checks: [
            { context: "CI" },
            { context: "gitleaks" },
            { context: "Validate PR Title" },
          ],
          strict_required_status_checks_policy: false,
        },
      },
    ],
  };
}

function tagRuleset() {
  return {
    name: "Protect release tags",
    target: "tag",
    enforcement: "active",
    bypass_actors: [
      { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" },
    ],
    conditions: { ref_name: { exclude: [], include: ["refs/tags/v*"] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      { type: "update" },
    ],
  };
}
