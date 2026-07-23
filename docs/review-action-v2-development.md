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
