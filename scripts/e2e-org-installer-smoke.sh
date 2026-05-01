#!/usr/bin/env bash
# Real org-level smoke test for review-router installer.
# Creates a disposable repo in an existing organization, installs org-scoped
# selected-repo secrets/variables, verifies access policy, then cleans up.

set -Eeuo pipefail

ORG="${REVIEW_ROUTER_E2E_ORG:-${1:-}}"
ACTION_REF="${REVIEW_ROUTER_ACTION_REF:-777genius/multi-provider-code-review@main}"
INSTALL_SCRIPT_URL="${REVIEW_ROUTER_INSTALL_SCRIPT_URL:-https://raw.githubusercontent.com/777genius/multi-provider-code-review/main/scripts/install.sh}"
REPO_PREFIX="${REVIEW_ROUTER_E2E_REPO_PREFIX:-review-router-org-e2e}"
KEEP_REPO="${REVIEW_ROUTER_E2E_KEEP_REPO:-0}"
SKIP_DELETE="${REVIEW_ROUTER_E2E_SKIP_DELETE:-0}"
REPO_NAME="${REPO_PREFIX}-$(date +%s)"
REPO="$ORG/$REPO_NAME"
WORKDIR=""
CREATED_REPO=0

log() { printf '%s\n' "$*"; }
fatal() { printf 'ERROR %s\n' "$*" >&2; exit 1; }
is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|y|Y) return 0 ;;
    *) return 1 ;;
  esac
}
require_cmd() { command -v "$1" >/dev/null 2>&1 || fatal "Missing required command: $1"; }

cleanup() {
  status=$?
  set +e
  if [ -n "$ORG" ]; then
    gh secret delete OPENROUTER_API_KEY --org "$ORG" --app actions >/dev/null 2>&1
    gh variable delete REVIEW_AUTH_MODE --org "$ORG" >/dev/null 2>&1
    gh variable delete REVIEW_PROVIDERS --org "$ORG" >/dev/null 2>&1
    gh variable delete REVIEW_SYNTHESIS_MODEL --org "$ORG" >/dev/null 2>&1
  fi
  if [ "$CREATED_REPO" = "1" ] && ! is_true "$KEEP_REPO" && ! is_true "$SKIP_DELETE"; then
    gh repo delete "$REPO" --yes >/dev/null 2>&1
  fi
  [ -z "$WORKDIR" ] || rm -rf "$WORKDIR"
  exit "$status"
}
trap cleanup EXIT

[ -n "$ORG" ] || fatal "Usage: REVIEW_ROUTER_E2E_ORG=your-org bash scripts/e2e-org-installer-smoke.sh"
require_cmd gh
require_cmd git
require_cmd curl
require_cmd base64
require_cmd jq

gh auth status >/dev/null 2>&1 || fatal "gh is not authenticated. Run: gh auth login"
owner_type="$(gh api "users/$ORG" --jq .type 2>/dev/null || true)"
[ "$owner_type" = "Organization" ] || fatal "$ORG is not visible as an organization to this gh account"
if ! gh auth status 2>&1 | grep -q 'admin:org'; then
  fatal "gh token needs admin:org. Run: gh auth refresh -s admin:org"
fi
if ! is_true "$KEEP_REPO" && ! is_true "$SKIP_DELETE" && ! gh auth status 2>&1 | grep -q 'delete_repo'; then
  fatal "gh token needs delete_repo for automatic repo cleanup. To avoid this broad scope, rerun with REVIEW_ROUTER_E2E_SKIP_DELETE=1 and delete the temporary repo manually."
fi

existing_secret="$(gh secret list --org "$ORG" --app actions --json name --jq '.[] | select(.name=="OPENROUTER_API_KEY") | .name')"
[ -z "$existing_secret" ] || fatal "Org secret OPENROUTER_API_KEY already exists in $ORG; refusing to overwrite it in smoke test"
for variable_name in REVIEW_AUTH_MODE REVIEW_PROVIDERS REVIEW_SYNTHESIS_MODEL; do
  existing_variable="$(gh variable list --org "$ORG" --json name --jq ".[] | select(.name==\"$variable_name\") | .name")"
  [ -z "$existing_variable" ] || fatal "Org variable $variable_name already exists in $ORG; refusing to overwrite it in smoke test"
done

WORKDIR="$(mktemp -d)"
(
  cd "$WORKDIR"
  git init -b main >/dev/null
  cat > README.md <<README
# $REPO_NAME

Disposable review-router organization installer smoke test.
README
  git add README.md
  git commit -m "chore: initial org installer smoke repo" >/dev/null
  gh repo create "$REPO" --private --source=. --remote=origin --push >/dev/null
)
CREATED_REPO=1
log "Created disposable repo: $REPO"

curl -fsSL "$INSTALL_SCRIPT_URL" | env \
  REVIEW_ROUTER_NON_INTERACTIVE=1 \
  REVIEW_ROUTER_YES=1 \
  REVIEW_ROUTER_REPO="$REPO" \
  REVIEW_ROUTER_SECRET_SCOPE=org \
  REVIEW_ROUTER_ORG="$ORG" \
  REVIEW_ROUTER_ORG_SECRET_REPOS="$REPO_NAME" \
  REVIEW_ROUTER_IDENTITY=actions \
  REVIEW_ROUTER_AUTH=openrouter \
  REVIEW_ROUTER_OPENROUTER_API_KEY=dummy-openrouter-org-e2e \
  REVIEW_ROUTER_PRESET=safe \
  REVIEW_ROUTER_ACTION_REF="$ACTION_REF" \
  bash

secret_json="$(gh secret list --org "$ORG" --app actions --json name,visibility,numSelectedRepos --jq '.[] | select(.name=="OPENROUTER_API_KEY")')"
[ -n "$secret_json" ] || fatal "OPENROUTER_API_KEY org secret was not created"
secret_visibility="$(printf '%s' "$secret_json" | jq -r .visibility)"
secret_repo_count="$(printf '%s' "$secret_json" | jq -r .numSelectedRepos)"
[ "$secret_visibility" = "selected" ] || fatal "OPENROUTER_API_KEY visibility is $secret_visibility, expected selected"
[ "$secret_repo_count" = "1" ] || fatal "OPENROUTER_API_KEY selected repo count is $secret_repo_count, expected 1"

providers_json="$(gh variable list --org "$ORG" --json name,value,visibility,numSelectedRepos --jq '.[] | select(.name=="REVIEW_PROVIDERS")')"
[ -n "$providers_json" ] || fatal "REVIEW_PROVIDERS org variable was not created"
providers_visibility="$(printf '%s' "$providers_json" | jq -r .visibility)"
providers_repo_count="$(printf '%s' "$providers_json" | jq -r .numSelectedRepos)"
providers_value="$(printf '%s' "$providers_json" | jq -r .value)"
[ "$providers_visibility" = "selected" ] || fatal "REVIEW_PROVIDERS visibility is $providers_visibility, expected selected"
[ "$providers_repo_count" = "1" ] || fatal "REVIEW_PROVIDERS selected repo count is $providers_repo_count, expected 1"
[ "$providers_value" = "openrouter/free" ] || fatal "REVIEW_PROVIDERS value is $providers_value"

pr_url="$(gh pr list --repo "$REPO" --head review-router/setup --state open --json url --jq '.[0].url')"
[ -n "$pr_url" ] || fatal "Setup PR was not opened"
workflow="$(gh api "repos/$REPO/contents/.github/workflows/review-router.yml?ref=review-router/setup" --jq .content | base64 --decode)"
# shellcheck disable=SC2016
printf '%s' "$workflow" | grep -q 'OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}' || fatal "Workflow does not reference OPENROUTER_API_KEY"
# shellcheck disable=SC2016
printf '%s' "$workflow" | grep -q 'REVIEW_PROVIDERS: ${{ vars.REVIEW_PROVIDERS }}' || fatal "Workflow does not reference REVIEW_PROVIDERS"
! printf '%s' "$workflow" | grep -q 'CODEX_MODEL' || fatal "OpenRouter workflow should not set CODEX_MODEL"
printf '%s' "$workflow" | grep -q 'fork != true' || fatal "Workflow does not skip fork PR secrets"

log "Org selected-repo smoke passed: $ORG -> $REPO_NAME"
log "Setup PR: $pr_url"
if is_true "$KEEP_REPO"; then
  log "Keeping repo because REVIEW_ROUTER_E2E_KEEP_REPO=1"
elif is_true "$SKIP_DELETE"; then
  log "Cleanup removed org smoke secrets/variables. Temporary repo was kept because REVIEW_ROUTER_E2E_SKIP_DELETE=1"
else
  log "Cleanup will remove org smoke secrets/variables and repo"
fi
