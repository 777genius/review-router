# ReviewRouter installer

ReviewRouter can be installed into any GitHub repository with a single `curl | bash` command. The installer writes a pull request workflow, stores the required repository secrets/variables, and opens a setup PR instead of pushing directly to the default branch.

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/multi-provider-code-review/main/scripts/install.sh | bash
```

The installer supports macOS and Linux shells first. It requires `gh`, `git`, and `curl`. GitHub App manifest setup uses `python3` when available; without `python3`, the installer prints manual App setup instructions.

The generated workflow uses the latest pinned release tag by default:

```text
777genius/multi-provider-code-review@v0.3.0-alpha.1
```

Use `REVIEW_ROUTER_ACTION_REF_MODE=main` if you want the target repository to run the newest `main` branch on every workflow run. Use `REVIEW_ROUTER_ACTION_REF=owner/repo@ref` for a custom fork or exact commit SHA.

## Quick start

### One repository

Fast setup for a single repository. Secrets and variables are stored on that repository only.

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/multi-provider-code-review/main/scripts/install.sh | env \
  REVIEW_ROUTER_REPO=owner/repo \
  REVIEW_ROUTER_SECRET_SCOPE=repo \
  REVIEW_ROUTER_IDENTITY=actions \
  REVIEW_ROUTER_AUTH=codex \
  REVIEW_ROUTER_PRESET=safe \
  bash
```

Use `REVIEW_ROUTER_IDENTITY=app` instead of `actions` if you want comments from a dedicated GitHub App bot instead of `github-actions[bot]`.

### Organization selected repositories

Recommended team setup. Secrets and variables live at organization level, but only selected repositories can access them.

For smoke tests, use a disposable test organization/repository or `REVIEW_ROUTER_DRY_RUN=1`. Do not test org-level secrets against a production organization unless you intend to store real secrets there.

```bash
gh auth refresh -s admin:org

curl -fsSL https://raw.githubusercontent.com/777genius/multi-provider-code-review/main/scripts/install.sh | env \
  REVIEW_ROUTER_REPO=your-org/repo-a \
  REVIEW_ROUTER_SECRET_SCOPE=org \
  REVIEW_ROUTER_ORG=your-org \
  REVIEW_ROUTER_ORG_SECRET_REPOS=repo-a,repo-b \
  REVIEW_ROUTER_IDENTITY=app \
  REVIEW_ROUTER_AUTH=codex \
  REVIEW_ROUTER_PRESET=safe \
  bash
```

This uses `gh secret set --org your-org --repos repo-a,repo-b --app actions`, not `--visibility all`.

To run a real org e2e smoke test against a disposable organization without granting `delete_repo`:

```bash
gh auth refresh -s admin:org
REVIEW_ROUTER_E2E_ORG=your-test-org REVIEW_ROUTER_E2E_SKIP_DELETE=1 bash scripts/e2e-org-installer-smoke.sh
```

The smoke script creates a temporary private repo, installs org-level selected-repo secrets/variables, verifies `visibility=selected` and `numSelectedRepos=1`, verifies the setup PR/workflow, then deletes the smoke secrets/variables. With `REVIEW_ROUTER_E2E_SKIP_DELETE=1`, it leaves the temporary repo for manual deletion so the CLI does not need `delete_repo`.

To verify reruns do not duplicate inline comments on a disposable smoke repository:

```bash
REVIEW_ROUTER_E2E_REPO=owner/repo bash scripts/e2e-rerun-dedup-smoke.sh
```

The script opens a temporary PR with a known review fixture, waits for the first review, pushes an empty commit, waits for the rerun, and fails if the inline comment count increases.

### API key instead of Codex OAuth

For teams that do not want to store a personal Codex OAuth session:

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/multi-provider-code-review/main/scripts/install.sh | env \
  REVIEW_ROUTER_REPO=owner/repo \
  REVIEW_ROUTER_SECRET_SCOPE=repo \
  REVIEW_ROUTER_IDENTITY=actions \
  REVIEW_ROUTER_AUTH=openai \
  REVIEW_ROUTER_OPENAI_API_KEY=sk-... \
  REVIEW_ROUTER_PRESET=safe \
  bash
```

### Live main instead of release tag

Use this when you deliberately want every workflow run to pull the newest reviewer code from `main`:

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/multi-provider-code-review/main/scripts/install.sh | env \
  REVIEW_ROUTER_REPO=owner/repo \
  REVIEW_ROUTER_ACTION_REF_MODE=main \
  REVIEW_ROUTER_SECRET_SCOPE=repo \
  REVIEW_ROUTER_IDENTITY=actions \
  REVIEW_ROUTER_AUTH=codex \
  REVIEW_ROUTER_PRESET=safe \
  bash
```

## What it creates

- `.github/workflows/review-router.yml`
- Repository or organization variables such as `REVIEW_CODEX_MODEL`, `REVIEW_AUTH_MODE`, or OpenRouter provider variables
- Repository or organization secrets for the selected auth mode
- Branch `review-router/setup`
- A setup PR with the workflow change

Secrets are never deleted automatically. Existing secrets and variables are overwritten only after confirmation.

## Secret scopes

| Scope  | Where secrets live                     | Repository access          | Best for                                                               |
| ------ | -------------------------------------- | -------------------------- | ---------------------------------------------------------------------- |
| `repo` | Target repository                      | Target repository only     | Simple setup, personal repos, small private repos                      |
| `org`  | Organization Actions secrets/variables | Selected repositories only | Teams that want one central secret with explicit repository allow-list |

`org` scope always uses selected repositories. It does not grant access to every repository in the organization.

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/multi-provider-code-review/main/scripts/install.sh | env \
  REVIEW_ROUTER_REPO=your-org/repo-a \
  REVIEW_ROUTER_SECRET_SCOPE=org \
  REVIEW_ROUTER_ORG=your-org \
  REVIEW_ROUTER_ORG_SECRET_REPOS=repo-a,repo-b \
  bash
```

If `REVIEW_ROUTER_ORG_SECRET_REPOS` is not set, the installer grants access only to the target repo name from `REVIEW_ROUTER_REPO`.

Managing organization secrets with `gh` requires organization-owner permissions and the `admin:org` OAuth scope:

```bash
gh auth refresh -s admin:org
```

Security note: org-level selected-repo secrets reduce sprawl and make rotation easier, but any workflow in an allowed repository can still access the secret. Protect `.github/workflows/**` with CODEOWNERS/reviews for repositories that can access Codex OAuth.

Repository collaborators normally cannot read Actions secret values in the GitHub UI. The practical risk is workflow-code access: anyone who can modify a workflow on a branch where secrets are available can try to exfiltrate secrets in CI. For Codex OAuth, use one of these controls:

- Prefer org-level selected-repository secrets for teams, scoped only to the repositories that need review.
- Protect `.github/workflows/**` with CODEOWNERS and required reviews.
- Skip secret-backed review for fork PRs, which the installer does by default.
- Use OpenAI API-key mode for shared team automation if you do not want to store a personal ChatGPT OAuth session.

## Identity modes

| Mode                  | Comment author              | Best for                                                    | Tradeoff                                                              |
| --------------------- | --------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| `GitHub App bot`      | `review-router-... [bot]` | Production repos, cleaner audit trail, branded bot identity | Creates a user-owned GitHub App and requires installation on the repo |
| `github-actions[bot]` | `github-actions[bot]`       | Fast setup, tests, small teams                              | Default name/avatar, weaker identity/audit separation                 |

Recommendation:

- Use `GitHub App bot` for production repositories.
- Use `github-actions[bot]` when you want the simplest setup and do not care about comment branding.

## Auth modes

### Codex ChatGPT subscription

Uses the local Codex CLI OAuth session from `~/.codex/auth.json` and stores it in the target repo as `CODEX_AUTH_JSON`.

By default, the installer does not copy `~/.codex/config.toml`. Local Codex config can contain plugins, hooks, or UI-specific settings that are noisy and expensive in CI. If you intentionally need it, opt in:

```bash
REVIEW_ROUTER_INCLUDE_CODEX_CONFIG=1 bash scripts/install.sh
```

The generated workflow installs the official Codex CLI and runs a headless smoke check before review:

```yaml
- name: Verify Codex OAuth headless mode
  run: |
    codex exec --model "$CODEX_MODEL" --sandbox read-only --ephemeral --ignore-user-config -c approval_policy=never -c model_reasoning_effort='"low"' --output-last-message /tmp/codex-smoke.txt "Respond with exactly: codex-oauth-ok"
    grep -q "codex-oauth-ok" /tmp/codex-smoke.txt
```

Use this only in trusted automation. Do not put personal Codex OAuth credentials into public/open-source repos where untrusted workflow changes can access secrets. GitHub does not expose repository secrets to fork PR workflows by default, and the generated workflow skips fork PRs by default.

Default Codex model:

```text
gpt-5.5
```

The installer stores it as `REVIEW_CODEX_MODEL`, and the action converts it internally to `codex/<model>`. Override it with `REVIEW_ROUTER_CODEX_MODEL`, for example `REVIEW_ROUTER_CODEX_MODEL=gpt-5.4`.

### OpenAI API key

Stores `OPENAI_API_KEY` and uses the Codex CLI in API-key mode. This is better for shared/team automation when you do not want to store a personal ChatGPT OAuth session.

### OpenRouter API key

Stores `OPENROUTER_API_KEY` and configures OpenRouter provider mode.

## Review presets

| Preset    | Behavior                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------- |
| `safe`    | Major+ inline comments, max 5 inline comments, one Codex model, AST and security enabled, Codex effort `medium` |
| `blocking` | Same review depth as `safe`, but fails CI on Major+ findings |
| `strict`  | Minor+ inline comments, max 10 inline comments, one Codex model, graph context enabled, Codex effort `high` |
| `minimal` | Major+ inline comments, max 3 inline comments, AST disabled, security enabled, Codex effort `low` |

Safe defaults include:

```text
INLINE_MAX_COMMENTS=5
INLINE_MIN_SEVERITY=major
MIN_CONFIDENCE=0.6
CONSENSUS_REQUIRED_FOR_CRITICAL=false
FAIL_ON_NO_HEALTHY_PROVIDERS=true
FAIL_ON_CRITICAL=true
FAIL_ON_MAJOR=false
UPDATE_PR_DESCRIPTION=true
PROVIDER_MAX_PARALLEL=1
CODEX_REASONING_EFFORT=medium
CODEX_AGENTIC_CONTEXT=true
```

`CODEX_AGENTIC_CONTEXT=true` lets Codex inspect related repository files in a read-only sandbox before returning strict JSON findings. It does not grant write access.

`UPDATE_PR_DESCRIPTION=true` appends or updates only the `ReviewRouter` generated block in the pull request body. Author-written PR text stays above the generated block. `FAIL_ON_CRITICAL=true` and `FAIL_ON_MAJOR=false` make the check fail only for critical findings by default. Set `FAIL_ON_MAJOR=true` for stricter blocking, or set advanced `FAIL_ON_SEVERITY=off` if the reviewer should be informational only.

For production repositories, prefer:

```bash
REVIEW_ROUTER_PRESET=blocking
```

This keeps the safer `safe` review depth, but makes Major findings block the pull request. Use `safe` during rollout if you want advisory comments first.

## Non-interactive examples

### GitHub App bot + Codex subscription

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/multi-provider-code-review/main/scripts/install.sh | env \
  REVIEW_ROUTER_REPO=owner/repo \
  REVIEW_ROUTER_IDENTITY=app \
  REVIEW_ROUTER_AUTH=codex \
  REVIEW_ROUTER_PRESET=safe \
  REVIEW_ROUTER_YES=1 \
  bash
```

### Blocking production gate

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/multi-provider-code-review/main/scripts/install.sh | env \
  REVIEW_ROUTER_REPO=owner/repo \
  REVIEW_ROUTER_IDENTITY=app \
  REVIEW_ROUTER_AUTH=codex \
  REVIEW_ROUTER_PRESET=blocking \
  REVIEW_ROUTER_YES=1 \
  bash
```

`blocking` fails the `ReviewRouter / review` check for Major and Critical findings. Mark this check as required in branch protection if you want it to gate merges.

### GitHub App bot + Codex subscription using org selected-repo secrets

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/multi-provider-code-review/main/scripts/install.sh | env \
  REVIEW_ROUTER_REPO=your-org/repo-a \
  REVIEW_ROUTER_SECRET_SCOPE=org \
  REVIEW_ROUTER_ORG=your-org \
  REVIEW_ROUTER_ORG_SECRET_REPOS=repo-a \
  REVIEW_ROUTER_IDENTITY=app \
  REVIEW_ROUTER_AUTH=codex \
  REVIEW_ROUTER_PRESET=safe \
  REVIEW_ROUTER_YES=1 \
  bash
```

### github-actions[bot] + OpenAI API key

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/multi-provider-code-review/main/scripts/install.sh | env \
  REVIEW_ROUTER_REPO=owner/repo \
  REVIEW_ROUTER_IDENTITY=actions \
  REVIEW_ROUTER_AUTH=openai \
  REVIEW_ROUTER_OPENAI_API_KEY=sk-... \
  REVIEW_ROUTER_PRESET=safe \
  REVIEW_ROUTER_YES=1 \
  bash
```

### github-actions[bot] + OpenRouter API key

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/multi-provider-code-review/main/scripts/install.sh | env \
  REVIEW_ROUTER_REPO=owner/repo \
  REVIEW_ROUTER_IDENTITY=actions \
  REVIEW_ROUTER_AUTH=openrouter \
  REVIEW_ROUTER_OPENROUTER_API_KEY=sk-or-... \
  REVIEW_ROUTER_PRESET=minimal \
  REVIEW_ROUTER_YES=1 \
  bash
```

## Local dry-run / e2e mode

For tests, the installer can write the workflow into a local directory without touching GitHub:

```bash
TMP_DIR=$(mktemp -d)
REVIEW_ROUTER_NON_INTERACTIVE=1 \
REVIEW_ROUTER_LOCAL_ONLY=1 \
REVIEW_ROUTER_SKIP_GH_CHECK=1 \
REVIEW_ROUTER_REPO=owner/repo \
REVIEW_ROUTER_IDENTITY=actions \
REVIEW_ROUTER_AUTH=openrouter \
REVIEW_ROUTER_OPENROUTER_API_KEY=dummy \
REVIEW_ROUTER_WORKDIR="$TMP_DIR" \
bash scripts/install.sh

cat "$TMP_DIR/.github/workflows/review-router.yml"
```

## Workflow defaults

The generated workflow currently uses:

- `actions/checkout@v6`
- `actions/setup-node@v6` when Codex CLI is required
- Node `24`
- `@openai/codex@0.125.0`
- `actions/create-github-app-token@v3` in GitHub App mode

These versions were checked on 2026-04-30 against the current package/action releases.

## Why no hosted App yet

This v1 installer creates user-owned GitHub Apps. That means each user or org controls its own App, private key, installation, and billing/auth secrets. A single shared branded SaaS App would require a backend service to store installation state and mint tokens safely; that is a separate v2 architecture.
