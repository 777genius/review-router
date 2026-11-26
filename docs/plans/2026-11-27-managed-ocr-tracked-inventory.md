# Managed OCR tracked inventory repair

Status: implementation plan; no release or activation claimed.

## Assigned outcome and evidence

Finish the scoped production-stability follow-up to private PR #977/#1003.
The new defect is native OCR required coverage on tracked files whose paths
match the checkout's `.gitignore`. Public Action source and the maintained
native patch/build belong to this repository. Private formatting CI and
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

- Preserve upstream pin `8eb83340a487b1150af00701b94f01af97e4b4d6`, Go
  `1.26.10`, all twelve existing patch bytes, rr.6, its manifest and old profiles.
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
- New immutable component identity is proposed as `1.13.1-rr.7` /
  `ocr-managed-v6`, subject to fresh remote absence checks before publication.
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
2. Add one successor native patch containing the minimal shared-provider fix
   and focused Go regression tests. Run real Git-backed provider/agent tests,
   not just a reimplementation of the filter predicate.
3. Extend the existing managed real-CLI integration owner with the seven-path
   fixture and negative controls. Verify actual selected path/content delivery
   against synthetic loopback model responses, exact outcomes and Action
   coverage/projection. No paid provider requests or production fault injection.
4. Build rr.7 with the pinned toolchain; generate a new qualification manifest
   from actual bytes. Append a new profile, never relabel rr.6. Update the
   existing candidate qualification/publisher references and their tests.
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
7. Publish the new component only through the existing qualified draft-release
   procedure. Verify binary, checksum and MANIFEST by remote download and the
   fixed anonymous bootstrap URL. Do not activate an unpublished profile.
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
- Round 2: pending after incorporating round 1.
- Implementation, checks, merge, publication and activation: pending; this plan
  alone is not evidence for any of these outcomes.
