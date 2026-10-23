# HTTPS context tools for managed OCR

Context tools are optional and require a qualified ReviewRouter producer release
with the `context-tools.v1` capability and the managed OCR account-gateway profile.
An absent selection keeps the existing review behavior. Other review engines reject
a context-tools plan before inference.

Create the connection in **Dashboard → Context tools**. Put its selection in
`.reviewrouter.json` on the default branch, choose **Import default-branch config**,
review the preview, then Save. Save checks the configuration revision. A pull
request cannot activate a connection or supply an executable command.

```json
{
  "contextTools": {
    "version": 1,
    "builtinTools": ["github.issue.read"],
    "mcp": [{ "connection": "docs", "tools": ["search_docs", "get_page"] }]
  }
}
```

A workspace administrator saves the connection separately:

```json
{
  "id": "docs",
  "url": "https://docs.example.com/mcp",
  "headers": { "Authorization": "Bearer {{ secrets.DOCS_TOKEN }}" },
  "tools": ["search_docs", "get_page"],
  "credentials": {
    "DOCS_TOKEN": { "source": "github-secret", "name": "DOCS_MCP_TOKEN" }
  }
}
```

`{{ secrets.NAME }}` and `${{ secrets.NAME }}` are finite substitutions of the
connection's logical credential map. They do not evaluate JavaScript, shell, or
arbitrary GitHub expressions. GitHub does not expand these templates inside the
JSON; the runner broker resolves them using the explicit map below. Every
configured header contains a bound placeholder; anonymous connections use empty headers and credentials. Missing, empty, multiline,
or unsolicited credential values make the selected integration unavailable.

The generated caller forwards only the explicitly selected workflow secrets:

```yaml
secrets:
  mcp_secrets_json: ${{ format('{{"DOCS_TOKEN":{0}}}', toJSON(secrets.DOCS_MCP_TOKEN)) }}
```

The reusable workflow receives this exact logical map as JSON. Do not forward
`toJSON(secrets)` or use `secrets: inherit`. GitHub credential bytes stay in the trusted runner parent. Dashboard credentials use authenticated,
run-scoped delivery; Dashboard-only selections need no caller secret mapping.
GitHub secret availability follows GitHub: fork pull requests and Dependabot
runs usually receive empty secrets, so a selected GitHub credential is
unavailable before inference. No automatic fork-secret access is provided.

`github.issue.read` reads linked issues and bounded comments in the admitted
repository. The GitHub App installation must already permit issues read. The
optional `repository.docs.read` reads admitted head/review diff base (merge-base) README, `docs/`, or
`ai-docs/` files from Git objects, with a 64 KiB file limit. Only README or
Markdown, MDX, reStructuredText and plain-text documentation is admitted; hidden
paths are denied and known secret patterns are redacted. Native OCR repository
reading remains available without enabling this optional tool.

All selected tools are required to be available. Startup failure prevents model
dispatch; a later transport failure makes the review fail with required context
unavailable. A tool's ordinary query error allows a corrected query. Failed or
uncertain dispatches are not automatically replayed.

Only approved remote Streamable HTTP endpoints over HTTPS on public addresses
are supported. DNS answers and the actual TLS destination are checked on each connection; redirects, automatic
OAuth discovery, proxy environment routing, local stdio, setup commands and
arbitrary environment configuration are unsupported. The selected server receives
model-generated tool arguments. Its output is untrusted evidence, and its
`readOnlyHint` annotation does not grant additional tools or permissions.

The fixed limits are four servers, twenty selected tools per server, 30 seconds
for startup and each call, 1 MiB per response, and 128 distinct calls per review.
The private OCR configuration contains a loopback capability and exact namespaced
tool names. External credentials never enter OCR's configuration or environment.

### Qualifying actual OCR tool use

A selected connection or successful `tools/list` does not prove invocation.
The native qualification can additionally exercise real anonymous DeepWiki, Microsoft Learn and Cloudflare Docs
HTTPS servers with the pinned OCR rr.3 binary:

```sh
REVIEWROUTER_TEST_APPROVED_OCR_BINARY=/absolute/path/to/opencodereview-linux-amd64 \
REVIEWROUTER_TEST_LIVE_MCP=1 \
npm test -- __tests__/unit/context-tools/ocr-native.test.ts --runInBand
```

CI runs the deterministic native scenarios on each build. To include the live
HTTPS scenario, dispatch CI with the `live_mcp` input enabled.

The live flag requires the binary; a missing binary fails rather than producing
a skipped qualification. Before starting OCR, the test computes its binary SHA-256 and rejects any value
that differs from the approved rr.3 fixture; the local command enforces the same
binary identity as CI.
This runs in disposable repositories and uses a synthetic model endpoint with
no provider credentials or paid inference. The external servers are real: OCR must call the selected DeepWiki
`read_wiki_structure`, Learn `microsoft_docs_search`, and Cloudflare
`search_cloudflare_documentation` tools in separate scenarios, receive
nonempty documentation, and include that output in its next model request.
The broker must report exactly one call, no failure, and a native connection.
The invalid-capability scenario must dispatch zero model requests. An unavailable
selected server fails the opt-in qualification rather than silently skipping it.

This proves native execution and result delivery. It does not prove that a live
model independently chose to use the tool, or that every review needs MCP.
Keep live model canary evidence separate: record the exact run and captured
plan, and require an actual tool-call receipt with `calls > 0` before claiming
MCP usage. Never infer invocation from configuration or connection status.

`REVIEWROUTER_TEST_LIVE_DEEPWIKI=1` remains available for the narrower DeepWiki-only
scenario. Neither flag calls a paid model. A successful catalog listing or saved
Dashboard connection remains separate evidence from a native tool invocation.
