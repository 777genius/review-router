export function redactSensitiveText(value: string): string {
  return value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      '-----BEGIN PRIVATE KEY-----***-----END PRIVATE KEY-----'
    )
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, 'sk-***')
    .replace(/ghs_[A-Za-z0-9_]{16,}/g, 'ghs_***')
    .replace(/gh[pousr]_[A-Za-z0-9_]{16,}/g, 'gh*-***')
    .replace(/github_pat_[A-Za-z0-9_]+/g, 'github_pat_***')
    .replace(
      /(?:eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g,
      'jwt-***'
    )
    .replace(/(authorization:\s*bearer\s+)[^\s]+/gi, '$1***')
    .replace(/(access_token["'\s:=]+)[^"',\s}]+/gi, '$1***')
    .replace(/(refresh_token["'\s:=]+)[^"',\s}]+/gi, '$1***')
    .replace(/(id_token["'\s:=]+)[^"',\s}]+/gi, '$1***')
    .replace(/(client_secret["'\s:=]+)[^"',\s}]+/gi, '$1***')
    .replace(/(private[-_ ]?key["'\s:=]+)[^"',\s}]+/gi, '$1***')
    .replace(/(CODEX_AUTH_JSON["'\s:=]+)\{[\s\S]*?\}/gi, '$1***')
    .replace(/(CLAUDE_CODE_OAUTH_TOKEN["'\s:=]+)[^"',\s}]+/gi, '$1***')
    .replace(/(OPENAI_API_KEY["'\s:=]+)[^"',\s}]+/gi, '$1***')
    .replace(/(OPENROUTER_API_KEY["'\s:=]+)[^"',\s}]+/gi, '$1***')
    .replace(
      /((?:api[_-]?key|apikey|api[_-]?secret|token|password)["'\s:=]+)[A-Za-z0-9_./+=-]{16,}/gi,
      '$1***'
    );
}
