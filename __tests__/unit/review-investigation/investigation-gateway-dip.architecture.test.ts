import { readFile } from 'fs/promises';
import path from 'path';
import { parseSource } from '../../helpers/native-source';

const APPLICATION_PORT = path.resolve(
  'src/review-investigation/application/investigation-gateway-port.ts'
);
const INVESTIGATION_ADAPTER = path.resolve(
  'src/review-investigation/infrastructure/context-gateway-v4-investigation-adapter.ts'
);
const RUNTIME_ADAPTER = path.resolve(
  'src/review-orchestration/infrastructure/context-gateway-invocation-session.ts'
);

describe('investigation gateway dependency inversion boundary', () => {
  it('keeps the application port provider-neutral and infrastructure-free', async () => {
    const source = await sourceFile(APPLICATION_PORT);
    const imports = importSpecifiers(source);

    expect(
      imports.filter((specifier) =>
        /(?:^|\/)infrastructure(?:\/|$)|(?:^|\/)providers?(?:\/|$)|review-orchestration/u.test(
          specifier
        )
      )
    ).toEqual([]);
    expect(source.text).toContain('ReviewInvestigationGatewayOpenInput');
    expect(source.text).toContain('ReviewInvestigationGatewayRevision');
    expect(source.text).not.toMatch(
      /CodexContextGatewayInvocationConfig|ProviderCredentialLease|NodeJS\.ProcessEnv/u
    );
    expect(source.text).not.toMatch(
      /(?:providerKind|executionProfile)\??:\s*string\b/u
    );
  });

  it('makes the investigation adapter own its runtime port', async () => {
    const source = await sourceFile(INVESTIGATION_ADAPTER);

    expect(importSpecifiers(source)).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/review-orchestration\/infrastructure/u),
      ])
    );
    expect(source.text).toContain(
      'InvestigationContextGatewayRuntimeFactoryPort'
    );
    expect(source.text).not.toMatch(/providerKind\??:\s*string\b/u);
    expect(source.text).not.toMatch(/executionProfile\??:\s*string\b/u);
  });

  it('keeps the runtime adapter free of provider credential/config contracts', async () => {
    const source = await sourceFile(RUNTIME_ADAPTER);

    expect(importSpecifiers(source)).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /providers\/(?:codex|claude-code|prepared-invocation)/u
        ),
      ])
    );
    expect(source.text).not.toMatch(
      /CodexContextGatewayInvocationConfig|ProviderCredentialLease/u
    );
    expect(source.text).not.toMatch(/providerKind\??:\s*string\b/u);
    expect(source.text).not.toMatch(/executionProfile\??:\s*string\b/u);
  });
});

async function sourceFile(
  filePath: string
): Promise<{ text: string; imports: string[] }> {
  const text = await readFile(filePath, 'utf8');
  const parsed = parseSource(filePath, text);
  return {
    text,
    imports: parsed.body
      .filter((statement) => statement.type === 'ImportDeclaration')
      .map((statement) => statement.source.value),
  };
}

function importSpecifiers(source: {
  imports: readonly string[];
}): readonly string[] {
  return source.imports;
}
