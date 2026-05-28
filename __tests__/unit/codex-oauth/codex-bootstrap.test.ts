import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ensureCodexOAuthRuntimeParent } from '../../../src/codex-oauth/codex-bootstrap';

describe('Codex OAuth bootstrap runtime directory', () => {
  it('places Codex home material under the runner home instead of system tmp', async () => {
    const home = await fs.mkdtemp(
      path.join(os.homedir(), '.reviewrouter-test-home-')
    );
    try {
      const parent = await ensureCodexOAuthRuntimeParent({ HOME: home });

      expect(parent).toBe(path.join(home, '.reviewrouter', 'runtime'));
      expect(parent.startsWith(os.tmpdir())).toBe(false);
      await expect(fs.access(parent)).resolves.toBeUndefined();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it('falls back to a scoped temp directory when HOME is not absolute', async () => {
    const parent = await ensureCodexOAuthRuntimeParent({ HOME: 'relative' });

    expect(parent).toBe(path.join(os.tmpdir(), 'reviewrouter-runtime'));
    await expect(fs.access(parent)).resolves.toBeUndefined();
  });
});
