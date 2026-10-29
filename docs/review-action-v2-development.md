# Review Action v2 development and release

The committed runtime default is `REVIEWROUTER_ACTION_V2_MODE=disabled`.
Selecting `t0` is fail-closed unless the generated handoff under
`src/control-plane/generated/review-action-v2/` is present, digest-valid, and
bound to the exact committed SaaS protocol source.

T0 runs through two immutable reusable workflows:

1. `reviewrouter-reusable.yml` is the public customer entrypoint. It validates
   its own repository and full commit SHA before checking out ReviewRouter.
2. `reviewrouter-execution-reusable.yml` is the only producer identity accepted
   by the SaaS v2 OIDC verifier. Wrappers and floating refs are rejected.

The Action owns orchestration, prepared provider invocations, lease renewal,
lease-loss process termination, evidence normalization, projection, and v2 API
calls. The SaaS owns authorization, mutation epochs, evidence acceptance,
publication policy, and durable state. Provider processes never receive GitHub
mutation credentials.

## Memory inputs

Fresh T0 reviews capture one bounded, authorized memory snapshot and bind its
exact rendered bytes into the invocation manifest. Ordinary native reviews and
OCR discovery receive this snapshot; an expired or revoked snapshot is discarded
before a fresh inference grant. Qualified server context policies authorize the
same frozen internal snapshot for investigation. PR-description capture uses the
same bounded client/helper once for its separate PR-reader audience. The policy binds
the repository, audience, and allowed tasks into each snapshot identity; historical
bundles without that policy remain ordinary-review inputs. The server filters the
audience before capture and validates current receipt eligibility at each task's
authoritative grant. Recovery retains the admitted identity instead of fetching
new memory for an old execution.

OCR uses its native `path`/`rule` JSON entries. Captured Skills keep their exact
path rules and built-ins. When a retained no-Skills profile receives memory,
the Action translates its historical `content` rule to an additive native
catch-all; this changes rule content, not the legacy selected file inventory.
Memory-free historical rule bytes and invocation identities remain unchanged.
The required real-CLI fixture verifies memory in actual main model requests
with and without Skills. Deterministic model responses prove input delivery,
not that a real model follows every remembered convention.

### Native template integrity

`1.13.1-rr.5` / `ocr-managed-v4` adds one-pass original-template substitution.
Rules, frozen memory, diffs, background and model output remain opaque replacement
values, including literal `{{diffs}}` and `{{requirement_background}}`. Optional
main-task blocks are removed before data is inserted. Existing rr.4 bytes and its
qualification manifest are unchanged. The new source/build identity is recorded
in `tools/ocr/qualifications/memory-template-v1.manifest`; this local build is not
a claim that a release artifact has been published, registered, or activated.

### Managed conversation interaction

The reusable interaction workflow has an explicit `interaction_backend:
account-gateway` job requiring a full runtime commit SHA, OIDC session and App
publication identity. It runs for created/edited/deleted inline comment events,
including when discussion replies are off or capped: the server owns independent
learning and publication policies. It installs no Codex CLI, restores no provider
secret, and accepts no local discussion model override. The workflow token is a
read/bootstrap and authorized workflow-command credential; reply publication
requires the App token and fails closed when that identity is unavailable.

The Action submits source references to the finite `/api/action/v2/conversations`
process/status/publication contract. The server loads and checks the full thread,
selects the authorized account and freezes bounded exact reply bytes. The Action
publishes that envelope with its stable marker and reports the publication
receipt. Immediately before the first create, the server rechecks the frozen
source/authority and atomically claims publication through the same finite
endpoint. A lost or rejected claim never authorizes a create. Redelivery looks up every comment page; an ambiguous create is marked
unknown and reconciled rather than blindly recreated. Settled output is not
regenerated. A failed inventory before the claim leaves the reply ready for
redelivery within its original deadline; only the server claim consumes the
one-create permission. Matching source events are serialized in the reusable job.

Source implementation and deterministic fixtures do not enable this profile.
The control plane must attest the exact immutable caller/runtime, configure the
qualified source-processing and inference profiles, and pass the disposable
App-first Gateway interaction and native model/privacy gates before selection.

## Projection envelope compatibility

Projection envelope v1 includes `authoritativeObservationIds` so the SaaS can
distinguish the complete accepted observation set from the observations that
happen to emit findings. During a mixed release, omission of this field must not
be interpreted as an empty authoritative set. Older Action bundles remain
eligible only for lanes where investigation production effects and verified
clean replacement are disabled.

Roll out a SaaS parser that accepts and validates the field before promoting the
corresponding Action producer release. Then rebuild and commit `dist/index.js`
and `dist/index.js.map` before registering that release. The production reusable
workflow executes `dist/index.js`; changing TypeScript source without rebuilding
the committed runtime does not update production behavior.

Lifecycle observation follows the same parser-first rule. New Action releases
emit `review_lifecycle_observation.v1` and bind every lifecycle target to both
its finding-marker fingerprint and a current GitHub thread-state witness. The
SaaS parser for that version must be deployed before the producer release is
registered or selected. Legacy envelopes remain accepted only through the
explicit legacy authorization boundary; unknown, mixed, or incomplete witness
shapes fail closed.

The v1 thread-state witness is the lowercase SHA-256 of canonical JSON with this
preimage shape:

```text
["review_lifecycle_thread_state.v1", threadId, commentsSortedById]
```

Each comment tuple is `[id, lowercasedAuthorLoginOrNull, sha256(body),
createdAtIso, updatedAtIso]`. Full GitHub comment pagination is required.
`isResolved` is deliberately excluded because an authorized lifecycle mutation
may change it after the observation is issued. ReviewRouter accepts both the
legacy HTML finding marker and the plain v2 marker, but a lifecycle target must
contain exactly one unique valid fingerprint across all marker occurrences.
Conflicting valid markers fail closed; malformed markers never produce a
lifecycle identity.

## Codex app-server terminal semantics

Codex app-server notifications are facts, not transport success signals. A
retryable `error` notification does not terminate the stream. A non-retryable
error is retained and paired with the terminal `turn/completed` status; matching
errors are normalized and deduplicated before classification. Interrupted turns
are cancelled. Failed turns are failures even when earlier item notifications
were received.

Only output items observed during the current turn may be projected from the
terminal snapshot. Every terminal item is revalidated against the allowed item
contract, IDs must be unique, and unseen, forbidden, duplicate, or inconsistent
items produce `stream_incomplete`. A deferred app-server path must report that
it was record-only/deferred; it must not be described as a disabled capability.

## Cross-repository handoff

After the canonical SaaS protocol artifacts are committed, export them into a
clean Action worktree fenced to its exact branch and base commit:

```bash
pnpm protocol:export-public \
  --action-repo /path/to/review-router \
  --target-branch feat/revision-aware-review-evidence \
  --expected-head ACTION_BASE_SHA \
  --expected-saas-head SAAS_SOURCE_SHA \
  --write
```

Build and test the Action, commit the source, generated handoff, reusable
workflows, and `dist/index.js`, then generate the release manifest outside the
repository:

```bash
pnpm protocol:release-manifest \
  --action-repo /path/to/review-router \
  --target-branch feat/revision-aware-review-evidence \
  --expected-head ACTION_RELEASE_SHA \
  --output /tmp/review-action-v2-release.json
```

Validate that manifest from the SaaS repository before registration:

```bash
pnpm protocol:release-manifest:check \
  --manifest /tmp/review-action-v2-release.json \
  --action-repo /path/to/review-router
```

Never edit the generated handoff or release manifest manually. A release remains
inactive until the SaaS release registry, attestation registry, safety policy,
worker lane, workflow inventory, and mutation epoch all agree on the same full
Action commit SHA.

## Several Account Gateway reviewers

Snapshot v4 checkout supplies the generated `ReviewReviewerPlanV1` contract in
`REVIEW_ROUTER_REVIEWER_PLAN_JSON`. Validate the complete plan before preparing
an engine. Reviewer vote identity selects the invocation adapter; engine kind is
metadata and cannot select a same-kind sibling. Child model and auxiliary
requests carry `x-reviewrouter-reviewer-id`. The parent alone checks out SCM,
finalizes and publishes the aggregate result, and closes captured allocations.
Child disposal removes local resources only.

Each reviewer owns its private HOME, loopback capability, model transport and
captured execution settings. The parent bounds reviewer concurrency and captured
allocation-group concurrency before starting work, while keeping batches within
a reviewer serial. Parent mutations that can change execution versions share a
serialized command boundary. Paid or uncertain requests retain the existing
no-replay fences; an allocation failure stops its dependents and leaves an
independent allocation eligible to finish.

Availability is a safe checkout hint, never execution authority. SCM token
refresh may report a changed availability hint or its associated absence of
model metadata, while every captured identity and selected setting remains
fixed. Execution keeps the first admitted plan, including unavailable reviewers;
refresh cannot revive one. Live availability/model metadata is excluded from
the durable common compatibility identity, and actual provider request facts
remain bound in each invocation manifest.

The encoded v4 checkout response has a 128 KiB limit. Legacy checkout retains
its 64 KiB limit, and other Gateway control responses retain their existing
bounds. Native OCR context tools are projected only to OCR children; skills and
investigation access still resolve the exact eligible reviewer. Producer plan
support is an immutable compatibility capability, with source implementation
and runtime activation governed by the existing release boundary above.

## Rotating Codex authorization

Never write `REVIEWROUTER_CODEX_AUTH_JSON` directly with `gh secret set` for a
rotating Codex lane. Direct replacement bypasses the generation contract and a
queued run can receive an older secret generation. Seed or refresh repository
authorization only through `scripts/reseed-codex-rotating-auth.sh`, using a
dedicated account copy for that repository. Do not reuse the desktop-global
`~/.codex/auth.json` or one rotating auth file across repositories.

Investigation capabilities require authorization descriptor V3. A descriptor
without `authorizationDescriptorVersion: 3` is ignored, so mixed-version peers
remain on the ordinary legacy review path without recording, shadow, or critic
authority.

The committed-artifact smoke executes the workflow-wired `dist/index.js` under
a no-network fake boundary. It verifies the full Action commit identity,
runtime artifact digest, OIDC runtime-config exchange, and delivery of all six
strict investigation rollout gates into the production runner. Paired protocol
tests still exercise TypeScript modules directly; both gates are required.

## Deterministic investigation probes

Investigation-capable prepared prompts derive a provider-neutral probe plan from
the untrimmed merge-base-to-head diff and assigned file facts. The v1 planner
covers changed declarations and public identifiers, import/export symbols and
module paths, structured schema/config keys, route/event/permission/cache/feature
identifiers, CRUD and side-effect function names, rename/delete old paths, and a
basename fallback.

Generic identifiers such as `get`, `load`, `read`, `id`, `route`, `data`, and
`result` are rejected by a versioned denylist and minimum-specificity rule before
limits are applied. Queries are globally deduplicated by maximum semantic risk,
then deterministic source-path tie-break, and ordered deterministically.
Production limits are 48 probes per changed file and 384 probes overall.
Exceeding either actual candidate limit produces an incomplete plan with no
partial probes; that invocation remains eligible for the ordinary review path
but is not eligible for investigation recording or authoritative clean
coverage.

The Action emits the strict SaaS v2 obligation wire shapes. Changed-content
requirements use `requirementVersion: 2` and omit legacy `referenceSearch`.
Complete-page-chain requirements use `requirementVersion: 2` and carry the
bounded raw `query`, `queryHash`, `probeKind`, `matchMode: fixed_string`, root
path tuple, page size, head revision, source-path hash, search-policy version,
and initial operation-input hash.

Context Gateway v4 executes text queries with Git fixed-string semantics. The
probe policy and fixed-string search policy versions participate in the
investigation capability profile hash, while each invocation binds the exact
probe-plan hash into its context manifest.

## Investigation observation v2

Codex and Claude Code share one strict investigation turn-output schema and
parser. Both `outputVersion` and the normalized `observationVersion` are `2`.
`obligationProposals` may contain only the server-supported provider-proposable
obligation kinds and canonical `complete_file` requirements. A requirement has
exactly `requirementVersion: 1`, `kind: complete_file`, `path`, the lowercase
SHA-256 digest of the UTF-8 path as `pathHash`, and `revision` (`head` or
`merge_base`). Its canonical subject is the exact canonical JSON `file_read`
subject derived from that path hash and revision. Duplicate identities,
reserved or unknown kinds, unsupported requirements, non-canonical JSON, extra
fields, and path-hash mismatches fail closed. Proposal `riskPriority` is bounded
but advisory; the control plane owns authoritative normalization and critic
policy.

Discovery agents report every complete typed search chain and every additional
complete exploratory text-search chain through `operationBackedDiscoveryClaims`,
containing the source obligation ID, bounded exact query, and the complete
nonempty operation-receipt ID set. All collections remain capped at 256 items
and unknown fields fail closed.

Provider-neutral support does not itself enable a production provider lane.
Claude Code and cross-provider critics remain dormant until the SaaS issues a
separately fenced producer manifest and capability descriptor for the exact
provider/model authority. The Action intersects those server grants with its
local kill switches and never derives critic authority from a Codex parent
manifest.
