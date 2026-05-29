import {
  clearCodexRotatingOidcRequestEnv,
  clearCodexRotatingProcessAuthEnv,
  readCodexRotatingAuthInput,
} from './auth-input';
import {
  CodexRotatingCheckoutTokenResponse,
  CodexRotatingCommentTokenResponse,
  CodexRotatingFinalizeResponse,
  CodexRotatingPreleaseResponse,
  CodexRotatingWritebackPreflightResponse,
  CodexRotatingWritebackResponse,
} from './control-plane';
import {
  buildCodexRotatingWritebackRequest,
  compactCodexAuthJsonBytes,
  computeCodexAuthGenerationHash,
  encryptCodexAuthForGitHubSecret,
} from './crypto';
import * as path from 'path';
import type { Review } from '../types';

export type CodexOAuthRuntimeInputs = {
  apiUrl: string;
  audience: string;
  providerInstanceId: string;
  workflowSchemaVersion: number;
  repository: string;
  headSha: string;
  workspacePath: string;
};

export type CodexOAuthRuntimePorts = {
  oidc: {
    requestToken(audience: string): Promise<string>;
  };
  controlPlane: {
    prelease(input: {
      oidcToken: string;
      audience: string;
      providerInstanceId: string;
      workflowSchemaVersion: number;
    }): Promise<CodexRotatingPreleaseResponse>;
    finalize(input: {
      leaseId: string;
      providerInstanceId: string;
      restoredGenerationHash: string;
    }): Promise<CodexRotatingFinalizeResponse>;
    writebackPreflight(input: {
      leaseId: string;
      providerInstanceId: string;
      githubKeyId: string;
    }): Promise<CodexRotatingWritebackPreflightResponse>;
    writeback(
      body: Record<string, unknown>
    ): Promise<CodexRotatingWritebackResponse>;
    checkoutToken(input: {
      leaseId: string;
      providerInstanceId: string;
    }): Promise<CodexRotatingCheckoutTokenResponse>;
    commentToken(input: {
      leaseId: string;
      providerInstanceId: string;
      authCleared: true;
    }): Promise<CodexRotatingCommentTokenResponse>;
  };
  githubSecrets: {
    fetchPublicKey(input: {
      owner: string;
      repo: string;
      token: string;
    }): Promise<{ keyId: string; key: string }>;
  };
  codex: {
    prepareCli?(): Promise<{
      binaryPath: string;
      clear?(): Promise<void>;
    }>;
    refreshAuth(input: {
      authJsonBytes: string;
      codexBinaryPath?: string;
    }): Promise<{
      authJsonBytes: string;
      codexHome: string;
      clearAuthMaterial(): Promise<void>;
    }>;
  };
  checkout: {
    checkoutExactHead(input: {
      repository: string;
      headSha: string;
      workspacePath: string;
      token: string;
    }): Promise<void>;
  };
  review: {
    run(input: {
      checkoutToken: string;
      codexHome: string;
      codexBinaryPath?: string;
    }): Promise<CodexOAuthReviewResult>;
  };
  comments: {
    post(input: {
      commentToken: string;
      review: CodexOAuthReviewResult;
    }): Promise<void>;
  };
  lifecycle?: {
    clearOidcEnv?(): void;
    clearProcessAuthEnv?(): void;
  };
};

export type CodexOAuthReviewResult = {
  skipped: boolean;
  blockingFailure?: string;
  userDryRun?: boolean;
  markdown?: string;
  review?: Review;
};

export type CodexOAuthRuntimeResult =
  | {
      status: 'completed';
      review: CodexOAuthReviewResult;
    }
  | {
      status: 'skipped';
      reason:
        | 'stale_queued_secret'
        | 'lease_not_active'
        | 'permission_required'
        | 'github_put_failed'
        | 'writeback_idempotency_conflict';
    };

export async function runCodexOAuthRotatingRuntime(
  input: CodexOAuthRuntimeInputs,
  ports: CodexOAuthRuntimePorts
): Promise<CodexOAuthRuntimeResult> {
  let refreshed:
    | {
        authJsonBytes: string;
        codexHome: string;
        clearAuthMaterial(): Promise<void>;
      }
    | undefined;
  let preparedCodexCli:
    | {
        binaryPath: string;
        clear?(): Promise<void>;
      }
    | undefined;
  let authMaterialCleared = false;
  let previousCodexBinary: string | undefined;
  let previousPath: string | undefined;
  let preparedCodexCliEnvApplied = false;

  const clearAuth = async () => {
    ports.lifecycle?.clearOidcEnv?.();
    if (preparedCodexCliEnvApplied) {
      if (previousCodexBinary === undefined) {
        delete process.env.REVIEWROUTER_CODEX_BINARY;
      } else {
        process.env.REVIEWROUTER_CODEX_BINARY = previousCodexBinary;
      }
      if (previousPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = previousPath;
      }
      preparedCodexCliEnvApplied = false;
    }
    if (refreshed) {
      await refreshed.clearAuthMaterial();
      refreshed = undefined;
    }
    if (preparedCodexCli?.clear) {
      await preparedCodexCli.clear();
      preparedCodexCli = undefined;
    }
    ports.lifecycle?.clearProcessAuthEnv?.();
    authMaterialCleared = true;
  };

  try {
    const oidcToken = await ports.oidc.requestToken(input.audience);
    const prelease = await ports.controlPlane.prelease({
      oidcToken,
      audience: input.audience,
      providerInstanceId: input.providerInstanceId,
      workflowSchemaVersion: input.workflowSchemaVersion,
    });
    preparedCodexCli = await ports.codex.prepareCli?.();
    if (preparedCodexCli) {
      previousCodexBinary = process.env.REVIEWROUTER_CODEX_BINARY;
      previousPath = process.env.PATH;
      const codexBinDir = path.dirname(preparedCodexCli.binaryPath);
      process.env.REVIEWROUTER_CODEX_BINARY = preparedCodexCli.binaryPath;
      process.env.PATH = previousPath
        ? `${codexBinDir}${path.delimiter}${previousPath}`
        : codexBinDir;
      preparedCodexCliEnvApplied = true;
    }

    const restoredAuth = readCodexRotatingAuthInput().authJsonBytes;
    const restoredCompact = compactCodexAuthJsonBytes({
      authJsonBytes: restoredAuth,
    });
    const restoredGenerationHash = computeCodexAuthGenerationHash({
      authJsonBytes: restoredCompact.compactAuthJsonBytes,
      generationHashSalt: prelease.generationHashSalt,
    });

    const finalized = await ports.controlPlane.finalize({
      leaseId: prelease.leaseId,
      providerInstanceId: input.providerInstanceId,
      restoredGenerationHash,
    });
    if (finalized.status === 'stale_queued_secret') {
      await clearAuth();
      return { status: 'skipped', reason: 'stale_queued_secret' };
    }

    const publicKey = await ports.githubSecrets.fetchPublicKey({
      owner: finalized.repositoryOwner,
      repo: finalized.repositoryName,
      token: finalized.publicKeyReadToken,
    });
    const preflight = await ports.controlPlane.writebackPreflight({
      leaseId: prelease.leaseId,
      providerInstanceId: input.providerInstanceId,
      githubKeyId: publicKey.keyId,
    });
    if (preflight.status === 'skipped') {
      await clearAuth();
      return { status: 'skipped', reason: preflight.reason };
    }

    refreshed = await ports.codex.refreshAuth({
      authJsonBytes: restoredCompact.compactAuthJsonBytes,
      ...(preparedCodexCli
        ? { codexBinaryPath: preparedCodexCli.binaryPath }
        : {}),
    });
    const encrypted = await encryptCodexAuthForGitHubSecret({
      authJsonBytes: refreshed.authJsonBytes,
      githubPublicKeyBase64: publicKey.key,
      githubKeyId: publicKey.keyId,
      generationHashSalt: prelease.generationHashSalt,
    });
    const writeback = await ports.controlPlane.writeback(
      buildCodexRotatingWritebackRequest({
        leaseId: prelease.leaseId,
        providerInstanceId: input.providerInstanceId,
        generation: finalized.nextGeneration,
        latestGenerationHash: encrypted.latestGenerationHash,
        encryptedValue: encrypted.encryptedValue,
        keyId: encrypted.keyId,
      })
    );
    if (
      writeback.status !== 'accepted' &&
      writeback.status !== 'idempotent_replay'
    ) {
      await clearAuth();
      return { status: 'skipped', reason: writeback.status };
    }

    const checkoutToken = await ports.controlPlane.checkoutToken({
      leaseId: prelease.leaseId,
      providerInstanceId: input.providerInstanceId,
    });
    await ports.checkout.checkoutExactHead({
      repository: input.repository,
      headSha: input.headSha,
      workspacePath: input.workspacePath,
      token: checkoutToken.token,
    });
    const review = await ports.review.run({
      checkoutToken: checkoutToken.token,
      codexHome: refreshed.codexHome,
      ...(preparedCodexCli
        ? { codexBinaryPath: preparedCodexCli.binaryPath }
        : {}),
    });

    await clearAuth();
    const commentToken = await ports.controlPlane.commentToken({
      leaseId: prelease.leaseId,
      providerInstanceId: input.providerInstanceId,
      authCleared: true,
    });
    await ports.comments.post({
      commentToken: commentToken.token,
      review,
    });
    return { status: 'completed', review };
  } finally {
    if (!authMaterialCleared) {
      await clearAuth().catch(() => undefined);
      clearCodexRotatingAuthInputSafe();
    }
  }
}

function clearCodexRotatingAuthInputSafe(): void {
  clearCodexRotatingOidcRequestEnv();
  clearCodexRotatingProcessAuthEnv();
}
