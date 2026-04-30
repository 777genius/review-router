# ai-robot-review installer

`ai-robot-review` can be installed into any GitHub repository with a single `curl | bash` command. The installer writes a pull request workflow, stores the required repository secrets/variables, and opens a setup PR instead of pushing directly to the default branch.

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/multi-provider-code-review/fix/codex-oauth-exec/scripts/install.sh | bash
```

The installer supports macOS and Linux shells first. It requires `gh`, `git`, and `curl`. GitHub App manifest setup uses `python3` when available; without `python3`, the installer prints manual App setup instructions.

## Quick start

### One repository

Fast setup for a single repository. Secrets and variables are stored on that repository only.

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/multi-provider-code-review/fix/codex-oauth-exec/scripts/install.sh | env \
  AI_ROBOT_REVIEW_REPO=owner/repo \
  AI_ROBOT_REVIEW_SECRET_SCOPE=repo \
  AI_ROBOT_REVIEW_IDENTITY=actions \
  AI_ROBOT_REVIEW_AUTH=codex \
  AI_ROBOT_REVIEW_PRESET=safe \
  bash
```

Use `AI_ROBOT_REVIEW_IDENTITY=app` instead of `actions` if you want comments from a dedicated GitHub App bot instead of `github-actions[bot]`.

### Organization selected repositories

Recommended team setup. Secrets and variables live at organization level, but only selected repositories can access them.

For smoke tests, use a disposable test organization/repository or `AI_ROBOT_REVIEW_DRY_RUN=1`. Do not test org-level secrets against a production organization unless you intend to store real secrets there.

```bash
gh auth refresh -s admin:org

curl -fsSL https://raw.githubusercontent.com/777genius/multi-provider-code-review/fix/codex-oauth-exec/scripts/install.sh | env \
  AI_ROBOT_REVIEW_REPO=your-org/repo-a \
  AI_ROBOT_REVIEW_SECRET_SCOPE=org \
  AI_ROBOT_REVIEW_ORG=your-org \
  AI_ROBOT_REVIEW_ORG_SECRET_REPOS=repo-a,repo-b \
  AI_ROBOT_REVIEW_IDENTITY=app \
  AI_ROBOT_REVIEW_AUTH=codex \
  AI_ROBOT_REVIEW_PRESET=safe \
  bash
```

This uses `gh secret set --org your-org --repos repo-a,repo-b --app actions`, not `--visibility all`.

To run a real org e2e smoke test against a disposable organization without granting `delete_repo`:

```bash
gh auth refresh -s admin:org
AI_ROBOT_REVIEW_E2E_ORG=your-test-org AI_ROBOT_REVIEW_E2E_SKIP_DELETE=1 bash scripts/e2e-org-installer-smoke.sh
```

The smoke script creates a temporary private repo, installs org-level selected-repo secrets/variables, verifies `visibility=selected` and `numSelectedRepos=1`, verifies the setup PR/workflow, then deletes the smoke secrets/variables. With `AI_ROBOT_REVIEW_E2E_SKIP_DELETE=1`, it leaves the temporary repo for manual deletion so the CLI does not need `delete_repo`.

### API key instead of Codex OAuth

For teams that do not want to store a personal Codex OAuth session:

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/multi-provider-code-review/fix/codex-oauth-exec/scripts/install.sh | env \
  AI_ROBOT_REVIEW_REPO=owner/repo \
  AI_ROBOT_REVIEW_SECRET_SCOPE=repo \
  AI_ROBOT_REVIEW_IDENTITY=actions \
  AI_ROBOT_REVIEW_AUTH=openai \
  AI_ROBOT_REVIEW_OPENAI_API_KEY=sk-... \
  AI_ROBOT_REVIEW_PRESET=safe \
  bash
```

## What it creates

- `.github/workflows/ai-robot-review.yml`
- Repository or organization variables such as `REVIEW_PROVIDERS` and `REVIEW_SYNTHESIS_MODEL`
- Repository or organization secrets for the selected auth mode
- Branch `ai-robot-review/setup`
- A setup PR with the workflow change

Secrets are never deleted automatically. Existing secrets and variables are overwritten only after confirmation.

## Secret scopes

| Scope  | Where secrets live                     | Repository access          | Best for                                                               |
| ------ | -------------------------------------- | -------------------------- | ---------------------------------------------------------------------- |
| `repo` | Target repository                      | Target repository only     | Simple setup, personal repos, small private repos                      |
| `org`  | Organization Actions secrets/variables | Selected repositories only | Teams that want one central secret with explicit repository allow-list |

`org` scope always uses selected repositories. It does not grant access to every repository in the organization.

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/multi-provider-code-review/fix/codex-oauth-exec/scripts/install.sh | env \
  AI_ROBOT_REVIEW_REPO=your-org/repo-a \
  AI_ROBOT_REVIEW_SECRET_SCOPE=org \
  AI_ROBOT_REVIEW_ORG=your-org \
  AI_ROBOT_REVIEW_ORG_SECRET_REPOS=repo-a,repo-b \
  bash
```

If `AI_ROBOT_REVIEW_ORG_SECRET_REPOS` is not set, the installer grants access only to the target repo name from `AI_ROBOT_REVIEW_REPO`.

Managing organization secrets with `gh` requires organization-owner permissions and the `admin:org` OAuth scope:

```bash
gh auth refresh -s admin:org
```

Security note: org-level selected-repo secrets reduce sprawl and make rotation easier, but any workflow in an allowed repository can still access the secret. Protect `.github/workflows/**` with CODEOWNERS/reviews for repositories that can access Codex OAuth.

## Identity modes

| Mode                  | Comment author              | Best for                                                    | Tradeoff                                                              |
| --------------------- | --------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| `GitHub App bot`      | `ai-robot-review-... [bot]` | Production repos, cleaner audit trail, branded bot identity | Creates a user-owned GitHub App and requires installation on the repo |
| `github-actions[bot]` | `github-actions[bot]`       | Fast setup, tests, small teams                              | Default name/avatar, weaker identity/audit separation                 |

Recommendation:

- Use `GitHub App bot` for production repositories.
- Use `github-actions[bot]` when you want the simplest setup and do not care about comment branding.

## Auth modes

### Codex ChatGPT subscription

Uses the local Codex CLI OAuth session from `~/.codex/auth.json` and stores it in the target repo as `CODEX_AUTH_JSON`.

By default, the installer does not copy `~/.codex/config.toml`. Local Codex config can contain plugins, hooks, or UI-specific settings that are noisy and expensive in CI. If you intentionally need it, opt in:

```bash
AI_ROBOT_REVIEW_INCLUDE_CODEX_CONFIG=1 bash scripts/install.sh
```

The generated workflow installs the official Codex CLI and runs a headless smoke check before review:

```yaml
- name: Verify Codex OAuth headless mode
  run: |
    codex exec --model gpt-5.4-mini -c model_reasoning_effort='"low"' --dangerously-bypass-approvals-and-sandbox --output-last-message /tmp/codex-smoke.txt "Respond with exactly: codex-oauth-ok"
    grep -q "codex-oauth-ok" /tmp/codex-smoke.txt
```

Use this only in trusted automation. Do not put personal Codex OAuth credentials into public/open-source repos where untrusted workflow changes can access secrets. GitHub does not expose repository secrets to fork PR workflows by default, and the generated workflow skips fork PRs by default.

Default Codex OAuth providers:

```text
codex/gpt-5.4-mini,codex/gpt-5.4
```

### OpenAI API key

Stores `OPENAI_API_KEY` and uses the Codex CLI in API-key mode. This is better for shared/team automation when you do not want to store a personal ChatGPT OAuth session.

### OpenRouter API key

Stores `OPENROUTER_API_KEY` and configures OpenRouter provider mode.

## Review presets

| Preset    | Behavior                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------- |
| `safe`    | Major+ inline comments, max 5 inline comments, AST and security enabled, Codex effort `medium`    |
| `strict`  | Minor+ inline comments, max 10 inline comments, graph context enabled, Codex effort `high`        |
| `minimal` | Major+ inline comments, max 3 inline comments, AST disabled, security enabled, Codex effort `low` |

Safe defaults include:

```text
INLINE_MAX_COMMENTS=5
INLINE_MIN_SEVERITY=major
MIN_CONFIDENCE=0.6
CONSENSUS_REQUIRED_FOR_CRITICAL=false
FAIL_ON_NO_HEALTHY_PROVIDERS=true
PROVIDER_MAX_PARALLEL=1
CODEX_REASONING_EFFORT=medium
```

## Non-interactive examples

### GitHub App bot + Codex subscription

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/multi-provider-code-review/fix/codex-oauth-exec/scripts/install.sh | env \
  AI_ROBOT_REVIEW_REPO=owner/repo \
  AI_ROBOT_REVIEW_IDENTITY=app \
  AI_ROBOT_REVIEW_AUTH=codex \
  AI_ROBOT_REVIEW_PRESET=safe \
  AI_ROBOT_REVIEW_YES=1 \
  bash
```

### GitHub App bot + Codex subscription using org selected-repo secrets

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/multi-provider-code-review/fix/codex-oauth-exec/scripts/install.sh | env \
  AI_ROBOT_REVIEW_REPO=your-org/repo-a \
  AI_ROBOT_REVIEW_SECRET_SCOPE=org \
  AI_ROBOT_REVIEW_ORG=your-org \
  AI_ROBOT_REVIEW_ORG_SECRET_REPOS=repo-a \
  AI_ROBOT_REVIEW_IDENTITY=app \
  AI_ROBOT_REVIEW_AUTH=codex \
  AI_ROBOT_REVIEW_PRESET=safe \
  AI_ROBOT_REVIEW_YES=1 \
  bash
```

### github-actions[bot] + OpenAI API key

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/multi-provider-code-review/fix/codex-oauth-exec/scripts/install.sh | env \
  AI_ROBOT_REVIEW_REPO=owner/repo \
  AI_ROBOT_REVIEW_IDENTITY=actions \
  AI_ROBOT_REVIEW_AUTH=openai \
  AI_ROBOT_REVIEW_OPENAI_API_KEY=sk-... \
  AI_ROBOT_REVIEW_PRESET=safe \
  AI_ROBOT_REVIEW_YES=1 \
  bash
```

### github-actions[bot] + OpenRouter API key

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/multi-provider-code-review/fix/codex-oauth-exec/scripts/install.sh | env \
  AI_ROBOT_REVIEW_REPO=owner/repo \
  AI_ROBOT_REVIEW_IDENTITY=actions \
  AI_ROBOT_REVIEW_AUTH=openrouter \
  AI_ROBOT_REVIEW_OPENROUTER_API_KEY=sk-or-... \
  AI_ROBOT_REVIEW_PRESET=minimal \
  AI_ROBOT_REVIEW_YES=1 \
  bash
```

## Local dry-run / e2e mode

For tests, the installer can write the workflow into a local directory without touching GitHub:

```bash
TMP_DIR=$(mktemp -d)
AI_ROBOT_REVIEW_NON_INTERACTIVE=1 \
AI_ROBOT_REVIEW_LOCAL_ONLY=1 \
AI_ROBOT_REVIEW_SKIP_GH_CHECK=1 \
AI_ROBOT_REVIEW_REPO=owner/repo \
AI_ROBOT_REVIEW_IDENTITY=actions \
AI_ROBOT_REVIEW_AUTH=openrouter \
AI_ROBOT_REVIEW_OPENROUTER_API_KEY=dummy \
AI_ROBOT_REVIEW_WORKDIR="$TMP_DIR" \
bash scripts/install.sh

cat "$TMP_DIR/.github/workflows/ai-robot-review.yml"
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
