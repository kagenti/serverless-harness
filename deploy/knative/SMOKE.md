# M4 Smoke Test Results

**Date:** 2026-06-18
**Cluster:** Kind (`sh-knative`), Kubernetes v1.34.0
**Knative Serving:** v1.14.0 + Kourier v1.14.0
**Image:** `dev.local/serverless-harness:local` (667MB)
**Gateway:** LiteLLM at `https://ete-litellm.bx.cloud9.ibm.com`

## Results: 6/6 PASS

```
--- Claim 1: Health endpoint responds ---
  PASS

--- Claim 2: POST /turn creates a new session ---
  PASS
  sessionId=019ed8eb-4757-71a3-bc0a-468150f6120b

--- Claim 3: Pod scales to zero after idle ---
  Waiting for scale-to-zero (up to 90s)...
  Scaled to zero after ~90s
  PASS

--- Claim 4: Cold-start resume recalls session state from Redis ---
  PASS

--- Claim 5: Pod scaled up from zero for claim 4 ---
  PASS

--- Claim 6: 404 on unknown session ---
  PASS

=== Results: 6 passed, 0 failed ===
```

## What Was Proven

1. Knative Serving scales the harness pod to zero after idle (stable-window 20s + grace 10s)
2. Cold-start from zero: Knative spins up a fresh pod on inbound request
3. Redis-backed session storage survives pod termination — session state recalled across cold starts
4. `containerConcurrency: 1` ensures single-tenant pod execution
5. Gateway bridge pattern (ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL) works inside the container

## Autoscaler Tuning (dev/testing)

```yaml
stable-window: "20s"        # default 60s
scale-to-zero-grace-period: "10s"  # default 30s
```

For production, use defaults or tune based on cold-start latency tolerance.

## Findings During Setup

1. **Kourier repo moved:** `knative/net-kourier` → `knative-extensions/net-kourier` (kubectl doesn't follow 301 redirects)
2. **Image tag resolution:** Local Kind images need `dev.local/` prefix + `config-deployment` skip-tag-resolving
3. **tsx resolution:** `node --import tsx` requires tsx in the CWD's node_modules — fixed by setting `WORKDIR /app/packages/knative-server`
4. **config-domain:** Must explicitly set `example.com` domain for Kourier routing to work with Host headers
