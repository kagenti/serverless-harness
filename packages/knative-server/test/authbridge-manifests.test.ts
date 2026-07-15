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

/** Find a container by name within a pod-spec-shaped containers array. */
function findContainer(containers: any[] | undefined, name: string): any {
  return (containers ?? []).find((c: any) => c?.name === name) ?? {};
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

  it("the Deployment container image is the official kext authbridge image", () => {
    expect(container.image).toBe('ghcr.io/kagenti/kagenti-extensions/authbridge:main-9c131ee');
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

describe('echo-target manifest', () => {
  const ECHO_TARGET_PATH = resolve(DEPLOY, 'echo-target.yaml');
  const docs = readDocs(ECHO_TARGET_PATH);

  it('defines exactly one Deployment named echo-target', () => {
    const deployments = docs.filter((d) => d?.kind === 'Deployment' && d?.metadata?.name === 'echo-target');
    expect(deployments).toHaveLength(1);
  });

  it('defines exactly one Service named echo-target', () => {
    const services = docs.filter((d) => d?.kind === 'Service' && d?.metadata?.name === 'echo-target');
    expect(services).toHaveLength(1);
  });

  const deployment = docs.find((d) => d?.kind === 'Deployment' && d?.metadata?.name === 'echo-target') ?? {};
  const service = docs.find((d) => d?.kind === 'Service' && d?.metadata?.name === 'echo-target') ?? {};

  it('the Service exposes port 80 targeting containerPort 8080', () => {
    expect(service.spec?.ports).toMatchObject([{ port: 80, targetPort: 8080 }]);
  });

  it("the Service's selector matches the Deployment's pod labels", () => {
    const podLabels = deployment.spec?.template?.metadata?.labels ?? {};
    expect(service.spec?.selector).toEqual(podLabels);
  });
});

describe('AB2 manifest', () => {
  const AB2_PATH = resolve(DEPLOY, 'authbridge/ab2-config.yaml');
  const docs = readDocs(AB2_PATH);

  it('defines exactly one ConfigMap named authbridge-ab2-config', () => {
    const configMaps = docs.filter((d) => d?.kind === 'ConfigMap' && d?.metadata?.name === 'authbridge-ab2-config');
    expect(configMaps).toHaveLength(1);
  });

  const configMap = docs.find((d) => d?.kind === 'ConfigMap' && d?.metadata?.name === 'authbridge-ab2-config') ?? {};

  describe('embedded AB2 config (ConfigMap data["config.yaml"])', () => {
    const config = parse(configMap.data?.['config.yaml'] ?? '');

    it('sets the boot-critical top-level fields for proxy-sidecar mode', () => {
      // These are not covered by the pipeline/plugin assertions below, but without them AB2
      // fails to boot (mode, forward_proxy_addr) or fails config validation (reverse_proxy_addr/
      // reverse_proxy_backend are required in proxy-sidecar mode even though unused inbound here).
      expect(config.mode).toBe('proxy-sidecar');
      expect(config.listener?.forward_proxy_addr).toBe(':8081');
      expect(config.listener?.reverse_proxy_addr).toBeTruthy();
      expect(config.listener?.reverse_proxy_backend).toBeTruthy();
    });

    it('runs the plugin chain under pipeline.outbound (not inbound), in order', () => {
      expect(config.pipeline?.outbound?.plugins?.map((p: any) => p.name)).toEqual([
        'mcp-parser',
        'ibac',
        'static-inject',
      ]);
      expect(config.pipeline?.inbound?.plugins).toEqual([]);
    });

    it('static-inject keys off the destination host, with no inject_header override', () => {
      const staticInject = config.pipeline.outbound.plugins.find((p: any) => p.name === 'static-inject');
      expect(staticInject.config.key_by).toBe('host');
      expect(staticInject.config).not.toHaveProperty('inject_header');
    });

    it('ibac denies unclassified no-session requests but passes through unclassified traffic', () => {
      const ibac = config.pipeline.outbound.plugins.find((p: any) => p.name === 'ibac');
      expect(ibac.config.no_intent_policy).toBe('deny');
      expect(ibac.config.unclassified_policy).toBe('passthrough');
    });
  });
});

describe('sandbox-pool-ab2 manifest (SH_AUTHBRIDGE variant)', () => {
  const SANDBOX_POOL_AB2_PATH = resolve(DEPLOY, 'sandbox-pool-ab2.yaml');
  const docs = readDocs(SANDBOX_POOL_AB2_PATH);
  const sandboxes = docs.filter((d) => d?.kind === 'Sandbox');

  it('defines exactly 3 Sandbox CRs (sandbox-0/1/2)', () => {
    expect(sandboxes.map((s) => s.metadata?.name)).toEqual(['sandbox-0', 'sandbox-1', 'sandbox-2']);
  });

  it.each(sandboxes.map((s, i) => [i, s]))('sandbox %s: pod has an authbridge-ab2 sidecar container', (_i, sandbox: any) => {
    const containers = sandbox.spec?.podTemplate?.spec?.containers ?? [];
    const ab2 = findContainer(containers, 'authbridge-ab2');
    expect(ab2.image).toBe('ghcr.io/kagenti/kagenti-extensions/authbridge:main-9c131ee');
    expect(ab2.args).toEqual(['--config', '/etc/authbridge/config.yaml']);
  });

  it.each(sandboxes.map((s, i) => [i, s]))('sandbox %s: sandbox container is first and sets HTTP(S)_PROXY', (_i, sandbox: any) => {
    const containers = sandbox.spec?.podTemplate?.spec?.containers ?? [];
    expect(containers[0]?.name).toBe('sandbox');
    const envNames = Object.fromEntries((containers[0]?.env ?? []).map((e: any) => [e.name, e.value]));
    expect(envNames.HTTP_PROXY).toBe('http://localhost:8081');
    expect(envNames.HTTPS_PROXY).toBe('http://localhost:8081');
    // curl ignores uppercase HTTP_PROXY for http:// URLs (only lowercase http_proxy is honored
    // there); both cases must be set so the sandbox's plain `curl http://...` egress actually
    // transits AB2.
    expect(envNames.http_proxy).toBe('http://localhost:8081');
    expect(envNames.https_proxy).toBe('http://localhost:8081');
  });

  it.each(sandboxes.map((s, i) => [i, s]))('sandbox %s: sandbox container uses the pre-baked image (no apk-at-startup)', (_i, sandbox: any) => {
    const containers = sandbox.spec?.podTemplate?.spec?.containers ?? [];
    const sandboxContainer = findContainer(containers, 'sandbox');
    // Tools (bash, coreutils, findutils, grep, ripgrep, git, curl) are baked into the image
    // (deploy/knative/sandbox.Dockerfile) at build time instead of `apk add`-ed at container
    // startup — apk-at-startup was slow/racy under load (2-3 min) and had to bypass the AB2
    // proxy env below to reach the Alpine CDN. No such bypass is needed anymore.
    expect(sandboxContainer.image).toBe('dev.local/sandbox-rc1:rc1');
    expect(sandboxContainer.imagePullPolicy).toBe('IfNotPresent');
    const command = (sandboxContainer.command ?? []).join(' ');
    expect(command).toContain('sleep infinity');
    expect(command).not.toContain('apk');
  });

  it.each(sandboxes.map((s, i) => [i, s]))('sandbox %s: pod volumes mount the AB2 config and creds', (_i, sandbox: any) => {
    const volumes = sandbox.spec?.podTemplate?.spec?.volumes ?? [];
    const config = volumes.find((v: any) => v.name === 'config');
    const creds = volumes.find((v: any) => v.name === 'creds');
    expect(config?.configMap?.name).toBe('authbridge-ab2-config');
    expect(creds?.secret?.secretName).toBe('ab2-egress-cred');
  });

  it.each(sandboxes.map((s, i) => [i, s]))('sandbox %s: sandbox container does NOT mount the creds secret (secret-free invariant)', (_i, sandbox: any) => {
    const containers = sandbox.spec?.podTemplate?.spec?.containers ?? [];
    const sandboxContainer = findContainer(containers, 'sandbox');
    const mounts = sandboxContainer.volumeMounts ?? [];
    expect(mounts.some((m: any) => m.name === 'creds' || m.mountPath === '/etc/authbridge/creds')).toBe(false);
  });

  it.each(sandboxes.map((s, i) => [i, s]))('sandbox %s: authbridge-ab2 sidecar DOES mount the creds secret', (_i, sandbox: any) => {
    const containers = sandbox.spec?.podTemplate?.spec?.containers ?? [];
    const ab2 = findContainer(containers, 'authbridge-ab2');
    const mounts = ab2.volumeMounts ?? [];
    expect(mounts.some((m: any) => m.name === 'creds' && m.mountPath === '/etc/authbridge/creds')).toBe(true);
  });
});

// Cross-file invariant (issue #103): setup-ocp.sh's SH_AUTHBRIDGE=1 pool pre-poll computes its
// target container count `ab2_want` from `kubectl get sandbox -l <selector>`. A `get sandbox` label
// selector matches the Sandbox CR's OWN metadata.labels — NOT the podTemplate labels. So if the
// selector names a podTemplate-only label (e.g. sh.kagenti.io/sandbox-pool=default, which lives on
// podTemplate.metadata.labels for pod discovery), the count is always 0, `ab2_want` stays 0, the
// loop's `[ "$ab2_want" -gt 0 ]` early-break never fires, and the poll burns its full ~150×2s ≈ 5m
// budget before the authoritative `kubectl wait` gates. Pin the count selector to a label the
// Sandbox CRs actually carry. Pure file parsing — no cluster, no kubectl — runs in `pnpm -r test`.
describe('setup-ocp.sh AB2 pool pre-poll sandbox count (issue #103)', () => {
  const script = readFileSync(resolve(DEPLOY, 'setup-ocp.sh'), 'utf8');
  const lines = script.split('\n');
  const sandboxes = readDocs(resolve(DEPLOY, 'sandbox-pool-ab2.yaml')).filter((d) => d?.kind === 'Sandbox');

  /** Resolve a shell selector token to its literal value, following one level of `VAR=...`. */
  function resolveSelectorToken(token: string): string {
    const varName = token.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/)?.[1];
    if (!varName) return token;
    const assign = lines.find((l) => new RegExp(`^\\s*${varName}=`).test(l));
    return assign?.match(new RegExp(`^\\s*${varName}=["']?([^"']*)["']?`))?.[1] ?? token;
  }

  // The line that derives ab2_want from a `kubectl get sandbox -l <token>` count.
  const ab2WantLine = lines.find((l) => /ab2_want=/.test(l) && /get sandbox/.test(l));

  it('computes ab2_want from a `get sandbox -l <selector>` count', () => {
    expect(ab2WantLine, 'setup-ocp.sh must compute ab2_want from `get sandbox -l`').toBeDefined();
  });

  it('counts Sandbox CRs by a label the CRs actually carry (not a podTemplate-only label)', () => {
    const rawToken = ab2WantLine!.match(/get sandbox\b.*?-l\s+(\S+)/)?.[1]?.replace(/["']/g, '');
    expect(rawToken, 'could not extract the -l selector from the ab2_want line').toBeTruthy();
    const selector = resolveSelectorToken(rawToken!);
    const eq = selector.indexOf('=');
    expect(eq, `selector '${selector}' is not a key=value form`).toBeGreaterThan(0);
    const key = selector.slice(0, eq);
    const value = selector.slice(eq + 1);

    expect(sandboxes.length).toBeGreaterThan(0);
    for (const s of sandboxes) {
      const crLabels = s.metadata?.labels ?? {};
      expect(
        crLabels[key],
        `Sandbox ${s.metadata?.name} carries no metadata.label '${key}', so ` +
          `\`kubectl get sandbox -l ${selector}\` returns 0 rows → ab2_want stays 0 → the pre-poll ` +
          `spins its full ~5m timeout (issue #103). A get-sandbox selector must match a CR label, ` +
          `not a podTemplate label.`,
      ).toBe(value);
    }
  });
});
