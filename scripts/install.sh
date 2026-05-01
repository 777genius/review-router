#!/usr/bin/env bash
# ai-robot-review installer
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/777genius/multi-provider-code-review/main/scripts/install.sh | bash

set -Eeuo pipefail

PRODUCT_NAME="ai-robot-review"
DEFAULT_ACTION_REF="777genius/multi-provider-code-review@main"
DEFAULT_BRANCH_NAME="ai-robot-review/setup"
WORKFLOW_PATH=".github/workflows/ai-robot-review.yml"
CODEX_NPM_PACKAGE="@openai/codex@0.125.0"
DEFAULT_CODEX_MODEL="gpt-5.5"
OPENROUTER_DEFAULT_PROVIDERS="openrouter/free"
OPENROUTER_DEFAULT_SYNTHESIS="openrouter/free"

ACTION_REF="${AI_ROBOT_REVIEW_ACTION_REF:-$DEFAULT_ACTION_REF}"
INSTALL_BRANCH="${AI_ROBOT_REVIEW_BRANCH:-$DEFAULT_BRANCH_NAME}"
TARGET_REPO="${AI_ROBOT_REVIEW_REPO:-}"
SECRET_SCOPE="${AI_ROBOT_REVIEW_SECRET_SCOPE:-}"
ORG_NAME="${AI_ROBOT_REVIEW_ORG:-}"
ORG_SELECTED_REPOS="${AI_ROBOT_REVIEW_ORG_SECRET_REPOS:-}"
IDENTITY_MODE="${AI_ROBOT_REVIEW_IDENTITY:-}"
AUTH_MODE="${AI_ROBOT_REVIEW_AUTH:-}"
PRESET="${AI_ROBOT_REVIEW_PRESET:-}"
CODEX_MODEL="${AI_ROBOT_REVIEW_CODEX_MODEL:-$DEFAULT_CODEX_MODEL}"
DRY_RUN="${AI_ROBOT_REVIEW_DRY_RUN:-0}"
NON_INTERACTIVE="${AI_ROBOT_REVIEW_NON_INTERACTIVE:-0}"
LOCAL_ONLY="${AI_ROBOT_REVIEW_LOCAL_ONLY:-0}"
SKIP_GH_CHECK="${AI_ROBOT_REVIEW_SKIP_GH_CHECK:-0}"
SKIP_APP_CREATE="${AI_ROBOT_REVIEW_SKIP_APP_CREATE:-0}"
YES="${AI_ROBOT_REVIEW_YES:-0}"
NO_BROWSER="${AI_ROBOT_REVIEW_NO_BROWSER:-0}"
WORKDIR_OVERRIDE="${AI_ROBOT_REVIEW_WORKDIR:-}"

if [ -t 1 ]; then
  BOLD='\033[1m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  RED='\033[0;31m'
  BLUE='\033[0;34m'
  NC='\033[0m'
else
  BOLD=''
  GREEN=''
  YELLOW=''
  RED=''
  BLUE=''
  NC=''
fi

log() { printf '%b\n' "$*"; }
info() { log "${BLUE}==>${NC} $*"; }
ok() { log "${GREEN}OK${NC} $*"; }
warn() { log "${YELLOW}WARN${NC} $*"; }
fatal() { log "${RED}ERROR${NC} $*" >&2; exit 1; }

is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|y|Y) return 0 ;;
    *) return 1 ;;
  esac
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fatal "Missing required command: $1"
}

run() {
  if is_true "$DRY_RUN"; then
    log "[dry-run] $*"
  else
    "$@"
  fi
}

validate_repo() {
  case "$1" in
    */*) ;;
    *) fatal "Repository must be in owner/repo form. Got: $1" ;;
  esac
  printf '%s' "$1" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || fatal "Invalid repository name: $1"
}

repo_owner() { printf '%s' "$1" | cut -d/ -f1; }
repo_name() { printf '%s' "$1" | cut -d/ -f2-; }

normalize_secret_scope_env() {
  case "$SECRET_SCOPE" in
    organization|org-level|org_selected|org-selected) SECRET_SCOPE="org" ;;
    repository|repo-level|repo_selected|repo-selected) SECRET_SCOPE="repo" ;;
  esac
}

normalize_selected_repos() {
  raw_repos="$1"
  normalized=""
  old_ifs="$IFS"
  IFS=','
  for item in $raw_repos; do
    repo="$(printf '%s' "$item" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [ -n "$repo" ] || continue
    case "$repo" in
      */*)
        repo_owner_part="${repo%%/*}"
        repo_name_part="${repo#*/}"
        if [ "$repo_owner_part" != "$ORG_NAME" ]; then
          IFS="$old_ifs"
          fatal "Org selected repo $repo must belong to org $ORG_NAME"
        fi
        repo="$repo_name_part"
        ;;
    esac
    printf '%s' "$repo" | grep -Eq '^[A-Za-z0-9_.-]+$' || {
      IFS="$old_ifs"
      fatal "Invalid selected repository name for org secret: $repo"
    }
    if [ -n "$normalized" ]; then
      normalized="$normalized,$repo"
    else
      normalized="$repo"
    fi
  done
  IFS="$old_ifs"
  [ -n "$normalized" ] || fatal "At least one selected repository is required for org-level secrets"
  printf '%s' "$normalized"
}

normalize_remote_repo() {
  remote="$1"
  remote="${remote#git@github.com:}"
  remote="${remote#https://github.com/}"
  remote="${remote#http://github.com/}"
  remote="${remote%.git}"
  case "$remote" in
    */*) printf '%s' "$remote" ;;
    *) return 1 ;;
  esac
}

detect_repo() {
  if [ -n "$TARGET_REPO" ]; then
    validate_repo "$TARGET_REPO"
    return
  fi

  if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    remote_url="$(git config --get remote.origin.url || true)"
    if [ -n "$remote_url" ] && detected="$(normalize_remote_repo "$remote_url")"; then
      TARGET_REPO="$detected"
      validate_repo "$TARGET_REPO"
      return
    fi
  fi

  if command -v gh >/dev/null 2>&1 && ! is_true "$SKIP_GH_CHECK"; then
    detected="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
    if [ -n "$detected" ]; then
      TARGET_REPO="$detected"
      validate_repo "$TARGET_REPO"
      return
    fi
  fi

  prompt_text "TARGET_REPO" "Target GitHub repository (owner/repo)" ""
  validate_repo "$TARGET_REPO"
}

prompt_text() {
  var_name="$1"
  label="$2"
  default_value="$3"
  current_value="$(eval "printf '%s' \"\${$var_name:-}\"")"

  if [ -n "$current_value" ]; then
    return
  fi
  if is_true "$NON_INTERACTIVE"; then
    if [ -n "$default_value" ]; then
      eval "$var_name=\"$default_value\""
      return
    fi
    fatal "$var_name is required in non-interactive mode"
  fi

  if [ -n "$default_value" ]; then
    printf '%s [%s]: ' "$label" "$default_value" >&2
  else
    printf '%s: ' "$label" >&2
  fi
  IFS= read -r answer
  if [ -z "$answer" ]; then
    answer="$default_value"
  fi
  [ -n "$answer" ] || fatal "$label is required"
  eval "$var_name=\"$answer\""
}

prompt_secret() {
  var_name="$1"
  label="$2"
  current_value="$(eval "printf '%s' \"\${$var_name:-}\"")"

  if [ -n "$current_value" ]; then
    return
  fi
  if is_true "$NON_INTERACTIVE"; then
    fatal "$var_name is required in non-interactive mode"
  fi

  printf '%s: ' "$label" >&2
  stty_state="$(stty -g 2>/dev/null || true)"
  stty -echo 2>/dev/null || true
  IFS= read -r answer
  [ -z "$stty_state" ] || stty "$stty_state" 2>/dev/null || true
  printf '\n' >&2
  [ -n "$answer" ] || fatal "$label is required"
  eval "$var_name=\"$answer\""
}

choose() {
  var_name="$1"
  prompt="$2"
  default_value="$3"
  shift 3
  current_value="$(eval "printf '%s' \"\${$var_name:-}\"")"

  if [ -n "$current_value" ]; then
    validate_choice "$var_name" "$current_value" "$@"
    return
  fi
  if is_true "$NON_INTERACTIVE"; then
    eval "$var_name=\"$default_value\""
    return
  fi

  log ""
  log "${BOLD}$prompt${NC}"
  i=1
  for option in "$@"; do
    label="${option%%:*}"
    description="${option#*:}"
    log "  $i) $label - $description"
    i=$((i + 1))
  done
  printf 'Choose [%s]: ' "$default_value" >&2
  IFS= read -r answer
  if [ -z "$answer" ]; then
    answer="$default_value"
  fi

  if printf '%s' "$answer" | grep -Eq '^[0-9]+$'; then
    idx=1
    for option in "$@"; do
      if [ "$idx" = "$answer" ]; then
        answer="${option%%:*}"
        break
      fi
      idx=$((idx + 1))
    done
  fi

  validate_choice "$var_name" "$answer" "$@"
  eval "$var_name=\"$answer\""
}

validate_choice() {
  var_name="$1"
  value="$2"
  shift 2
  for option in "$@"; do
    if [ "${option%%:*}" = "$value" ]; then
      return
    fi
  done
  fatal "Invalid $var_name: $value"
}

confirm() {
  message="$1"
  if is_true "$YES"; then
    return 0
  fi
  if is_true "$NON_INTERACTIVE"; then
    return 1
  fi
  printf '%s [y/N]: ' "$message" >&2
  IFS= read -r answer
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

check_prerequisites() {
  require_cmd git
  require_cmd curl
  if ! is_true "$SKIP_GH_CHECK"; then
    require_cmd gh
    gh auth status >/dev/null 2>&1 || fatal "gh is not authenticated. Run: gh auth login"
  elif ! is_true "$DRY_RUN" && ! is_true "$LOCAL_ONLY"; then
    fatal "AI_ROBOT_REVIEW_SKIP_GH_CHECK is only allowed with dry-run/local-only setup"
  fi
}

setup_secret_scope() {
  normalize_secret_scope_env
  validate_choice "SECRET_SCOPE" "$SECRET_SCOPE" \
    "repo:Repository-level secrets and variables" \
    "org:Organization-level secrets and variables, restricted to selected repositories"

  if [ "$SECRET_SCOPE" = "org" ]; then
    if [ -z "$ORG_NAME" ]; then
      ORG_NAME="$(repo_owner "$TARGET_REPO")"
    fi
    ORG_SELECTED_REPOS="$(normalize_selected_repos "${ORG_SELECTED_REPOS:-$(repo_name "$TARGET_REPO")}")"

    if ! is_true "$DRY_RUN" && ! is_true "$LOCAL_ONLY" && ! is_true "$SKIP_GH_CHECK"; then
      owner_type="$(gh api "users/$ORG_NAME" --jq .type 2>/dev/null || true)"
      [ "$owner_type" = "Organization" ] || fatal "AI_ROBOT_REVIEW_SECRET_SCOPE=org requires an organization owner. $ORG_NAME is $owner_type. Use repo scope for personal repositories."
      if ! gh auth status 2>&1 | grep -q 'admin:org'; then
        warn "Org-level secrets usually require gh admin:org scope. If setting secrets fails, run: gh auth refresh -s admin:org"
      fi
    fi
  fi
}

secret_exists() {
  if is_true "$DRY_RUN" || is_true "$SKIP_GH_CHECK"; then
    return 1
  fi
  if [ "$SECRET_SCOPE" = "org" ]; then
    gh secret list --org "$ORG_NAME" --app actions 2>/dev/null | awk '{print $1}' | grep -Fxq "$1"
  else
    gh secret list --repo "$TARGET_REPO" 2>/dev/null | awk '{print $1}' | grep -Fxq "$1"
  fi
}

variable_exists() {
  if is_true "$DRY_RUN" || is_true "$SKIP_GH_CHECK"; then
    return 1
  fi
  if [ "$SECRET_SCOPE" = "org" ]; then
    gh variable list --org "$ORG_NAME" 2>/dev/null | awk '{print $1}' | grep -Fxq "$1"
  else
    gh variable list --repo "$TARGET_REPO" 2>/dev/null | awk '{print $1}' | grep -Fxq "$1"
  fi
}

set_repo_secret_from_file() {
  name="$1"
  file_path="$2"
  [ -f "$file_path" ] || fatal "Secret file not found for $name: $file_path"

  if secret_exists "$name" && ! confirm "Secret $name already exists in $SECRET_SCOPE scope. Overwrite?"; then
    warn "Keeping existing secret $name"
    return
  fi

  if is_true "$DRY_RUN" || is_true "$SKIP_GH_CHECK"; then
    if [ "$SECRET_SCOPE" = "org" ]; then
      log "[dry-run] gh secret set $name --org $ORG_NAME --repos $ORG_SELECTED_REPOS --app actions < $file_path"
    else
      log "[dry-run] gh secret set $name --repo $TARGET_REPO < $file_path"
    fi
  else
    if [ "$SECRET_SCOPE" = "org" ]; then
      gh secret set "$name" --org "$ORG_NAME" --repos "$ORG_SELECTED_REPOS" --app actions < "$file_path" >/dev/null
      ok "Stored org secret $name for $ORG_NAME repos: $ORG_SELECTED_REPOS"
    else
      gh secret set "$name" --repo "$TARGET_REPO" < "$file_path" >/dev/null
      ok "Stored repo secret $name"
    fi
  fi
}

set_repo_secret_value() {
  name="$1"
  value="$2"
  [ -n "$value" ] || fatal "Secret $name cannot be empty"

  tmp_file="$(mktemp)"
  chmod 600 "$tmp_file"
  printf '%s' "$value" > "$tmp_file"
  set_repo_secret_from_file "$name" "$tmp_file"
  rm -f "$tmp_file"
}

set_repo_variable() {
  name="$1"
  value="$2"
  [ -n "$value" ] || fatal "Variable $name cannot be empty"

  if variable_exists "$name" && ! confirm "Variable $name already exists in $SECRET_SCOPE scope. Overwrite?"; then
    warn "Keeping existing variable $name"
    return
  fi

  if is_true "$DRY_RUN" || is_true "$SKIP_GH_CHECK"; then
    if [ "$SECRET_SCOPE" = "org" ]; then
      log "[dry-run] gh variable set $name --org $ORG_NAME --repos $ORG_SELECTED_REPOS --body <redacted>"
    else
      log "[dry-run] gh variable set $name --repo $TARGET_REPO --body <redacted>"
    fi
  else
    if [ "$SECRET_SCOPE" = "org" ]; then
      gh variable set "$name" --org "$ORG_NAME" --repos "$ORG_SELECTED_REPOS" --body "$value" >/dev/null
      ok "Stored org variable $name=$value for $ORG_NAME repos: $ORG_SELECTED_REPOS"
    else
      gh variable set "$name" --repo "$TARGET_REPO" --body "$value" >/dev/null
      ok "Stored repo variable $name=$value"
    fi
  fi
}

verify_codex_auth_file() {
  auth_file="$1"
  [ -f "$auth_file" ] || fatal "Codex auth file not found: $auth_file. Run: codex login"
  require_cmd python3
  python3 - "$auth_file" <<'PY'
import json
import sys
path = sys.argv[1]
with open(path, 'r', encoding='utf-8') as f:
    data = json.load(f)
if data.get('auth_mode') != 'chatgpt':
    raise SystemExit('auth_mode must be chatgpt')
if not ((data.get('tokens') or {}).get('refresh_token')):
    raise SystemExit('tokens.refresh_token is missing')
PY
}

setup_auth() {
  case "$AUTH_MODE" in
    codex)
      auth_file="${AI_ROBOT_REVIEW_CODEX_AUTH_FILE:-${CODEX_HOME:-$HOME/.codex}/auth.json}"
      config_file="${AI_ROBOT_REVIEW_CODEX_CONFIG_FILE:-${CODEX_HOME:-$HOME/.codex}/config.toml}"
      verify_codex_auth_file "$auth_file"
      set_repo_secret_from_file CODEX_AUTH_JSON "$auth_file"
      if is_true "${AI_ROBOT_REVIEW_INCLUDE_CODEX_CONFIG:-0}"; then
        [ -f "$config_file" ] || fatal "Codex config file not found: $config_file"
        set_repo_secret_from_file CODEX_CONFIG_TOML "$config_file"
      else
        warn "Skipping CODEX_CONFIG_TOML by default to avoid carrying local plugins/hooks into CI. Set AI_ROBOT_REVIEW_INCLUDE_CODEX_CONFIG=1 if you need it."
      fi
      set_repo_variable REVIEW_AUTH_MODE "codex-oauth"
      set_repo_variable REVIEW_CODEX_MODEL "$CODEX_MODEL"
      ;;
    openai)
      prompt_secret AI_ROBOT_REVIEW_OPENAI_API_KEY "OpenAI API key"
      set_repo_secret_value OPENAI_API_KEY "$AI_ROBOT_REVIEW_OPENAI_API_KEY"
      set_repo_variable REVIEW_AUTH_MODE "openai-api"
      set_repo_variable REVIEW_CODEX_MODEL "$CODEX_MODEL"
      ;;
    openrouter)
      prompt_secret AI_ROBOT_REVIEW_OPENROUTER_API_KEY "OpenRouter API key"
      set_repo_secret_value OPENROUTER_API_KEY "$AI_ROBOT_REVIEW_OPENROUTER_API_KEY"
      set_repo_variable REVIEW_AUTH_MODE "openrouter-api"
      set_repo_variable REVIEW_PROVIDERS "$OPENROUTER_DEFAULT_PROVIDERS"
      set_repo_variable REVIEW_SYNTHESIS_MODEL "$OPENROUTER_DEFAULT_SYNTHESIS"
      ;;
    *) fatal "Unsupported auth mode: $AUTH_MODE" ;;
  esac
}

safe_app_name() {
  owner="$(repo_owner "$TARGET_REPO")"
  repo="$(repo_name "$TARGET_REPO")"
  raw="${AI_ROBOT_REVIEW_APP_NAME:-$PRODUCT_NAME-$owner-$repo}"
  printf '%s' "$raw" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9-' '-' | sed 's/^-//; s/-$//; s/--*/-/g' | cut -c1-34
}

manual_app_setup() {
  app_name="$1"
  warn "python3 is not available; falling back to manual GitHub App setup."
  log "Create a private GitHub App named: $app_name"
  log "Permissions: Contents read, Issues write, Pull requests write. Webhooks: disabled."
  log "After creating it, generate a private key and provide the values below."
  prompt_text AI_ROBOT_REVIEW_APP_CLIENT_ID "GitHub App client ID" ""
  prompt_text AI_ROBOT_REVIEW_APP_ID "GitHub App ID" ""
  prompt_text AI_ROBOT_REVIEW_APP_SLUG "GitHub App slug" ""
  prompt_text AI_ROBOT_REVIEW_APP_PRIVATE_KEY_FILE "Path to GitHub App private key .pem" ""

  set_repo_variable REVIEW_APP_CLIENT_ID "$AI_ROBOT_REVIEW_APP_CLIENT_ID"
  set_repo_variable REVIEW_APP_ID "$AI_ROBOT_REVIEW_APP_ID"
  set_repo_variable REVIEW_APP_SLUG "$AI_ROBOT_REVIEW_APP_SLUG"
  set_repo_secret_from_file REVIEW_APP_PRIVATE_KEY "$AI_ROBOT_REVIEW_APP_PRIVATE_KEY_FILE"
}

create_github_app_with_manifest() {
  app_name="$1"
  if is_true "$DRY_RUN" || is_true "$LOCAL_ONLY" || is_true "$SKIP_APP_CREATE"; then
    warn "Skipping GitHub App creation in dry-run/local-only/test mode"
    set_repo_variable REVIEW_APP_CLIENT_ID "Iv1.local-test-client-id"
    set_repo_variable REVIEW_APP_ID "0"
    set_repo_variable REVIEW_APP_SLUG "$app_name"
    return
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    manual_app_setup "$app_name"
    return
  fi

  tmp_dir="$(mktemp -d)"
  env_file="$tmp_dir/app.env"

  info "Creating user-owned GitHub App via manifest flow"
  python3 - "$app_name" "$TARGET_REPO" "$env_file" "$NO_BROWSER" <<'PY'
import http.server
import json
import os
import secrets
import shlex
import socketserver
import subprocess
import sys
import threading
import urllib.parse
import webbrowser

app_name, target_repo, env_file, no_browser = sys.argv[1:5]
state = secrets.token_urlsafe(18)
result = {}
error = {}

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        return

    def _send(self, status, body, content_type='text/html; charset=utf-8'):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.end_headers()
        self.wfile.write(body.encode('utf-8'))

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/':
            callback = f'http://127.0.0.1:{self.server.server_address[1]}/callback'
            manifest = {
                'name': app_name,
                'url': 'https://github.com/777genius/multi-provider-code-review',
                'description': 'AI Robot Review posts Codex-powered pull request reviews from a dedicated GitHub App bot identity.',
                'public': False,
                'redirect_url': callback,
                'callback_urls': [callback],
                'hook_attributes': {
                    'url': 'https://example.invalid/ai-robot-review-webhook-disabled',
                    'active': False,
                },
                'default_permissions': {
                    'contents': 'read',
                    'issues': 'write',
                    'pull_requests': 'write',
                },
                'default_events': [],
                'request_oauth_on_install': False,
                'setup_on_update': False,
            }
            manifest_json = json.dumps(manifest).replace("'", '&#39;')
            self._send(200, f'''<!doctype html>
<html><head><meta charset="utf-8"><title>Create {app_name}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:760px;margin:40px auto;line-height:1.45;">
<h1>Create {app_name}</h1>
<p>This creates a private GitHub App with Contents read, Issues write, and Pull requests write permissions.</p>
<form action="https://github.com/settings/apps/new?state={state}" method="post">
  <input type="hidden" name="manifest" value='{manifest_json}'>
  <button style="font-size:18px;padding:10px 16px;" type="submit">Create GitHub App</button>
</form>
<p>After GitHub redirects back, this installer will store App credentials in <code>{target_repo}</code>.</p>
</body></html>''')
            return

        if parsed.path == '/callback':
            params = urllib.parse.parse_qs(parsed.query)
            if params.get('state', [''])[0] != state:
                self._send(400, 'State mismatch. Close this page and rerun the installer.', 'text/plain; charset=utf-8')
                return
            code = params.get('code', [''])[0]
            if not code:
                self._send(400, 'Missing GitHub manifest code.', 'text/plain; charset=utf-8')
                return
            try:
                converted = subprocess.check_output(
                    ['gh', 'api', '--method', 'POST', f'/app-manifests/{code}/conversions'],
                    text=True,
                )
                app = json.loads(converted)
                private_key_path = os.path.join(os.path.dirname(env_file), 'private-key.pem')
                with open(private_key_path, 'w', encoding='utf-8') as f:
                    f.write(app['pem'])
                os.chmod(private_key_path, 0o600)
                with open(env_file, 'w', encoding='utf-8') as f:
                    f.write(f"APP_ID={shlex.quote(str(app['id']))}\n")
                    f.write(f"APP_CLIENT_ID={shlex.quote(str(app['client_id']))}\n")
                    f.write(f"APP_SLUG={shlex.quote(str(app['slug']))}\n")
                    f.write(f"APP_NAME={shlex.quote(str(app['name']))}\n")
                    f.write(f"APP_PRIVATE_KEY_FILE={shlex.quote(private_key_path)}\n")
                install_url = f"https://github.com/apps/{app['slug']}/installations/new"
                result['install_url'] = install_url
                self._send(200, f'''<!doctype html>
<html><head><meta charset="utf-8"><title>{app['name']} created</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:760px;margin:40px auto;line-height:1.45;">
<h1>GitHub App credentials saved</h1>
<p><strong>App:</strong> {app['name']} (<code>{app['slug']}[bot]</code>)</p>
<p><strong>Next step:</strong> install the App on <code>{target_repo}</code>.</p>
<p><a style="font-size:18px;" href="{install_url}">Install {app['slug']} on repositories</a></p>
<p>Return to the terminal after installing the App.</p>
</body></html>''')
                threading.Thread(target=self.server.shutdown, daemon=True).start()
            except Exception as exc:
                error['message'] = str(exc)
                self._send(500, str(exc), 'text/plain; charset=utf-8')
                threading.Thread(target=self.server.shutdown, daemon=True).start()
            return

        self._send(404, 'Not found', 'text/plain; charset=utf-8')

with socketserver.TCPServer(('127.0.0.1', 0), Handler) as httpd:
    url = f'http://127.0.0.1:{httpd.server_address[1]}/'
    print(f'Open this URL to create the GitHub App: {url}', flush=True)
    if no_browser not in ('1', 'true', 'TRUE', 'yes', 'YES'):
        try:
            webbrowser.open(url)
        except Exception:
            pass
    httpd.serve_forever()

if error:
    raise SystemExit(error['message'])
if not os.path.exists(env_file):
    raise SystemExit('GitHub App manifest flow did not complete')
if result.get('install_url'):
    print(f"Install URL: {result['install_url']}")
PY

  # shellcheck disable=SC1090
  . "$env_file"
  set_repo_variable REVIEW_APP_CLIENT_ID "$APP_CLIENT_ID"
  set_repo_variable REVIEW_APP_ID "$APP_ID"
  set_repo_variable REVIEW_APP_SLUG "$APP_SLUG"
  set_repo_secret_from_file REVIEW_APP_PRIVATE_KEY "$APP_PRIVATE_KEY_FILE"
  rm -rf "$tmp_dir"

  ok "GitHub App credentials saved for $TARGET_REPO"
  warn "Make sure the App is installed on $TARGET_REPO before the first review run."
}

setup_identity() {
  case "$IDENTITY_MODE" in
    app)
      app_name="$(safe_app_name)"
      log ""
      log "GitHub App bot mode: comments will come from a dedicated App bot, not github-actions[bot]."
      create_github_app_with_manifest "$app_name"
      ;;
    actions)
      log ""
      log "github-actions[bot] mode: fastest setup, no GitHub App. Comments use the default Actions bot name/avatar."
      ;;
    *) fatal "Unsupported identity mode: $IDENTITY_MODE" ;;
  esac
}

preset_values() {
  case "$PRESET" in
    safe)
      INLINE_MIN_SEVERITY="major"
      INLINE_MAX_COMMENTS="5"
      FAIL_ON_CRITICAL="true"
      FAIL_ON_MAJOR="false"
      CODEX_REASONING_EFFORT="medium"
      ENABLE_SECURITY="true"
      ENABLE_AST_ANALYSIS="true"
      GRAPH_ENABLED="false"
      ;;
    blocking)
      INLINE_MIN_SEVERITY="major"
      INLINE_MAX_COMMENTS="5"
      FAIL_ON_CRITICAL="true"
      FAIL_ON_MAJOR="true"
      CODEX_REASONING_EFFORT="medium"
      ENABLE_SECURITY="true"
      ENABLE_AST_ANALYSIS="true"
      GRAPH_ENABLED="false"
      ;;
    strict)
      INLINE_MIN_SEVERITY="minor"
      INLINE_MAX_COMMENTS="10"
      FAIL_ON_CRITICAL="true"
      FAIL_ON_MAJOR="true"
      CODEX_REASONING_EFFORT="high"
      ENABLE_SECURITY="true"
      ENABLE_AST_ANALYSIS="true"
      GRAPH_ENABLED="true"
      ;;
    minimal)
      INLINE_MIN_SEVERITY="major"
      INLINE_MAX_COMMENTS="3"
      FAIL_ON_CRITICAL="true"
      FAIL_ON_MAJOR="false"
      CODEX_REASONING_EFFORT="low"
      ENABLE_SECURITY="true"
      ENABLE_AST_ANALYSIS="false"
      GRAPH_ENABLED="false"
      ;;
    *) fatal "Unsupported preset: $PRESET" ;;
  esac
}

write_workflow() {
  workflow_file="$1"
  repo_name_value="$(repo_name "$TARGET_REPO")"
  preset_values
  mkdir -p "$(dirname "$workflow_file")"

  {
    cat <<'YAML'
name: AI Robot Review

on:
  pull_request:
    types: [opened, synchronize, reopened]
  workflow_dispatch:
    inputs:
      pr_number:
        description: Pull request number
        required: true

permissions:
  contents: read
  issues: write
  pull-requests: write

concurrency:
  group: ai-robot-review-${{ github.event.pull_request.number || inputs.pr_number || github.ref }}
  cancel-in-progress: true

jobs:
  review:
    if: ${{ github.event_name != 'pull_request' || github.event.pull_request.head.repo.fork != true }}
    runs-on: ubuntu-latest
    timeout-minutes: 20
YAML

    cat <<'YAML'
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
YAML

    if [ "$IDENTITY_MODE" = "app" ]; then
      cat <<'YAML'

      - name: Create review GitHub App token
        id: app-token
        uses: actions/create-github-app-token@v3
        with:
          client-id: ${{ vars.REVIEW_APP_CLIENT_ID }}
          private-key: ${{ secrets.REVIEW_APP_PRIVATE_KEY }}
          owner: ${{ github.repository_owner }}
YAML
      printf '          repositories: %s\n' "$repo_name_value"
      cat <<'YAML'
          permission-contents: read
          permission-issues: write
          permission-pull-requests: write
YAML
    fi

    if [ "$AUTH_MODE" = "codex" ] || [ "$AUTH_MODE" = "openai" ]; then
      cat <<YAML

      - uses: actions/setup-node@v6
        with:
          node-version: '24'

      - name: Install official Codex CLI
        run: npm install -g $CODEX_NPM_PACKAGE
YAML
    fi

    if [ "$AUTH_MODE" = "codex" ]; then
      cat <<'YAML'

      - name: Restore Codex OAuth config
        env:
          CODEX_AUTH_JSON: ${{ secrets.CODEX_AUTH_JSON }}
          CODEX_CONFIG_TOML: ${{ secrets.CODEX_CONFIG_TOML }}
        run: |
          test -n "$CODEX_AUTH_JSON"
          mkdir -p ~/.codex
          printf '%s' "$CODEX_AUTH_JSON" > ~/.codex/auth.json
          chmod 600 ~/.codex/auth.json
          if [ -n "$CODEX_CONFIG_TOML" ]; then
            printf '%s' "$CODEX_CONFIG_TOML" > ~/.codex/config.toml
            chmod 600 ~/.codex/config.toml
          fi

      - name: Verify Codex OAuth headless mode
        env:
          CODEX_MODEL: ${{ vars.REVIEW_CODEX_MODEL }}
        run: |
          codex exec --model "$CODEX_MODEL" --sandbox read-only --ephemeral --ignore-user-config -c approval_policy=never -c model_reasoning_effort='"low"' --output-last-message /tmp/codex-smoke.txt "Respond with exactly: codex-oauth-ok"
          grep -q "codex-oauth-ok" /tmp/codex-smoke.txt
YAML
    elif [ "$AUTH_MODE" = "openai" ]; then
      cat <<'YAML'

      - name: Verify Codex API key headless mode
        env:
          CODEX_MODEL: ${{ vars.REVIEW_CODEX_MODEL }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
        run: |
          test -n "$OPENAI_API_KEY"
          codex exec --model "$CODEX_MODEL" --sandbox read-only --ephemeral --ignore-user-config -c approval_policy=never -c model_reasoning_effort='"low"' --output-last-message /tmp/codex-smoke.txt "Respond with exactly: codex-api-ok"
          grep -q "codex-api-ok" /tmp/codex-smoke.txt
YAML
    fi

    cat <<'YAML'

      - name: Run AI Robot Review
YAML
    printf '        uses: %s\n' "$ACTION_REF"

    if [ "$AUTH_MODE" = "openai" ]; then
      cat <<'YAML'
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
YAML
    elif [ "$AUTH_MODE" = "openrouter" ]; then
      cat <<'YAML'
        env:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
YAML
    fi

    cat <<'YAML'
        with:
YAML
    if [ "$IDENTITY_MODE" = "app" ]; then
      cat <<'YAML'
          GITHUB_TOKEN: ${{ steps.app-token.outputs.token }}
YAML
    else
      cat <<'YAML'
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
YAML
    fi

    cat <<'YAML'
          PR_NUMBER: ${{ github.event.pull_request.number || inputs.pr_number }}
YAML

    cat <<YAML
          FAIL_ON_NO_HEALTHY_PROVIDERS: 'true'
          INLINE_MAX_COMMENTS: '$INLINE_MAX_COMMENTS'
          INLINE_MIN_SEVERITY: '$INLINE_MIN_SEVERITY'
          MIN_CONFIDENCE: '0.6'
          CONSENSUS_REQUIRED_FOR_CRITICAL: 'false'
          UPDATE_PR_DESCRIPTION: 'true'
          FAIL_ON_CRITICAL: '$FAIL_ON_CRITICAL'
          FAIL_ON_MAJOR: '$FAIL_ON_MAJOR'
          ENABLE_AST_ANALYSIS: '$ENABLE_AST_ANALYSIS'
          ENABLE_SECURITY: '$ENABLE_SECURITY'
          ENABLE_AI_DETECTION: 'false'
          LEARNING_ENABLED: 'false'
          GRAPH_ENABLED: '$GRAPH_ENABLED'
YAML

    if [ "$AUTH_MODE" = "codex" ] || [ "$AUTH_MODE" = "openai" ]; then
      cat <<'YAML'
          CODEX_MODEL: ${{ vars.REVIEW_CODEX_MODEL }}
YAML
      cat <<YAML
          CODEX_REASONING_EFFORT: '$CODEX_REASONING_EFFORT'
          CODEX_AGENTIC_CONTEXT: 'true'
YAML
    elif [ "$AUTH_MODE" = "openrouter" ]; then
      cat <<'YAML'
          REVIEW_PROVIDERS: ${{ vars.REVIEW_PROVIDERS }}
          SYNTHESIS_MODEL: ${{ vars.REVIEW_SYNTHESIS_MODEL }}
YAML
    fi
  } > "$workflow_file"
}

prepare_worktree() {
  if is_true "$LOCAL_ONLY"; then
    if [ -n "$WORKDIR_OVERRIDE" ]; then
      WORKDIR="$WORKDIR_OVERRIDE"
    else
      WORKDIR="$(pwd)"
    fi
    mkdir -p "$WORKDIR"
    return
  fi

  WORKDIR="$(mktemp -d)"
  if is_true "$DRY_RUN" || is_true "$SKIP_GH_CHECK"; then
    log "[dry-run] would clone $TARGET_REPO into $WORKDIR"
    mkdir -p "$WORKDIR"
    return
  fi

  info "Cloning $TARGET_REPO into a temporary worktree"
  gh repo clone "$TARGET_REPO" "$WORKDIR" -- --depth=1 >/dev/null
  default_branch="$(gh repo view "$TARGET_REPO" --json defaultBranchRef -q .defaultBranchRef.name)"
  (
    cd "$WORKDIR"
    git fetch origin "refs/heads/$INSTALL_BRANCH:refs/remotes/origin/$INSTALL_BRANCH" --depth=1 >/dev/null 2>&1 || true
    git checkout -B "$INSTALL_BRANCH" "origin/$default_branch" >/dev/null 2>&1 || git checkout -B "$INSTALL_BRANCH" >/dev/null
  )
}

commit_and_open_pr() {
  if is_true "$LOCAL_ONLY"; then
    ok "Workflow written locally to $WORKDIR/$WORKFLOW_PATH"
    return
  fi

  if is_true "$DRY_RUN" || is_true "$SKIP_GH_CHECK"; then
    log "[dry-run] would commit $WORKFLOW_PATH on branch $INSTALL_BRANCH and open a PR"
    return
  fi

  default_branch="$(gh repo view "$TARGET_REPO" --json defaultBranchRef -q .defaultBranchRef.name)"
  (
    cd "$WORKDIR"
    git add "$WORKFLOW_PATH"
    if git diff --cached --quiet; then
      exit 42
    fi
    git config user.name "ai-robot-review installer"
    git config user.email "ai-robot-review@example.invalid"
    git commit -m "ci: add ai-robot-review" >/dev/null
    if expected_sha="$(git rev-parse "refs/remotes/origin/$INSTALL_BRANCH" 2>/dev/null)"; then
      git push -u origin "$INSTALL_BRANCH" --force-with-lease="refs/heads/$INSTALL_BRANCH:$expected_sha" >/dev/null
    else
      git push -u origin "$INSTALL_BRANCH" >/dev/null
    fi
  ) || {
    status=$?
    if [ "$status" -eq 42 ]; then
      ok "Workflow already up to date; no PR needed"
      return
    fi
    exit "$status"
  }

  if gh pr view "$INSTALL_BRANCH" --repo "$TARGET_REPO" >/dev/null 2>&1; then
    ok "Setup PR already exists for branch $INSTALL_BRANCH"
  else
    gh pr create \
      --repo "$TARGET_REPO" \
      --base "$default_branch" \
      --head "$INSTALL_BRANCH" \
      --title "ci: add ai-robot-review" \
      --body "Adds AI Robot Review pull request automation. Installer mode: identity=$IDENTITY_MODE, auth=$AUTH_MODE, preset=$PRESET." >/dev/null
    ok "Opened setup PR for $TARGET_REPO"
  fi
}

main() {
  log "${BOLD}AI Robot Review installer${NC}"
  check_prerequisites
  detect_repo

  normalize_secret_scope_env
  choose SECRET_SCOPE "Secrets and variables scope" "repo" \
    "repo:Store secrets and variables on the target repository" \
    "org:Store secrets and variables on the organization, restricted to selected repositories"
  choose IDENTITY_MODE "Comment identity" "app" \
    "app:GitHub App bot identity, better audit, creates user-owned App" \
    "actions:Default github-actions[bot], fastest setup, no App"
  choose AUTH_MODE "Model authentication" "codex" \
    "codex:Codex CLI with ChatGPT subscription OAuth from local auth.json" \
    "openai:Codex CLI with OpenAI API key secret" \
    "openrouter:OpenRouter API key with openrouter/free"
  choose PRESET "Review preset" "safe" \
    "safe:Balanced defaults, major+ inline comments" \
    "blocking:Safe review depth, but fail CI on major+ findings" \
    "strict:More comments and graph context" \
    "minimal:Fewer comments and less analysis"

  log ""
  setup_secret_scope
  info "Target repo: $TARGET_REPO"
  if [ "$SECRET_SCOPE" = "org" ]; then
    info "Secret scope: org $ORG_NAME, selected repos: $ORG_SELECTED_REPOS"
  else
    info "Secret scope: repo $TARGET_REPO"
  fi
  info "Identity: $IDENTITY_MODE"
  info "Auth mode: $AUTH_MODE"
  info "Preset: $PRESET"

  setup_identity
  setup_auth
  prepare_worktree
  write_workflow "$WORKDIR/$WORKFLOW_PATH"
  commit_and_open_pr

  log ""
  ok "AI Robot Review setup complete"
  log "Docs: https://github.com/777genius/multi-provider-code-review/blob/main/docs/install.md"
}

main "$@"
