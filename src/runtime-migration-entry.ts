import * as core from './actions/core';
import { runCodexRuntimeMigration } from './codex-oauth/runtime-migration';

const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGTERM', cancel);
process.once('SIGINT', cancel);

void runCodexRuntimeMigration({ signal: controller.signal })
  .then((result) => {
    core.setOutput('status', result.status);
    core.info(
      'The existing credential was confirmed in the new runtime namespace.'
    );
  })
  .catch(() => {
    // Capabilities and auth bytes never become diagnostics. The dashboard
    // resolves the original migration and its durable setup status.
    core.setFailed(
      'Runtime migration did not complete. Check its status in the ReviewRouter dashboard before continuing.'
    );
  })
  .finally(() => {
    process.removeListener('SIGTERM', cancel);
    process.removeListener('SIGINT', cancel);
  });
