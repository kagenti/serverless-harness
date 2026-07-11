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
import { parseAllDocuments, parse } from 'yaml';

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

describe('AB1 manifest', () => {
  const AB1_PATH = resolve(DEPLOY, 'authbridge/ab1-deployment.yaml');
  const docs = readDocs(AB1_PATH);

  it('defines exactly one Deployment named authbridge-ab1', () => {
    const deployments = docs.filter((d) => d?.kind === 'Deployment' && d?.metadata?.name === 'authbridge-ab1');
    expect(deployments).toHaveLength(1);
  });

  it('defines exactly one Service named authbridge-ab1 with a port 8080', () => {
    const services = docs.filter((d) => d?.kind === 'Service' && d?.metadata?.name === 'authbridge-ab1');
    expect(services).toHaveLength(1);
    expect(services[0].spec?.ports).toMatchObject([{ port: 8080 }]);
  });

  it('defines exactly one ConfigMap named authbridge-ab1-config', () => {
    const configMaps = docs.filter((d) => d?.kind === 'ConfigMap' && d?.metadata?.name === 'authbridge-ab1-config');
    expect(configMaps).toHaveLength(1);
  });

  const deployment = docs.find((d) => d?.kind === 'Deployment' && d?.metadata?.name === 'authbridge-ab1') ?? {};
  const configMap = docs.find((d) => d?.kind === 'ConfigMap' && d?.metadata?.name === 'authbridge-ab1-config') ?? {};
  const container = deployment.spec?.template?.spec?.containers?.[0] ?? {};

  it("the Deployment container image is dev.local/authbridge-proxy:rc1", () => {
    expect(container.image).toBe('dev.local/authbridge-proxy:rc1');
  });

  describe('embedded AB1 config (ConfigMap data["config.yaml"])', () => {
    const config = parse(configMap.data?.['config.yaml'] ?? '');

    it('runs the plugin chain under pipeline.inbound (not outbound), in order', () => {
      expect(config.pipeline?.inbound?.plugins?.map((p: any) => p.name)).toEqual([
        'inference-parser',
        'ibac',
        'static-inject',
      ]);
      expect(config.pipeline?.outbound?.plugins).toEqual([]);
    });

    it('static-inject keys off the static Anthropic backend, not the inbound Host', () => {
      const staticInject = config.pipeline.inbound.plugins.find((p: any) => p.name === 'static-inject');
      expect(staticInject.config.key_by).toBe('static');
      expect(staticInject.config.key).toBe('api.anthropic.com');
    });

    it('static-inject injects the credential into the x-api-key header', () => {
      const staticInject = config.pipeline.inbound.plugins.find((p: any) => p.name === 'static-inject');
      expect(staticInject.config.inject_header).toBe('x-api-key');
    });
  });
});
