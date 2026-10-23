import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import {
  ContractTriple,
  createScratchChannel,
  disposeScratchChannels,
  manifestSource,
  OTHER_CONTRACT,
  parseJsonLine,
  protocolInfoBody,
  remoteTagSha,
  REPO_ROOT,
  runScript,
  ScriptResult,
  SUPPORTED_CONTRACT,
} from '../../helpers/protocol-compat-fixture';

const PROMOTE_SCRIPT = path.join(
  REPO_ROOT,
  'scripts',
  'promote-workflow-channel.mts'
);
const MONITOR_SCRIPT = path.join(
  REPO_ROOT,
  'scripts',
  'check-workflow-channel-protocol.mjs'
);

interface StubResponse {
  status: number;
  body: string;
}

let server: Server;
let protocolInfoUrl: string;
let stallResponseBody = false;
let stubResponse: StubResponse = {
  status: 200,
  body: protocolInfoBody([SUPPORTED_CONTRACT]),
};

function answerWith(contracts: readonly ContractTriple[]): void {
  stubResponse = { status: 200, body: protocolInfoBody(contracts) };
}

function answerWithRaw(status: number, body: string): void {
  stubResponse = { status, body };
}

function promoteEnv(
  fixture: ReturnType<typeof createScratchChannel>,
  overrides: Partial<NodeJS.ProcessEnv> = {}
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${fixture.binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    GITHUB_REPOSITORY: '777genius/review-router',
    GITHUB_REF: 'refs/heads/main',
    TARGET_VERSION: 'v1.9.9',
    EXPECTED_CURRENT_SHA: fixture.channelSha,
    GITHUB_TOKEN: 'dummy-token',
    PROTOCOL_INFO_URL: protocolInfoUrl,
    ...overrides,
  };
}

function monitorEnv(
  fixture: ReturnType<typeof createScratchChannel>,
  overrides: Partial<NodeJS.ProcessEnv> = {}
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PROTOCOL_INFO_URL: protocolInfoUrl,
    ...overrides,
  };
}

function runPromote(fixture: ReturnType<typeof createScratchChannel>) {
  return runScript(PROMOTE_SCRIPT, {
    cwd: fixture.workDir,
    env: promoteEnv(fixture),
  });
}

function runMonitor(fixture: ReturnType<typeof createScratchChannel>) {
  return runScript(MONITOR_SCRIPT, {
    cwd: fixture.workDir,
    env: monitorEnv(fixture),
  });
}

function expectStopped(
  result: ScriptResult,
  fixture: ReturnType<typeof createScratchChannel>,
  reason: string
): void {
  expect(result.code).toBe(1);
  const record = parseJsonLine(result.stderr);
  expect(record.code).toBe('workflow_channel_promotion_rejected');
  expect(record.phase).toBe('compat');
  expect(record.pushIssued).toBe(false);
  expect(record.pushCompleted).toBe(false);
  expect(record.outcome).toBe('not_issued');
  expect(record.reason).toBe(reason);
  expect(remoteTagSha(fixture.remoteDir, 'workflow-v1')).toBe(
    fixture.channelSha
  );
}

// The gh stub and scratch repositories are POSIX-only.
const describeOnPosix = process.platform === 'win32' ? describe.skip : describe;

describeOnPosix('workflow channel protocol compatibility gate', () => {
  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.url !== '/protocol-info') {
        response.writeHead(404).end();
        return;
      }
      if (stallResponseBody) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{"infoVersion":1,"contracts":[');
        return;
      }
      response.writeHead(stubResponse.status, {
        'content-type': 'application/json',
      });
      response.end(stubResponse.body);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    protocolInfoUrl = `http://127.0.0.1:${
      (server.address() as AddressInfo).port
    }/protocol-info`;
  });

  afterAll(async () => {
    disposeScratchChannels();
    await new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  });

  it('promotes a candidate whose contract the API supports', async () => {
    const fixture = createScratchChannel();
    answerWith([SUPPORTED_CONTRACT, OTHER_CONTRACT]);

    const result = await runPromote(fixture);

    expect(result.code).toBe(0);
    const record = parseJsonLine(result.stdout);
    expect(record.channel).toBe('workflow-v1');
    expect(record.promoted).toBe(true);
    expect(record.targetSha).toBe(fixture.targetSha);
    expect(record.previousSha).toBe(fixture.channelSha);
    expect(remoteTagSha(fixture.remoteDir, 'workflow-v1')).toBe(
      fixture.targetSha
    );
  }, 30000);

  it('stops promotion when the API supports only another digest', async () => {
    const fixture = createScratchChannel({
      targetManifest: manifestSource(OTHER_CONTRACT),
    });
    answerWith([SUPPORTED_CONTRACT]);

    const result = await runPromote(fixture);

    expectStopped(result, fixture, 'protocol_incompatible');
  }, 30000);

  it('stops promotion with a reason when protocol-info is unreachable', async () => {
    const fixture = createScratchChannel();
    const result = await runScript(PROMOTE_SCRIPT, {
      cwd: fixture.workDir,
      env: promoteEnv(fixture, {
        PROTOCOL_INFO_URL: 'http://127.0.0.1:1/protocol-info',
      }),
    });

    expectStopped(result, fixture, 'protocol_info_unavailable');
  }, 30000);

  it('reports the channel contract when the channel is compatible', async () => {
    const fixture = createScratchChannel();
    answerWith([SUPPORTED_CONTRACT, OTHER_CONTRACT]);

    const result = await runMonitor(fixture);

    expect(result.code).toBe(0);
    const record = parseJsonLine(result.stdout);
    expect(record.code).toBe('workflow_channel_protocol_check_passed');
    expect(record.channel).toBe('workflow-v1');
    expect(record.channelSha).toBe(fixture.channelSha);
    expect(record.contract).toEqual({
      protocolVersion: '2',
      schemaDigest: SUPPORTED_CONTRACT.schemaDigest,
      canonicalizerDigest: SUPPORTED_CONTRACT.canonicalizerDigest,
    });
  }, 30000);

  it('reports protocol_incompatible when the API bypassed the procedure', async () => {
    const fixture = createScratchChannel();
    answerWith([OTHER_CONTRACT]);

    const result = await runMonitor(fixture);

    expect(result.code).toBe(1);
    const record = parseJsonLine(result.stderr);
    expect(record.code).toBe('workflow_channel_protocol_check_failed');
    expect(record.channel).toBe('workflow-v1');
    expect(record.channelSha).toBe(fixture.channelSha);
    expect(record.reason).toBe('protocol_incompatible');
  }, 30000);

  it('reports action_manifest_invalid when the channel manifest is missing', async () => {
    const fixture = createScratchChannel({ channelManifest: null });
    answerWith([SUPPORTED_CONTRACT, OTHER_CONTRACT]);

    const result = await runMonitor(fixture);

    expect(result.code).toBe(1);
    const record = parseJsonLine(result.stderr);
    expect(record.code).toBe('workflow_channel_protocol_check_failed');
    expect(record.channelSha).toBe(fixture.channelSha);
    expect(record.reason).toBe('action_manifest_invalid');
  }, 30000);

  it('reports protocol_info_invalid when protocol-info returns a malformed body', async () => {
    const fixture = createScratchChannel();
    answerWithRaw(200, 'not-json');

    const result = await runMonitor(fixture);

    expect(result.code).toBe(1);
    const record = parseJsonLine(result.stderr);
    expect(record.code).toBe('workflow_channel_protocol_check_failed');
    expect(record.reason).toBe('protocol_info_invalid');
  }, 30000);

  it('reports protocol_info_unavailable when the protocol-info body stalls past the timeout', async () => {
    const fixture = createScratchChannel();
    stallResponseBody = true;
    try {
      const result = await runMonitor(fixture);

      expect(result.code).toBe(1);
      const record = parseJsonLine(result.stderr);
      expect(record.code).toBe('workflow_channel_protocol_check_failed');
      expect(record.reason).toBe('protocol_info_unavailable');
    } finally {
      stallResponseBody = false;
    }
  }, 30000);
});
