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

  it("runs the relay entrypoint on the shared image", () => {
    const dep = docs().find((o) => o.kind === "Deployment");
    const c = dep.spec.template.spec.containers[0];
    expect(c.image).toContain("serverless-harness");
    expect(c.command.join(" ")).toContain("packages/sandbox-relay/src/main.ts");
  });

  it("is referenced by both kustomizations", () => {
    const base = parse(readFileSync(resolve(DEPLOY, "kustomization.yaml"), "utf8"));
    const ocp = parse(readFileSync(resolve(DEPLOY, "overlays/ocp/kustomization.yaml"), "utf8"));
    expect(base.resources).toContain("relay-deployment.yaml");
    expect(ocp.resources).toContain("../../relay-deployment.yaml");
  });
});
