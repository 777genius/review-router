# ai-robot-review installer

`ai-robot-review` can be installed into any GitHub repository with a single `curl | bash` command. The installer writes a pull request workflow, stores the required repository secrets/variables, and opens a setup PR instead of pushing directly to the default branch.

```bash
curl -fsSL https://raw.githubusercontent.com/777genius/multi-provider-code-review/fix/codex-oauth-exec/scripts/install.sh | bash
```

The installer supports macOS and Linux shells first. It requires `gh`, `git`, and `curl`. GitHub App manifest setup uses `python3` when available; without `python3`, the installer prints manual App setup instructions.

## What it creates

- `.github/workflows/ai-robot-review.yml`
- Repository variables such as `REVIEW_PROVIDERS` and `REVIEW_SYNTHESIS_MODEL`
- Repository secrets for the selected auth mode
- Branch `ai-robot-review/setup`
- A setup PR with the workflow change

Secrets are never deleted automatically. Existing secrets and variables are overwritten only after confirmation.

## Identity modes

| Mode | Comment author | Best for | Tradeoff |
| --- | --- | --- | --- |
| `GitHub App bot` | `ai-robot-review-... [bot]` | Production repos, cleaner audit trail, branded bot identity | Creates a user-owned GitHub App and requires installation on the repo |
| `github-actions[bot]` | `github-actions[bot]` | Fast setup, tests, small teams | Default name/avatar, weaker identity/audit separation |

Recommendation:

- Use `GitHub App bot` for production repositories.
- Use `github-actions[bot]` when you want the simplest setup and do not care about comment branding.

## Auth modes

### Codex ChatGPT subscription

Uses the local Codex CLI OAuth session from `~/.codex/auth.json` and stores it in the target repo as `CODEX_AUTH_JSON`. If `~/.codex/config.toml` exists, it is stored as `CODEX_CONFIG_TOML`.

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

| Preset | Behavior |
| --- | --- |
| `safe` | Major+ inline comments, max 5 inline comments, AST and security enabled, Codex effort `medium` |
| `strict` | Minor+ inline comments, max 10 inline comments, graph context enabled, Codex effort `high` |
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
AI_ROBOT_REVIEW_REPO=owner/repo \
AI_ROBOT_REVIEW_IDENTITY=app \
AI_ROBOT_REVIEW_AUTH=codex \
AI_ROBOT_REVIEW_PRESET=safe \
AI_ROBOT_REVIEW_YES=1 \
bash scripts/install.sh
```

### github-actions[bot] + OpenAI API key

```bash
AI_ROBOT_REVIEW_REPO=owner/repo \
AI_ROBOT_REVIEW_IDENTITY=actions \
AI_ROBOT_REVIEW_AUTH=openai \
AI_ROBOT_REVIEW_OPENAI_API_KEY=sk-... \
AI_ROBOT_REVIEW_PRESET=safe \
AI_ROBOT_REVIEW_YES=1 \
bash scripts/install.sh
```

### github-actions[bot] + OpenRouter API key

```bash
AI_ROBOT_REVIEW_REPO=owner/repo \
AI_ROBOT_REVIEW_IDENTITY=actions \
AI_ROBOT_REVIEW_AUTH=openrouter \
AI_ROBOT_REVIEW_OPENROUTER_API_KEY=sk-or-... \
AI_ROBOT_REVIEW_PRESET=minimal \
AI_ROBOT_REVIEW_YES=1 \
bash scripts/install.sh
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
