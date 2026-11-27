# Managed OCR tracked inventory repair

Status: source recovery and end-to-end qualification in progress; no new release or activation claimed.

## Assigned outcome and evidence

Finish the scoped production-stability follow-up to private PR #977/#1003.
The new defect is native OCR required coverage on tracked files whose paths
match the checkout's `.gitignore`. Public Action source belongs to this repository. The maintained native source,
qualification and publication now belong to `agent-teams-ai/open-code-review`;
the patch stack here is the frozen rr.6 reproduction baseline. Private formatting CI and
operator-host backup/disk checks have separate owners and evidence.

The failed private review run
[45895610230](https://github.com/777genius/review-router-ai/actions/runs/45895610230)
executed public `e0e5f8fac3985560ba4848d084258d3623cbc4f2` against private PR
#1012 and reported `required_review_coverage_incomplete`. Both omitted paths
were tracked deletions under `tmp/`. Its published result explicitly reported
33 reviewed, four policy-excluded and two unavailable files; successful close
readback does not repair missing review coverage.

Independent model-free reproduction used the official `1.13.1-rr.6` executable,
SHA-256 `9dd5f115747d24100f0767133a3288d268f3bc399675f5b826e7a867d101ee5c`.
Git and the exact managed inventory contained seven changes. Preview returned
three: one selected and two explicitly deleted. Two deletions (including an
empty base file), a modification and a rename into ignored `tmp/` disappeared.
Keeping the binary, base/head and rules unchanged, removing only that ignore
rule in the disposable fixture restored all seven preview rows. No provider
request was made. Native `partitionDiffs` applies `.gitignore` before existing
managed exact admission; the Action correctly fails closed for missing rows.

## Ownership and invariants

- Preserve the frozen rr.6 baseline: upstream pin
  `8eb83340a487b1150af00701b94f01af97e4b4d6`, Go `1.26.10`, all twelve
  existing patch bytes, its manifest and old profiles. Develop this fix as an
  ordinary source change in the native owner fork. Its reviewed main already
  contains upstream 1.14.0 (`39515dca6161fb7fd176d87704b2b10e5f7a0c36`)
  and Go `1.26.11`; this task performs no upstream merge or toolchain bump.
- Carry the existing validated `FileFilter.ManagedPaths` exact inventory into
  the native diff provider. Copy its values; do not retain a mutable caller map.
- Only a tracked Git diff with an admitted effective path may bypass the
  ordinary `.gitignore` prefilter. Add no file discovery, glob interpretation,
  new flag or new authority source. Exact matching remains case-sensitive.
- Provider-directory exclusion runs first. Existing deletion, binary and
  secret gates remain authoritative; modified and renamed admitted code is
  selected for actual review rather than classified as an ignore exemption.
- Preserve legacy/nonmanaged filtering and nil/empty inventory semantics.
  Both preview and run receive the same inventory through their shared provider
  constructor; do not rely on the currently absent preview `Args.Managed` bit.
- Do not change the public coverage parser or its accepted exclusion reasons.
  Missing/duplicate/unassigned/malformed evidence remains incomplete or rejected.
- Preserve request budgets, cancellation, transport serialization, memory,
  Skills, opaque-template substitution, protocol/schema and publication policy.
- Candidate identity is `1.14.0-rr.1` / `ocr-managed-v6`, subject to fresh
  remote absence checks before publication. The earlier proposed rr.7 identity
  is unavailable: the native owner already published `1.13.1-rr.7` for a separate
  packaging/security change. Neither rr.6 nor that rr.7 may be overwritten.
  Source, qualification, asset publication, producer approval and activation are
  distinct steps. Existing admitted runs keep their original identities.

## Decision and proportional alternatives

Ranges cover incremental handwritten integration and tests, excluding generated
bundles/manifests and documentation. Native Go is counted explicitly here.
Engineer-days assume one experienced engineer and available tools/runners;
these are estimates, not a delivery promise. U is fitness, N is reliability
for the declared scope, C is complexity; all are ordinal 1–10 judgments.

| Rank and option | Boundary and tradeoff | P / T LOC; days | U / N / C | Falsifiable evidence |
| --- | --- | --- | --- | --- |
| 1. Retain admitted tracked diffs at native provider | Restores existing exact admission before `.gitignore`, then uses unchanged hard gates. Covers deletion, modification and rename. Risk: incorrect effective-path or mutable-map handling. | 20–60 native P plus 20–60 release integration P; 180–360 T; 1–3 days | 9 / 9 / 3 | The released negative fixture becomes complete; unauthorized, secret, binary and legacy controls retain their outcomes. |
| 2. Bypass ignore only for admitted deletions | Smaller change, same explicit deletion evidence; leaves reproduced modified and renamed code unavailable. Insufficient for this assigned stability outcome. | 10–30 native P plus 20–60 release integration P; 100–220 T; 1–2 days | 5 / 8 for deletions only / 2 | Deletions recover while modified/renamed controls continue failing. |
| 3. Keep fail-closed rr.6 and defer native correction | No selection change or artifact migration, but valid tracked PRs remain unable to finish. Useful rollback baseline only. | 0 P / 0 T; 0–0.5 days | 2 / 9 for preventing false success / 1 | Original seven-path fixture continues returning only three rows. |

Recommendation: option 1, conditional on exact-path and hard-gate controls,
independent review and the required qualification gates. Globally ignoring
`.gitignore`, rewriting the customer checkout, or treating missing preview rows
as policy exclusions would violate the existing authority/coverage contract;
they are not defensible alternatives. The strongest counterexample is a
  renamed credential: explicit admission must never make its content reach a
  model, whether the old or new path identifies a secret. Provider-directory
  rejection retains its existing effective-path semantics: rename into an
  excluded provider directory is rejected; rename out does not acquire an
  unrelated new prohibition. Both boundaries receive dedicated fixtures.

## Delivery sequence

1. Publish this plan in a draft owner PR; perform two independent criticism
   rounds before implementation and record findings and dispositions below.
2. Add ordinary source changes in the native owner fork for the shared-provider
   fix and managed context exclusion enforcement. Remove the pending local
   successor patch from this repository; do not maintain two implementation
   owners. Run real Git-backed provider, agent and tool tests.
3. Extend the existing managed real-CLI integration owner with the seven-path
   fixture and negative controls. Verify actual selected path/content delivery
   against synthetic loopback model responses, exact outcomes and Action
   coverage/projection. No paid provider requests or production fault injection.
4. Qualify the native owner candidate with its existing formatting, test/race,
   vulnerability, coverage, pinned-build and four real-CLI case gates. Publish
   only through its existing `managed-release.yml` using the reviewed main SHA.
   Generate the consumer manifest and new profile from actual published bytes;
   never relabel an old binary. The public candidate workflow becomes a
   read-only consumer of that exact qualified release.
5. Resolve the required toolchain boundary through its owning dependency
   qualification route before running TypeScript tools: the current public
   lockfile resolves TypeScript 5.9.3 in tsc/ts-jest/parser. Maintained changes
   need strict TypeScript 7.0.2 or newer, including embedded APIs. Do not execute
   the older compiler, bypass tests, weaken assertions or call Node stripping
   a typecheck. Continue independent Go and model-free CLI work meanwhile.
6. Rebuild affected committed bundles only when runtime/profile bytes change.
   Review the exact diff and generated artifacts, resolve critical findings,
   complete required CI, then use the protected owner merge route and verify
   actual attribution and resulting-main CI. Keep unrelated refactors out.
7. Verify the native owner's seven published assets, qualification receipt,
   checksum and MANIFEST by remote download. The Action must download the new
   version from the fixed owner URL and verify its exact profile digest. Keep
   legacy profile download URLs unchanged. Do not activate an unpublished profile.
8. Assess compatible Action-only adoption against the actual installed private
   source and current operator evidence; producer registry and channel promotion
   remain subject to the existing checks and operator access. Record exactly
   what is shipped versus awaiting installation/readback. Read the actual
   captured profileRef, package version and executable digest of a fresh review;
   adding a v6 profile does not change an explicitly selected legacy v5 run.
   Do not replace SSH
   access, real production backup or live acceptance with synthetic evidence.

## Acceptance matrix

| Boundary | Required observations |
| --- | --- |
| Baseline | Official rr.6 omits the four ignored tracked paths; same Git tuple with only fixture ignore removal reports all seven. |
| Native provider | Ignored tracked empty/nonempty deletions, modifications, rename into/out of ignored directories, literal brackets/case and old/new path identity. |
| Authority | Unassigned ignored changes and untracked ignored files are never selected; nil/empty inventories and map-copy behavior are explicit. |
| Hard exclusions | Admitted provider paths, binary diffs and secret names/credential renames cannot reach the model; explicit exclusion evidence is retained. |
| Preview/run | Same inventory in both; every admitted selected file occurs in real outcome groups and the synthetic request; deletion rows are explicit. |
| Action acceptance | Existing real adapter accepts complete explicit evidence; missing selected outcomes and missing/unknown/duplicate preview evidence remain fail-closed. |
| Compatibility | Existing managed transports, cancellation, memory, Skills and opaque-template tests pass unchanged; legacy ignore behavior stays unchanged. |
| Artifact | New exact binary digest, manifest, profile and release assets agree; old bytes and identities remain intact. |

## Independent criticism and execution record

- Round 1: independent diagnosis reviewer accepted the shared-provider design
  and requested two corrections, both incorporated: preserve the existing
  effective-path provider-directory policy rather than inventing a rename-out
  ban; require actual captured native profile/version/digest in adoption proof.
- Round 2 (recovered prior-session evidence): review exposed that an excluded
  secret could remain available through native `file_read_diff`. The restored
  successor patch guards managed diff-map insertion with the existing
  secret/binary exclusion policy; native loop tests exercise the real tool
  call, credential renames and permitted related/deleted context. Historical
  test reports qualify the previous lost candidate only, not these restored
  bytes.
- Source recovery: the old public working tree and temporary native candidate
  were absent after environment restarts. The exact rr.6 baseline was rebuilt
  with Go 1.26.10 and matched its published SHA-256
  `9dd5f115747d24100f0767133a3288d268f3bc399675f5b826e7a867d101ee5c`.
  The new patch was reconstructed against the exact upstream commit and all
  twelve unchanged baseline patches, then published in Draft PR #410 at
  `22cc0c3f91e12d82e860f5077d5e6ab49dc1b8cd`.
- Current source checkpoint adds real Action-to-native tests for the seven-path
  tracked inventory and negative admission/hard-exclusion controls. It also
  wires the restored Go regression suites into the existing candidate job.
  A separate manifest-comparison step preserves actual build artifacts for
  inspection when the committed qualification receipt is still pending;
  publication continues to require the entire qualification job to succeed.
- Toolchain qualification replaces embedded classic TypeScript APIs with
  native syntax tooling and retains standalone strict TypeScript 7 checking,
  Jest test inventory, coverage configuration and architecture assertions. The dependency lock,
  compiler, lint, formatting, complete tests and committed bundles must be
  regenerated and verified before merge; a source checkpoint is not a PASS.
- Current candidate compile/gofmt, RED/GREEN, real CLI qualification, exact rr.7
  binary manifest/profile, independent final review, CI, merge, release and
  adoption readback remain pending. No environment-interrupted run is accepted
  as successful evidence.

### Restored-source review and qualification checkpoint

- Independent source review of the restored native patch found no P0/P1/P2
  defects in the managed inventory scope. It checked old/new secret paths,
  provider-directory precedence, copied-map semantics and actual diff-tool
  fixtures. A separate review found no critical defects in the new Action
  harness, publisher move or fail-closed candidate workflow.
- Toolchain review found and corrected differing defaults for constant loops,
  block function declarations and strict module parsing of script-style
  TypeScript. Negative fixtures invoke the native lint boundary. The original
  production dependency versions are unchanged; the lock resolves one native
  TypeScript 7.0.2 compiler and no classic compiler API consumers.
- The combined restored root source passed `npm run typecheck` with TypeScript
  7.0.2. Focused existing provider/Codex/CLI tests and migrated architecture/lint
  fixtures passed. Full lint, formatting, Jest, E2E and CI remain required.
- The first native build in the restored environment stopped because the OS
  killed SDK compilation processes; no native test result was produced. A
  bounded retry uses lower GC/memory limits without changing build flags.
- The published rr.6 binary was downloaded again and verified against its
  immutable SHA-256 for the forthcoming baseline RED comparison.

### Continuation: ownership reconciliation and actual tool boundary

- The recovered public workspace is
  `/workspace/scratch/b54e70400ef6/review-router`. Its source survived, while
  temporary Git metadata and dependencies did not. The available transcript
  export predates this PR; historical reviewer acceptance does not qualify the
  restored bytes.
- Inspection of the native owner's `docs/managed-fork.md` supersedes the old
  patch ownership assumption above. Its already accepted 1.14.0 main is the
  source base; the frozen rr.6 reconstruction remains available here. The
  unpublished duplicate rr.7 candidate is diagnostic evidence only.
- The recovered tracked-inventory fixtures initially omitted captured Skills
  input, accidentally selecting a legacy Action path. They now use the same
  captured empty Skills object as production v3+ profiles and assert the entire
  exact-path/rule object. No legacy rule contract or parser was broadened.
- The same corrected fixtures fail on the official rr.6 binary and pass on
  candidate `794ef542f85431f7227707696d437cdc3c468e24b3ba694b2464b7c8ac0d65e7`.
  They exercise modified and renamed ignored tracked files, four deletions
  including empty `0/0`, explicit secret/binary/provider exclusions, actual
  synthetic request content and the Action coverage result. This candidate
  has not been released and does not qualify the subsequent native tool fix.
- A real CLI loopback probe found that `file_read('.env')` still returned a
  synthetic secret marker despite the existing `file_read_diff` guard. The
  owner fix applies the existing hard exclusions to managed read/search/find
  tools on both comparison sides, including renamed secret aliases. Related
  non-secret and deleted old-side context remain available. Nonmanaged tool
  behavior is preserved.
- Independent review also found that `git grep -I` alone can miss binary data
  whose NUL occurs beyond its initial detection window. Managed search must
  validate the entire matched file before rendering any row; a marker before
  a late NUL is an explicit negative regression.
- The existing four native real-CLI qualification cases retain their release
  gate and gain actual malicious tool requests and request-body leak checks.
  The public E2E then consumes the published artifact through the real adapter.
- Restored strict TypeScript 7.0.2, lint and formatting checks passed. A full
  local Jest process was killed after 56 passing suites without a final result;
  it is not a suite PASS. Environment restarts and killed builds are recorded
  as incomplete. Final complete tests and exact released-artifact E2E remain
  required before acceptance.
