#!/bin/bash
# Setup CLI OAuth secrets for GitHub Actions
# Usage: ./scripts/setup-cli-secrets.sh [repository] [--org organization]
#
# Examples:
#   ./scripts/setup-cli-secrets.sh keithah/my-repo          # For a specific repo
#   ./scripts/setup-cli-secrets.sh --org xbmc              # For all repos in an organization
#   ./scripts/setup-cli-secrets.sh                          # For current repo

set -e

SECRETS_DIR="/tmp/cli-secrets-export"

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== GitHub Actions CLI OAuth Secrets Setup ===${NC}"
echo ""

find_codex_auth_file() {
  local codex_home="${CODEX_HOME:-$HOME/.codex}"
  local legacy_auth_file="$codex_home/auth.json"
  if [ -f "$legacy_auth_file" ]; then
    printf '%s\n' "$legacy_auth_file"
    return 0
  fi

  if command -v node >/dev/null 2>&1; then
    node - "$codex_home" <<'NODE' 2>/dev/null || true
const fs = require('node:fs');
const path = require('node:path');

const codexHome = process.argv[2];
const accountsDir = path.join(codexHome, 'accounts');
const registryPath = path.join(accountsDir, 'registry.json');

function authPathForAccountKey(accountKey) {
  const encoded = Buffer.from(accountKey, 'utf8').toString('base64url');
  return path.join(accountsDir, `${encoded}.auth.json`);
}

try {
  if (fs.existsSync(registryPath)) {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const activeAccountKey = registry.active_account_key;
    if (typeof activeAccountKey === 'string' && activeAccountKey.length > 0) {
      const activeAuthPath = authPathForAccountKey(activeAccountKey);
      if (fs.existsSync(activeAuthPath)) {
        console.log(activeAuthPath);
        process.exit(0);
      }
    }
  }
  if (fs.existsSync(accountsDir)) {
    const candidates = fs
      .readdirSync(accountsDir)
      .filter((entry) => entry.endsWith('.auth.json'))
      .map((entry) => path.join(accountsDir, entry));
    if (candidates.length === 1) console.log(candidates[0]);
  }
} catch {
  process.exit(0);
}
NODE
    return 0
  fi

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$codex_home" <<'PY' 2>/dev/null || true
import base64
import json
import os
import sys

codex_home = sys.argv[1]
accounts_dir = os.path.join(codex_home, 'accounts')
registry_path = os.path.join(accounts_dir, 'registry.json')

try:
    if os.path.exists(registry_path):
        with open(registry_path, 'r', encoding='utf-8') as f:
            registry = json.load(f)
        active_account_key = registry.get('active_account_key')
        if isinstance(active_account_key, str) and active_account_key:
            encoded = base64.urlsafe_b64encode(active_account_key.encode('utf-8')).decode('ascii').rstrip('=')
            active_auth_path = os.path.join(accounts_dir, f'{encoded}.auth.json')
            if os.path.exists(active_auth_path):
                print(active_auth_path)
                raise SystemExit(0)

    if os.path.isdir(accounts_dir):
        candidates = [
            os.path.join(accounts_dir, entry)
            for entry in os.listdir(accounts_dir)
            if entry.endswith('.auth.json')
        ]
        if len(candidates) == 1:
            print(candidates[0])
except Exception:
    pass
PY
  fi
}

# Check if secrets exist
if [ ! -d "$SECRETS_DIR" ]; then
  echo -e "${YELLOW}⚠️  Credential directory not found in $SECRETS_DIR${NC}"
  mkdir -p "$SECRETS_DIR"
fi

echo "Extracting missing credentials from local CLIs..."

# Claude Code subscription auth uses a long-lived token from `claude setup-token`.
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  printf '%s' "$CLAUDE_CODE_OAUTH_TOKEN" > "$SECRETS_DIR/claude-oauth-token.txt"
  chmod 600 "$SECRETS_DIR/claude-oauth-token.txt"
  echo "✅ Claude Code OAuth token staged from CLAUDE_CODE_OAUTH_TOKEN"
elif [ ! -f "$SECRETS_DIR/claude-oauth-token.txt" ]; then
  echo "⚠️  Claude Code token not staged. Run claude setup-token and export CLAUDE_CODE_OAUTH_TOKEN to seed it."
fi

# Extract Codex credentials
if [ ! -f "$SECRETS_DIR/codex-auth.json" ]; then
  CODEX_AUTH_SOURCE="$(find_codex_auth_file)"
  if [ -n "$CODEX_AUTH_SOURCE" ] && [ -f "$CODEX_AUTH_SOURCE" ]; then
    cp "$CODEX_AUTH_SOURCE" "$SECRETS_DIR/codex-auth.json"
    echo "✅ Codex auth extracted"
  else
    echo "⚠️  Codex auth not found"
  fi
fi

if [ ! -f "$SECRETS_DIR/codex-config.toml" ]; then
  if [ -f ~/.codex/config.toml ]; then
    cp ~/.codex/config.toml "$SECRETS_DIR/codex-config.toml"
    echo "✅ Codex config extracted"
  else
    echo "⚠️  Codex config not found"
  fi
fi

# Extract Gemini credentials
if [ ! -f "$SECRETS_DIR/gemini-oauth.json" ]; then
  if [ -f ~/.gemini/oauth_creds.json ]; then
    cp ~/.gemini/oauth_creds.json "$SECRETS_DIR/gemini-oauth.json"
    echo "✅ Gemini OAuth credentials extracted"
  else
    echo "⚠️  Gemini OAuth credentials not found"
  fi
fi

if [ ! -f "$SECRETS_DIR/gemini-settings.json" ]; then
  if [ -f ~/.gemini/settings.json ]; then
    cp ~/.gemini/settings.json "$SECRETS_DIR/gemini-settings.json"
    echo "✅ Gemini settings extracted"
  else
    echo "⚠️  Gemini settings not found"
  fi
fi

echo ""

# Parse arguments
TARGET_REPO=""
TARGET_ORG=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --org)
      TARGET_ORG="$2"
      shift 2
      ;;
    *)
      TARGET_REPO="$1"
      shift
      ;;
  esac
done

# Function to set secrets for a repository
set_repo_secrets() {
  local repo=$1
  echo -e "${BLUE}Setting secrets for repository: $repo${NC}"

  if [ -f "$SECRETS_DIR/claude-oauth-token.txt" ]; then
    gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo "$repo" --body "$(cat $SECRETS_DIR/claude-oauth-token.txt)"
    echo "  ✅ CLAUDE_CODE_OAUTH_TOKEN"
  fi

  if [ -f "$SECRETS_DIR/codex-auth.json" ]; then
    gh secret set CODEX_AUTH_JSON --repo "$repo" --body "$(cat $SECRETS_DIR/codex-auth.json)"
    echo "  ✅ CODEX_AUTH_JSON"
  fi

  if [ -f "$SECRETS_DIR/codex-config.toml" ]; then
    gh secret set CODEX_CONFIG_TOML --repo "$repo" --body "$(cat $SECRETS_DIR/codex-config.toml)"
    echo "  ✅ CODEX_CONFIG_TOML"
  fi

  if [ -f "$SECRETS_DIR/gemini-oauth.json" ]; then
    gh secret set GEMINI_OAUTH_CREDS --repo "$repo" --body "$(cat $SECRETS_DIR/gemini-oauth.json)"
    echo "  ✅ GEMINI_OAUTH_CREDS"
  fi

  if [ -f "$SECRETS_DIR/gemini-settings.json" ]; then
    gh secret set GEMINI_SETTINGS --repo "$repo" --body "$(cat $SECRETS_DIR/gemini-settings.json)"
    echo "  ✅ GEMINI_SETTINGS"
  fi

  echo ""
}

# Function to set secrets for an organization
set_org_secrets() {
  local org=$1
  echo -e "${BLUE}Setting secrets for organization: $org${NC}"
  echo ""
  echo "Note: Organization secrets will be visible to all repos in the org."
  echo "You'll need to set visibility for each secret."
  echo ""

  if [ -f "$SECRETS_DIR/claude-oauth-token.txt" ]; then
    gh secret set CLAUDE_CODE_OAUTH_TOKEN --org "$org" --visibility all --body "$(cat $SECRETS_DIR/claude-oauth-token.txt)"
    echo "  ✅ CLAUDE_CODE_OAUTH_TOKEN"
  fi

  if [ -f "$SECRETS_DIR/codex-auth.json" ]; then
    gh secret set CODEX_AUTH_JSON --org "$org" --visibility all --body "$(cat $SECRETS_DIR/codex-auth.json)"
    echo "  ✅ CODEX_AUTH_JSON"
  fi

  if [ -f "$SECRETS_DIR/codex-config.toml" ]; then
    gh secret set CODEX_CONFIG_TOML --org "$org" --visibility all --body "$(cat $SECRETS_DIR/codex-config.toml)"
    echo "  ✅ CODEX_CONFIG_TOML"
  fi

  if [ -f "$SECRETS_DIR/gemini-oauth.json" ]; then
    gh secret set GEMINI_OAUTH_CREDS --org "$org" --visibility all --body "$(cat $SECRETS_DIR/gemini-oauth.json)"
    echo "  ✅ GEMINI_OAUTH_CREDS"
  fi

  if [ -f "$SECRETS_DIR/gemini-settings.json" ]; then
    gh secret set GEMINI_SETTINGS --org "$org" --visibility all --body "$(cat $SECRETS_DIR/gemini-settings.json)"
    echo "  ✅ GEMINI_SETTINGS"
  fi

  echo ""
  echo -e "${GREEN}Organization secrets created! They are now available to all repos in $org.${NC}"
}

# Execute based on arguments
if [ -n "$TARGET_ORG" ]; then
  # Set organization secrets
  set_org_secrets "$TARGET_ORG"
elif [ -n "$TARGET_REPO" ]; then
  # Set secrets for specific repository
  set_repo_secrets "$TARGET_REPO"
else
  # Set secrets for current repository
  CURRENT_REPO=$(gh repo view --json nameWithOwner -q '.nameWithOwner')
  set_repo_secrets "$CURRENT_REPO"
fi

echo -e "${GREEN}=== Setup complete! ===${NC}"
echo ""
echo "Your CLI OAuth secrets are now configured for GitHub Actions."
echo ""
echo "You can now use these providers in your workflows:"
echo "  • claude/sonnet, claude/opus, claude/haiku"
echo "  • codex/gpt-5.5"
echo "  • gemini/gemini-2.0-flash, gemini/gemini-1.5-pro"
echo ""
echo "Example workflow usage:"
echo "  env:"
echo "    REVIEW_PROVIDERS: 'claude/sonnet,codex/gpt-5.5,gemini/gemini-2.0-flash'"
echo ""
echo "Clean up credential files when done:"
echo "  rm -rf $SECRETS_DIR"
