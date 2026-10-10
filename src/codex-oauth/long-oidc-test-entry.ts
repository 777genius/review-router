// Separate immutable TEST artifact composition, never part of attested49f.
import { appendFileSync } from 'node:fs';
import { runAccountGatewayRuntime } from './account-gateway-runtime';
import { runLongOidcTestRuntime } from './long-oidc-runtime';

type Inputs = Parameters<typeof runAccountGatewayRuntime>[0];
type Ports = Parameters<typeof runAccountGatewayRuntime>[1];

export async function runLongOidcTestEntry(inputs: Inputs, ports: Ports): Promise<void> {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) throw new Error('long_oidc_github_summary_required');
  await runLongOidcTestRuntime(inputs, ports, (observation) => {
    // Adapter projects timestamps/authority ID only. No arbitrary error or body.
    const receipt = `Long OIDC TEST: ${JSON.stringify(observation)}`;
    appendFileSync(summary, `\n${receipt}\n`, 'utf8');
    console.log(receipt);
  }, {
    repository: '777genius/rr-selfhost-direct-v2-e2e-20260730t120036z',
    model: 'mimo-v2.6-pro',
  });
}
