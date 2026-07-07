// Manifest-shape test for the harness egress NetworkPolicy (issue #66, Z2 lock-down §4 L3).
//
// NetworkPolicy is CNI-enforced, and the local Kind CNI (kindnet) does NOT enforce it,
// so live egress-blocking can only be observed on a policy-enforcing CNI (OCP OVN-K) —
// that check is the OCP verification gate in the Z2 spec, not this test. Here we assert
// the *shape* of the static manifest (default-deny egress + the {DNS, Redis, HTTPS}
// allowlist) and that both kustomizations wire it in. Pure file parsing: no cluster,
// no kustomize binary, runs in the existing `pnpm -r test` CI.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse, parseAllDocuments } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEPLOY = resolve(REPO_ROOT, 'deploy/knative');
const POLICY_PATH = resolve(DEPLOY, 'harness-egress-policy.yaml');

function readYaml(path: string): any {
  return parse(readFileSync(path, 'utf8'));
}

/** Collect NetworkPolicy docs from a (possibly multi-doc) manifest file. */
function networkPolicies(path: string): any[] {
  return parseAllDocuments(readFileSync(path, 'utf8'))
    .map((d) => d.toJS())
    .filter((o) => o && o.kind === 'NetworkPolicy');
}

describe('harness egress NetworkPolicy manifest', () => {
  const policies = networkPolicies(POLICY_PATH);

  it('defines exactly one NetworkPolicy', () => {
    expect(policies).toHaveLength(1);
  });

  const np = policies[0] ?? {};

  it('selects the Knative harness pods', () => {
    // Knative stamps this label on the user pod; the policy must target it, not
    // an arbitrary app= label the Knative pod does not carry.
    expect(np.spec?.podSelector?.matchLabels).toMatchObject({
      'serving.knative.dev/service': 'serverless-harness',
    });
  });

  it('is egress-only (leaves ingress untouched for the Knative activator)', () => {
    expect(np.spec?.policyTypes).toEqual(['Egress']);
  });

  it('is default-deny: a finite egress allowlist with no catch-all rule', () => {
    const egress = np.spec?.egress ?? [];
    expect(egress.length).toBeGreaterThan(0);
    // A catch-all {} rule (allow all egress) would defeat default-deny. Reject any
    // rule that specifies neither a destination (`to`) nor a port restriction.
    const catchAll = egress.filter(
      (r: any) => (!r.to || r.to.length === 0) && (!r.ports || r.ports.length === 0),
    );
    expect(catchAll).toEqual([]);
  });

  it('allows DNS resolution (UDP+TCP 53)', () => {
    const egress = np.spec?.egress ?? [];
    const dnsPorts = egress.flatMap((r: any) => r.ports ?? []).filter((p: any) => p.port === 53);
    const protos = new Set(dnsPorts.map((p: any) => p.protocol));
    expect(protos.has('UDP')).toBe(true);
    expect(protos.has('TCP')).toBe(true);
  });

  it('allows Redis egress scoped to the redis pod on 6379', () => {
    const egress = np.spec?.egress ?? [];
    const redisRule = egress.find((r: any) => (r.ports ?? []).some((p: any) => p.port === 6379));
    expect(redisRule, 'a rule allowing 6379').toBeDefined();
    // Scoped to the in-cluster redis pod by label — not a broad ipBlock.
    const selectsRedisPod = (redisRule.to ?? []).some(
      (peer: any) => peer.podSelector?.matchLabels?.app === 'redis',
    );
    expect(selectsRedisPod, '6379 rule targets podSelector app=redis').toBe(true);
  });

  it('allows outbound HTTPS on 443 (external LLM + in-cluster K8s API — the M8 seam)', () => {
    const egress = np.spec?.egress ?? [];
    const httpsPorts = egress.flatMap((r: any) => r.ports ?? []).filter((p: any) => p.port === 443);
    expect(httpsPorts.length).toBeGreaterThan(0);
    expect(httpsPorts.every((p: any) => (p.protocol ?? 'TCP') === 'TCP')).toBe(true);
  });

  it("does NOT open the git-daemon port (9418) — gitd is the sandbox's peer, not the harness's", () => {
    const egress = np.spec?.egress ?? [];
    const gitdPorts = egress.flatMap((r: any) => r.ports ?? []).filter((p: any) => p.port === 9418);
    expect(gitdPorts).toEqual([]);
  });
});

describe('kustomizations wire in the egress policy', () => {
  for (const rel of ['kustomization.yaml', 'overlays/ocp/kustomization.yaml']) {
    it(`${rel} lists harness-egress-policy.yaml in resources`, () => {
      const k = readYaml(resolve(DEPLOY, rel));
      const resources: string[] = k.resources ?? [];
      // base references it bare; the OCP overlay references it via ../../ prefix.
      const referenced = resources.some((r) => r.endsWith('harness-egress-policy.yaml'));
      expect(referenced).toBe(true);
    });
  }
});
