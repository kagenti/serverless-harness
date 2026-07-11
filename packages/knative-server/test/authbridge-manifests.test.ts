// Manifest-shape tests for the RC1 AuthBridge path. These manifests are applied only when
// SH_AUTHBRIDGE=1 is enabled on the harness; they are inert (never applied) in the default flow
// and are not wired into any kustomization base. As with harness-egress-policy.test.ts, this is
// pure file parsing: no cluster, no kustomize binary, runs in the existing `pnpm -r test` CI.
//
// This file will grow as further RC1 AuthBridge manifests land (AB1/AB2); keep each manifest's
// assertions in its own `describe` block below.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parseAllDocuments } from 'yaml';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEPLOY = resolve(REPO_ROOT, 'deploy/knative');

/** Parse every YAML document in a (possibly multi-doc) manifest file into plain JS objects. */
function readDocs(path: string): any[] {
  return parseAllDocuments(readFileSync(path, 'utf8')).map((d) => d.toJS());
}

describe('ibac-stub manifest', () => {
  const IBAC_STUB_PATH = resolve(DEPLOY, 'ibac-stub.yaml');
  const docs = readDocs(IBAC_STUB_PATH);

  it('defines exactly one Deployment named ibac-stub', () => {
    const deployments = docs.filter((d) => d?.kind === 'Deployment' && d?.metadata?.name === 'ibac-stub');
    expect(deployments).toHaveLength(1);
  });

  it('defines exactly one Service named ibac-stub', () => {
    const services = docs.filter((d) => d?.kind === 'Service' && d?.metadata?.name === 'ibac-stub');
    expect(services).toHaveLength(1);
  });

  const deployment = docs.find((d) => d?.kind === 'Deployment' && d?.metadata?.name === 'ibac-stub') ?? {};
  const service = docs.find((d) => d?.kind === 'Service' && d?.metadata?.name === 'ibac-stub') ?? {};
  const container = deployment.spec?.template?.spec?.containers?.[0] ?? {};

  it("the Deployment's container exposes containerPort 8080", () => {
    expect(container.ports).toMatchObject([{ containerPort: 8080 }]);
  });

  it('the container env includes IBAC_STUB_PORT', () => {
    const envNames = (container.env ?? []).map((e: any) => e.name);
    expect(envNames).toContain('IBAC_STUB_PORT');
  });

  it('the Service exposes port 8080 targeting 8080', () => {
    expect(service.spec?.ports).toMatchObject([{ port: 8080, targetPort: 8080 }]);
  });

  it("the Service's selector matches the Deployment's pod labels", () => {
    const podLabels = deployment.spec?.template?.metadata?.labels ?? {};
    expect(service.spec?.selector).toEqual(podLabels);
  });
});
