import { execFile } from 'child_process';
import { promisify } from 'util';
import { classifyUtf8Content } from '../../context-gateway/utf8-content';
import { ImmutableSourceReader, SourceReadResult } from '../domain/contracts';
import { REVALIDATION_LIMITS } from '../domain/packet';

const execFileAsync = promisify(execFile);

/** No checkout reads: both the path lookup and bytes come from the captured Git object. */
export function createGitImmutableSourceReader(
  input: Readonly<{ repositoryRoot: string }>
): ImmutableSourceReader {
  async function git(
    args: readonly string[],
    maxBuffer: number
  ): Promise<Buffer> {
    const result = await execFileAsync(
      'git',
      ['--no-replace-objects', '-C', input.repositoryRoot, ...args],
      { encoding: 'buffer', maxBuffer, timeout: 10_000 }
    );
    return result.stdout;
  }
  return {
    async read({ headSha, path, maxBytes }): Promise<SourceReadResult> {
      if (
        !/^[a-f0-9]{40}$/.test(headSha) ||
        !path ||
        Buffer.byteLength(path, 'utf8') > 4096 ||
        path.startsWith('/') ||
        path.includes('\\') ||
        path.includes('\0') ||
        path
          .split('/')
          .some((segment) => !segment || segment === '.' || segment === '..') ||
        !Number.isInteger(maxBytes) ||
        maxBytes <= 0
      )
        return { kind: 'unsupported' };
      const limit = Math.min(maxBytes, REVALIDATION_LIMITS.fileBytes);
      try {
        const tree = await git(
          ['ls-tree', '-z', headSha, '--', `:(literal)${path}`],
          16 * 1024
        );
        if (!tree.length) return { kind: 'missing' };
        const entries = tree.toString('utf8').split('\0');
        if (entries.length !== 2 || entries[1] !== '')
          return { kind: 'unsupported' };
        const entry = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(
          entries[0]!
        );
        if (!entry || entry[3] !== path) return { kind: 'unsupported' };
        const blobOid = entry[2]!;
        const sizeText = (await git(['cat-file', '-s', blobOid], 128))
          .toString('utf8')
          .trim();
        if (!/^\d+$/.test(sizeText)) return { kind: 'unsupported' };
        const size = Number(sizeText);
        if (!Number.isSafeInteger(size) || size > limit)
          return { kind: 'oversized' };
        const bytes = await git(
          ['cat-file', 'blob', blobOid],
          Math.max(1, limit)
        );
        if (
          bytes.byteLength !== size ||
          classifyUtf8Content(bytes).kind !== 'text'
        )
          return { kind: 'unsupported' };
        return { kind: 'file', headSha, path, blobOid, bytes };
      } catch {
        // Git diagnostics may contain local paths or content; expose only a safe category.
        return { kind: 'unsupported' };
      }
    },
  };
}
