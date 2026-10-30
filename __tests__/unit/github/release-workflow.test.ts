import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const repoRoot = path.resolve(__dirname, '../../..');
const workflowDirectory = path.join(repoRoot, '.github/workflows');
const checkoutActionSha = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const checkoutActionReference = `actions/checkout@${checkoutActionSha}`;
const auditedActionShas: Readonly<Record<string, string>> = {
  'actions/checkout': checkoutActionSha,
  'actions/create-github-app-token': 'bcd2ba49218906704ab6c1aa796996da409d3eb1',
  'actions/setup-go': 'b7ad1dad31e06c5925ef5d2fc7ad053ef454303e',
  'actions/setup-node': '820762786026740c76f36085b0efc47a31fe5020',
  'actions/upload-artifact': 'ea165f8d65b6e75b540449e92b4886f43607fa02',
};
const auditedExternalUseCounts: Readonly<Record<string, number>> = {
  [checkoutActionReference]: 19,
  'actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1': 2,
  'actions/setup-go@b7ad1dad31e06c5925ef5d2fc7ad053ef454303e': 2,
  'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020': 16,
  'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02': 2,
};
const checkoutCredentialException = {
  workflow: 'release.yml',
  stepName: 'Checkout',
  reference: checkoutActionReference,
} as const;

interface WorkflowUse {
  readonly reference: string;
  readonly mapping: Record<string, unknown>;
}

interface LocatedWorkflowUse extends WorkflowUse {
  readonly workflow: string;
}

interface ParsedWorkflow {
  on: Record<string, unknown>;
  permissions: Record<string, string>;
  jobs: Record<
    string,
    {
      if?: string;
      needs?: string;
      permissions?: Record<string, string>;
      steps: Array<{
        name?: string;
        run?: string;
        with?: Record<string, unknown>;
        env?: Record<string, string>;
      }>;
    }
  >;
}

function readWorkflow(name: string): ParsedWorkflow {
  return yaml.load(
    fs.readFileSync(path.join(workflowDirectory, name), 'utf8'),
    {
      schema: yaml.JSON_SCHEMA,
    }
  ) as ParsedWorkflow;
}

function collectUses(
  value: unknown,
  references: WorkflowUse[] = [],
  seen: Set<object> = new Set()
): WorkflowUse[] {
  if (value === null || typeof value !== 'object') {
    return references;
  }
  if (seen.has(value)) {
    return references;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectUses(item, references, seen);
    }
    return references;
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === 'uses') {
      if (typeof child !== 'string') {
        throw new TypeError('workflow uses values must be strings');
      }
      references.push({
        reference: child,
        mapping: value as Record<string, unknown>,
      });
      continue;
    }
    collectUses(child, references, seen);
  }

  return references;
}

function parseWorkflowUses(source: string): WorkflowUse[] {
  return collectUses(yaml.load(source, { schema: yaml.JSON_SCHEMA }));
}

function readWorkflowUses(): LocatedWorkflowUse[] {
  return fs
    .readdirSync(workflowDirectory)
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .flatMap((workflow) => {
      const source = fs.readFileSync(
        path.join(workflowDirectory, workflow),
        'utf8'
      );
      return parseWorkflowUses(source).map((use) => ({ ...use, workflow }));
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stepName(use: WorkflowUse): string {
  return typeof use.mapping.name === 'string' ? use.mapping.name : '<unnamed>';
}

function persistCredentials(use: WorkflowUse): unknown {
  const inputs = use.mapping.with;
  return isRecord(inputs) ? inputs['persist-credentials'] : undefined;
}

function isCheckoutCredentialException(use: LocatedWorkflowUse): boolean {
  return (
    use.workflow === checkoutCredentialException.workflow &&
    stepName(use) === checkoutCredentialException.stepName &&
    use.reference === checkoutCredentialException.reference
  );
}

function checkoutCredentialViolation(use: LocatedWorkflowUse): string | null {
  if (!use.reference.startsWith('actions/checkout@')) {
    return null;
  }

  const expected = isCheckoutCredentialException(use);
  const actual = persistCredentials(use);
  return actual === expected
    ? null
    : `${use.workflow}:${stepName(use)} expected persist-credentials=${expected}, got ${String(actual)}`;
}

describe('workflow security and release', () => {
  it('pins every external workflow action to its audited full SHA', () => {
    const externalUseCounts: Record<string, number> = {};
    const externalUses = readWorkflowUses()
      .map((use) => use.reference)
      .filter((reference) => !reference.startsWith('./'));

    for (const externalUse of externalUses) {
      expect(externalUse).toMatch(/^[^@]+@[a-f0-9]{40}$/);
      const [action, sha] = externalUse.split('@');
      expect(auditedActionShas[action]).toBe(sha);
      externalUseCounts[externalUse] =
        (externalUseCounts[externalUse] ?? 0) + 1;
    }

    expect(externalUseCounts).toEqual(auditedExternalUseCounts);
    expect(
      Object.values(externalUseCounts).reduce(
        (total, count) => total + count,
        0
      )
    ).toBe(41);
  });

  it('finds semantic uses keys without scanning block scalar text', () => {
    const references = parseWorkflowUses(`
jobs:
  probe:
    steps:
      - { uses: actions/checkout@v7 }
      - 'uses': actions/setup-node@v7
      - run: |
          uses: actions/create-github-app-token@v3
    `).map((use) => use.reference);

    expect(references).toEqual([
      'actions/checkout@v7',
      'actions/setup-node@v7',
    ]);
  });

  it('disables checkout credentials except for the exact release publisher', () => {
    const checkoutUses = readWorkflowUses().filter((use) =>
      use.reference.startsWith('actions/checkout@')
    );
    const exceptions = checkoutUses.filter(isCheckoutCredentialException);
    const violations = checkoutUses
      .map(checkoutCredentialViolation)
      .filter((violation): violation is string => violation !== null);

    expect(
      exceptions.map((use) => ({
        workflow: use.workflow,
        stepName: stepName(use),
        reference: use.reference,
        persistCredentials: persistCredentials(use),
      }))
    ).toEqual([
      {
        ...checkoutCredentialException,
        persistCredentials: true,
      },
    ]);
    expect(violations).toEqual([]);
  });

  it('rejects missing or enabled credentials outside the release exception', () => {
    const checkoutUses = parseWorkflowUses(`
jobs:
  probe:
    steps:
      - { name: Missing checkout, uses: ${checkoutActionReference} }
      - name: Checkout
        'uses': ${checkoutActionReference}
        with: { persist-credentials: true }
      - run: |
          uses: ${checkoutActionReference}
    `).map((use) => ({ ...use, workflow: 'probe.yml' }));

    expect(checkoutUses).toHaveLength(2);
    expect(checkoutUses.map(checkoutCredentialViolation)).toEqual([
      'probe.yml:Missing checkout expected persist-credentials=false, got undefined',
      'probe.yml:Checkout expected persist-credentials=false, got true',
    ]);
  });

  it('rejects a handoff base outside the release ancestry', () => {
    const workflow = fs.readFileSync(
      path.join(repoRoot, '.github/workflows/release.yml'),
      'utf8'
    );
    const validationStep = workflow.match(
      /- name: Validate release target[\s\S]*?(?=\n\s+- name: Install dependencies)/
    )?.[0];

    expect(validationStep).toBeDefined();
    expect(validationStep).toContain('expectedPublicActionBaseCommit');
    expect(validationStep).toContain(
      'git merge-base --is-ancestor "$HANDOFF_BASE" HEAD'
    );
  });

  it('publishes the exact and moving tags atomically', () => {
    const workflow = fs.readFileSync(
      path.join(repoRoot, '.github/workflows/release.yml'),
      'utf8'
    );
    const publishStep = workflow.match(
      /- name: Publish exact and stable tags[\s\S]*?(?=\n\s+- name: Create GitHub Release)/
    )?.[0];

    expect(publishStep).toBeDefined();
    expect(workflow).not.toContain('workflow-v1');
    expect(publishStep?.match(/\bgit push\b/g)).toHaveLength(1);
    expect(publishStep).toMatch(
      /git push --atomic origin \\\n\s+"refs\/tags\/\$VERSION" \\\n\s+"\+refs\/tags\/\$MAJOR_TAG"/
    );
  });

  it('tests committed release bytes after install and rebuilds them before tag publication', () => {
    const steps = readWorkflow('release.yml').jobs.release.steps;
    const index = (name: string) =>
      steps.findIndex((step) => step.name === name);
    const install = index('Install dependencies');
    const restore = index('Restore committed runtime artifacts after install');
    const test = index('Test');
    const build = index('Build committed bundles');
    const verify = index('Verify committed release artifacts');
    const publish = index('Publish exact and stable tags');
    expect(install).toBeGreaterThan(-1);
    expect(steps[install].run).toBe('npm ci');
    expect(restore).toBe(install + 1);
    expect(steps[restore].run).toBe('git restore --worktree -- dist');
    expect(test).toBeGreaterThan(restore);
    expect(build).toBeGreaterThan(test);
    expect(verify).toBeGreaterThan(build);
    expect(publish).toBeGreaterThan(verify);
    expect(steps[verify].run).toContain('git status --short');
  });

  it('keeps native qualification read-only and publishes only its successful exact dispatch artifact', () => {
    const workflow = readWorkflow('native-runtime-candidate.yml');
    expect(workflow.on.workflow_dispatch).toEqual({
      inputs: {
        expected_source_sha: {
          description: expect.any(String),
          required: true,
          type: 'string',
        },
      },
    });
    expect(workflow.permissions).toEqual({ contents: 'read' });
    const qualify = workflow.jobs.qualify;
    expect(qualify.permissions).toBeUndefined();
    expect(qualify.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(qualify.if).toContain(
      'github.event.pull_request.head.repo.full_name == github.repository'
    );
    const validation = qualify.steps.find(
      (step) => step.name === 'Validate manual publication source'
    )!;
    expect(validation.env).toEqual({
      EXPECTED_SOURCE_SHA: '${{ inputs.expected_source_sha }}',
    });
    expect(validation.run).toContain('test "$GITHUB_REF" = refs/heads/main');
    expect(validation.run).toContain(
      'test "$GITHUB_SHA" = "$EXPECTED_SOURCE_SHA"'
    );
    expect(validation.run).toContain('git rev-parse HEAD');
    expect(validation.run).toContain(
      'git ls-remote --exit-code origin refs/heads/main'
    );
    const artifact = qualify.steps.find(
      (step) => step.name === 'Preserve candidate bytes and exact build recipe'
    )!;
    expect(artifact.with?.name).toBe(
      'native-runtime-candidate-${{ github.event.pull_request.head.sha || github.sha }}'
    );
    const publish = workflow.jobs.publish;
    expect(publish.needs).toBe('qualify');
    expect(publish.if).toBe(
      "github.event_name == 'workflow_dispatch' && needs.qualify.result == 'success'"
    );
    expect(publish.permissions).toEqual({ contents: 'write', actions: 'read' });
    expect(publish.steps[0].with).toEqual({
      ref: '${{ github.sha }}',
      'persist-credentials': false,
    });
    expect(publish.steps.at(-1)).toMatchObject({
      run: 'node scripts/publish-native-ocr.mts',
      env: {
        GH_TOKEN: '${{ github.token }}',
        EXPECTED_SOURCE_SHA: '${{ inputs.expected_source_sha }}',
      },
    });
  });
});
