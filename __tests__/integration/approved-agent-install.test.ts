import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareCodexCliBeforeAuthRead } from '../../src/codex-oauth/codex-cli';
import type { ApprovedReviewAgent } from '../../src/control-plane/approved-review-agent';

const linuxTest =
  process.platform === 'linux' && process.arch === 'x64' ? test : test.skip;

linuxTest(
  'approved installation rejects drift without executing candidate binaries',
  async () => {
    const root = await mkdtemp(
      join(tmpdir(), 'TEST-reviewrouter-approved-install-')
    );
    const previousPath = process.env.PATH;
    const previousBinary = process.env.REVIEWROUTER_CODEX_BINARY;
    const marker = join(root, 'unexpected-execution');
    const native = `#!/bin/sh\nprintf executed > '${marker}'\n`;
    const profile: ApprovedReviewAgent = {
      profileRef: 'qualified-test',
      agentKind: 'codex',
      binarySha256: createHash('sha256').update(native).digest('hex'),
      packageVersion: '0.147.0',
      modelTransports: ['account_gateway'],
      contextGateway: true,
      cancellation: true,
    };
    try {
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ type: 'commonjs' })
      );
      await mkdir(join(root, 'bin'));
      const npm = join(root, 'bin/npm');
      await writeFile(
        npm,
        `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path'); const a=process.argv.slice(2); if(!a.includes('--ignore-scripts')||!a.includes('@openai/codex@0.147.0')) process.exit(2); const r=a[a.indexOf('--prefix')+1]; const p=path.join(r,'node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex'); fs.mkdirSync(path.dirname(p),{recursive:true}); fs.writeFileSync(p,${JSON.stringify(native)}); fs.chmodSync(p,0o700);\n`
      );
      await chmod(npm, 0o700);
      process.env.PATH = `${join(root, 'bin')}:${previousPath ?? ''}`;
      process.env.REVIEWROUTER_CODEX_BINARY = marker;
      const cli = await prepareCodexCliBeforeAuthRead({
        approvedAgent: profile,
      });
      try {
        assert.equal(await readFile(cli.binaryPath, 'utf8'), native);
      } finally {
        await cli.clear?.();
      }
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
      await assert.rejects(
        prepareCodexCliBeforeAuthRead({
          approvedAgent: { ...profile, binarySha256: 'b'.repeat(64) },
        }),
        /review_agent_binary_drift/
      );
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousBinary === undefined)
        delete process.env.REVIEWROUTER_CODEX_BINARY;
      else process.env.REVIEWROUTER_CODEX_BINARY = previousBinary;
      await rm(root, { recursive: true, force: true });
    }
  }
);
