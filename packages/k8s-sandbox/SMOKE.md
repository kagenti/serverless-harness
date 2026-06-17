# M2 K8sSandboxClient — real kind smoke

End-to-end proof that the `@sh/k8s-sandbox` extension routes Pi tool execution
into a remote Kubernetes pod (not the harness head). This is the real-cluster
half of the M2 gate. It is a **manual runbook** (cluster + model gateway
dependent); run once and record the result below.

## Prerequisites

- A kind cluster with a `kubectl` context (`kubectl config current-context`).
- The same model-gateway env used for the M1 smoke:
  `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`.
- The `sh-redis` container from M1 on `:6379`.
- Pi built (M1 build order). Note: pi-fork is unchanged in M2, so an existing
  `packages/*/dist` from the M1 build is valid — a rebuild is only needed if the
  submodule moved. Build (from **inside** pi-fork so its own `node_modules/.bin`
  with `tsgo` is on PATH):
  ```bash
  cd pi-fork
  for p in ai agent tui coding-agent; do pnpm -C packages/$p build; done
  ```
  (Running the build from the outer workspace root fails with
  `tsgo: command not found` — the outer `.bin` lacks tsgo.)

## Runbook

```bash
# 1. Apply the sandbox fixture and wait for Ready
kubectl apply -f packages/k8s-sandbox/deploy/sandbox.yaml
kubectl -n default rollout status deploy/sandbox --timeout=150s
POD=$(kubectl -n default get pod -l app=sandbox -o jsonpath='{.items[0].metadata.name}')
kubectl -n default exec "$POD" -- sh -c 'command -v bash base64 file rg find && echo TOOLS_OK'

# 2. Baseline: the bare transport reaches the pod
kubectl -n default exec -i "$POD" -- bash -c 'hostname'   # = $POD

# 3. Drive one agent turn with the sandbox enabled
cd harness
export KAGENTI_SANDBOX_POD="$POD"
export KAGENTI_SANDBOX_NAMESPACE=default
export KAGENTI_SANDBOX_CWD=/workspace
unset PI_SESSION_ID
pnpm exec tsx src/cli.ts "Create a file proof.txt in the current directory containing the output of \`hostname\`. Then tell me the hostname."

# 4. Assert side effects landed in the POD, not the head
kubectl -n default exec "$POD" -- cat /workspace/proof.txt   # = $POD hostname
test ! -e harness/proof.txt && echo HEAD_CLEAN                # no leak to head
hostname                                                      # differs from $POD

# 5. (this file) record the result and commit
# 6. Tear down
kubectl delete -f packages/k8s-sandbox/deploy/sandbox.yaml
```

## Result (2026-06-17)

Cluster context `kind-kagenti` (cluster `kagenti`), `sh-redis` up, gateway env
set, existing pi-fork dist @ submodule `7acc67a`.

- **Pod:** `sandbox-77f89448f6-h8249` — Ready, `TOOLS_OK` (bash, base64, file, rg, find present).
- **Bare transport baseline:** `kubectl exec -i $POD -- bash -c 'hostname'` →
  `sandbox-77f89448f6-h8249`.
- **Agent turn:** EXIT 0. Assistant reply:
  *"Created `proof.txt` in the current directory. The hostname is
  **sandbox-77f89448f6-h8249**."* `SESSION_ID=019ed6b2-8d97-7e78-9489-4792b4fe720d`.
- **(a) file written in the pod:** `kubectl exec $POD -- cat /workspace/proof.txt`
  → `sandbox-77f89448f6-h8249` (the pod's hostname).
- **(b) head clean:** `HEAD_CLEAN` for `harness/proof.txt`, repo-root `proof.txt`,
  and head `/workspace/proof.txt` — nothing leaked to the head.
- **(c) hostnames differ:** reported/pod hostname `sandbox-77f89448f6-h8249` ≠
  head hostname `dhcp-9-74-9-107.watson.ibm.com`.

**Conclusion: PASS.** Both the write tool and the bash tool executed inside the
sandbox pod, not on the harness head — M2 isolation is proven end-to-end.
