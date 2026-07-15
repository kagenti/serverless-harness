import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, parseAllDocuments } from "yaml";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEPLOY = resolve(REPO_ROOT, "deploy/knative");
const docs = () => parseAllDocuments(readFileSync(resolve(DEPLOY, "relay-deployment.yaml"), "utf8")).map((d) => d.toJS());

describe("relay-deployment.yaml", () => {
  it("is a single-replica Deployment plus a Service", () => {
    const all = docs();
    const dep = all.find((o) => o.kind === "Deployment");
    const svc = all.find((o) => o.kind === "Service");
    expect(dep?.spec.replicas).toBe(1);
    expect(dep?.metadata.name).toBe("sandbox-relay");
    expect(dep?.spec.template.metadata.labels.app).toBe("sandbox-relay");
    expect(svc?.spec.selector.app).toBe("sandbox-relay");
  });

  it("runs the relay entrypoint from its package dir so tsx + deps resolve (issue #102 follow-up)", () => {
    const dep = docs().find((o) => o.kind === "Deployment");
    const c = dep.spec.template.spec.containers[0];
    expect(c.image).toContain("serverless-harness");
    // `node --import tsx` resolves the tsx loader relative to the CWD, and the published
    // image links tsx only into packages/sandbox-relay/node_modules (no /app/node_modules
    // hoist). A CWD of /app crashes ERR_MODULE_NOT_FOUND 'tsx'; run from the package dir.
    expect(c.workingDir).toBe("/app/packages/sandbox-relay");
    const cmd = c.command.join(" ");
    expect(cmd).toContain("--import tsx");
    expect(cmd).toContain("src/main.ts");
  });

  it("is referenced by both kustomizations", () => {
    const base = parse(readFileSync(resolve(DEPLOY, "kustomization.yaml"), "utf8"));
    const ocp = parse(readFileSync(resolve(DEPLOY, "overlays/ocp/kustomization.yaml"), "utf8"));
    expect(base.resources).toContain("relay-deployment.yaml");
    expect(ocp.resources).toContain("../../relay-deployment.yaml");
  });
});
