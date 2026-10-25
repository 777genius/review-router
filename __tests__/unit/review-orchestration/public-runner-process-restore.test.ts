import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import { currentReviewProjectionFromEnvelope } from '../../../src/review-orchestration/infrastructure/current-review-projection-builder-adapter';
import { canonicalizeReviewProjection } from '../../../src/review-projection/domain/review-projection-canonicalizer';

/** Uses the actual production runner in two independent Node processes. All external ports are synthetic. */
test.each([false, true])(
  'full production runner restart resumes frozen A/B without inference; crash before publication request=%s',
  (beforeRequest) => {
    const root = mkdtempSync(path.join(process.cwd(), 'tmp/public-restore-'));
    const workspace = path.join(root, 'checkout');
    mkdirSync(workspace);
    execFileSync('git', ['init', '-q', workspace]);
    writeFileSync(path.join(workspace, '.git/HEAD'), `${'a'.repeat(40)}\n`);
    const stateFile = path.join(root, 'durable-state.json');
    const frozenEnvelope = {
      coverage: { state: 'complete' },
      mergeGate: { conclusion: 'pass' },
      occurrences: [],
      publishing: { inlineReviewChunks: [], lifecycle: [] },
      lifecycleStateHash: '2'.repeat(64),
      commandLedgerWatermark: '0',
    } as unknown as Parameters<typeof currentReviewProjectionFromEnvelope>[0];
    const frozenProjection =
      currentReviewProjectionFromEnvelope(frozenEnvelope);

    writeFileSync(
      stateFile,
      JSON.stringify({
        A: 'open',
        B: 'open',
        reads: 0,
        planHash: 'b'.repeat(64),
        publicationAttemptId: 'publication-original',
        projectionHash: frozenProjection.projectionHash,
        artifactId: frozenProjection.artifactId,
        envelopeJson: canonicalizeReviewProjection(frozenEnvelope),
        beforeRequest,
        finalizedAgain: false,
        publicationExists: !beforeRequest,
        finalizations: 0,
        requests: 0,
      })
    );
    const entry = path.join(root, 'restart.ts');
    const sourceRoot = path.join(process.cwd(), 'src');
    writeFileSync(
      entry,
      `
    import {readFileSync,writeFileSync} from 'node:fs';
    import {createHash} from 'node:crypto';
    import {ReviewActionV2ClientError,ReviewActionV2ClientFailureCode} from ${JSON.stringify(path.join(sourceRoot, 'control-plane/review-action-v2-client'))};
    import {ReviewActionV2OperationId} from ${JSON.stringify(path.join(sourceRoot, 'control-plane/generated/review-action-v2/review-action-v2'))};
    import {ProductionT0ReviewRunner} from ${JSON.stringify(path.join(sourceRoot, 'review-orchestration/infrastructure/production-t0-review-runner'))};
    import {GitHubReviewRevisionGuard,FreshGitHubLifecycleInventory} from ${JSON.stringify(path.join(sourceRoot, 'review-orchestration/infrastructure/github-review-state-adapter'))};
    import {PullRequestLoader} from ${JSON.stringify(path.join(sourceRoot, 'github/pr-loader'))};
    import {ConfigLoader} from ${JSON.stringify(path.join(sourceRoot, 'config/loader'))};
    import {DEFAULT_CONFIG} from ${JSON.stringify(path.join(sourceRoot, 'config/defaults'))};
    import {parseAdmittedRuntimeConfig} from ${JSON.stringify(path.join(sourceRoot, 'control-plane/runtime-config'))};
    const stateFile=process.argv[2]; const workspace=process.argv[3];
    const state=JSON.parse(readFileSync(stateFile,'utf8'));
    const facts={workspaceId:'workspace',repositoryConnectionId:'connection',scmRepositoryIdentityId:'repository',pullRequestNumber:1,headSha:'a'.repeat(40),baseSha:'d'.repeat(40),mergeBaseSha:'e'.repeat(40),reviewRevisionHash:'f'.repeat(64),producerReleaseId:'release',sourceRunId:'run',sourceRunAttempt:'1',providerVoteLanes:[]};
    const authorization={authorizationId:'authorization',authorizationToken:'synthetic-token',producerReleaseId:'release',facts,limits:{maxReconciliationDurationMs:30000}};
    ConfigLoader.load=()=>({...DEFAULT_CONFIG,providers:['codex/saved-model'],reviewThreadLifecycle:'resolve'});
    GitHubReviewRevisionGuard.prototype.loadCurrentRevision=async()=>({...facts,pullRequestState:'open'});
    FreshGitHubLifecycleInventory.prototype.loadForPrompt=async()=>{throw new Error('fresh_inventory_forbidden_during_restore');};
    PullRequestLoader.prototype.load=async()=>{throw new Error('fresh_plan_forbidden_during_restore');};
    const profile=JSON.stringify({profileRef:'fixture-codex',agentKind:'codex',binarySha256:'a'.repeat(64),packageVersion:'0.147.0',modelTransports:['account_gateway'],contextGateway:true,cancellation:true});
    const controlPlane={currentAuthorization:()=>authorization,restoreExecution:async()=>({executionId:'execution-original',version:'1',streamVersion:'1',generation:'1',planHash:state.planHash,persistedPlan:{planHash:state.planHash,artifact:{artifactId:state.artifactId,executionId:'execution-original',generation:'1',reviewedHeadSha:facts.headSha,reviewRevisionHash:facts.reviewRevisionHash,projectionHash:state.projectionHash,projectionEnvelopeCanonicalJson:state.envelopeJson,lifecycleStateHash:'2'.repeat(64),commandLedgerWatermark:'0',publicationAttemptId:state.publicationAttemptId}}}),readPublicationStatus:async({publicationAttemptId})=>{
      if(publicationAttemptId!==state.publicationAttemptId)throw new Error('new_publication_forbidden');
      state.reads++;
      if(!state.publicationExists)throw new ReviewActionV2ClientError(ReviewActionV2ClientFailureCode.ProtocolError,ReviewActionV2OperationId.ReviewPublicationStatus,{httpStatus:404});
      if(state.beforeRequest){state.A='closed';state.B='closed';writeFileSync(stateFile,JSON.stringify(state));return {terminal:true,outcome:{state:'succeeded',canonicalReceiptSetHash:'1'.repeat(64)}};}
      if(state.A==='open'){state.A='closed';writeFileSync(stateFile,JSON.stringify(state));process.exit(75);}
      if(state.A!=='closed'||state.B!=='open')throw new Error('unexpected_recovery_state');
      state.B='closed';writeFileSync(stateFile,JSON.stringify(state));
      return {terminal:true,outcome:{state:'succeeded',canonicalReceiptSetHash:'1'.repeat(64)}};
    },finalizeExecution:async({projection})=>{if(projection.artifactId!==state.artifactId||projection.projectionHash!==state.projectionHash||projection.projectionEnvelopeCanonicalJson!==state.envelopeJson)throw new Error('frozen_artifact_changed');state.finalizations++;if(!state.finalizedAgain){state.finalizedAgain=true;writeFileSync(stateFile,JSON.stringify(state));process.exit(75);}return {publicationPermit:'original-permit'};},requestPublication:async({projection})=>{if(projection.artifactId!==state.artifactId)throw new Error('new_artifact_forbidden');state.requests++;state.publicationExists=true;writeFileSync(stateFile,JSON.stringify(state));return {status:'requested',publicationAttemptId:state.publicationAttemptId,pollAfterMs:0};}};
    const fetchImpl=async()=>{throw new Error('unexpected_network_or_model_call');};
    new ProductionT0ReviewRunner(fetchImpl).run({apiUrl:'https://fixture.invalid',audience:'fixture',workflowSchemaVersion:2,repository:'fixture/disposable',pullRequestNumber:1,headSha:facts.headSha,workspacePath:workspace,scmReadToken:'synthetic-read-token',scmReadTokenExpiresAt:new Date(Date.now()+3600000).toISOString(),refreshScmReadToken:async()=>{throw new Error('unexpected_refresh');},accountGateway:{runtimeConfig:parseAdmittedRuntimeConfig({protocolVersion:1,configVersion:1,runtimeEnv:{CODEX_MODEL:'saved-model',REVIEW_ROUTER_AGENT_PROFILE_JSON:profile,REVIEW_ROUTER_AGENT_PROFILE_DIGEST:createHash('sha256').update(profile).digest('hex')}}),controlPlane,signal:new AbortController().signal,modelTransport:{environment:{},configuration:[],baseUrl:'http://127.0.0.1:1',failureFact:()=>undefined,actualModel:()=>undefined,dispose:async()=>undefined}}}).then(result=>process.stdout.write('RESTORE_RESULT:'+JSON.stringify(result))).catch(error=>{process.stderr.write(error.stack);process.exitCode=1;});
  `
    );
    const bundle = path.join(root, 'restart.cjs');
    try {
      buildSync({
        entryPoints: [entry],
        bundle: true,
        platform: 'node',
        target: 'node24',
        outfile: bundle,
        logLevel: 'silent',
        external: ['tree-sitter', 'tree-sitter-*'],
      });
      const first = spawnSync(
        process.execPath,
        [bundle, stateFile, workspace],
        {
          encoding: 'utf8',
          timeout: 15000,
        }
      );
      expect({ status: first.status, stderr: first.stderr }).toEqual({
        status: 75,
        stderr: '',
      });
      expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toMatchObject({
        A: beforeRequest ? 'open' : 'closed',
        B: 'open',
        reads: 1,
      });
      const second = spawnSync(
        process.execPath,
        [bundle, stateFile, workspace],
        {
          encoding: 'utf8',
          timeout: 15000,
        }
      );
      expect({ status: second.status, stderr: second.stderr }).toEqual({
        status: 0,
        stderr: '',
      });
      expect(
        JSON.parse(second.stdout.split('RESTORE_RESULT:')[1])
      ).toMatchObject({
        outcome: 'completed',
        publicationReceipt: { publicationAttemptId: 'publication-original' },
      });
      expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toMatchObject({
        A: 'closed',
        B: 'closed',
        reads: beforeRequest ? 3 : 2,
        planHash: 'b'.repeat(64),
        publicationAttemptId: 'publication-original',
        artifactId: frozenProjection.artifactId,
        projectionHash: frozenProjection.projectionHash,
        envelopeJson: canonicalizeReviewProjection(frozenEnvelope),
        finalizations: beforeRequest ? 2 : 0,
        requests: beforeRequest ? 1 : 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  30000
);
