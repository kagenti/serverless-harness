# Act 0: Install
```
git clone https://github.com/kagenti/serverless-harness.git && cd serverless-harness
./deploy/knative/setup-kind.sh
```
setup inferencing

```
export ANTHROPIC_AUTH_TOKEN=<redacted>
export ANTHROPIC_BASE_URL=https://ete-litellm.bx.cloud9.ibm.com
```

Open 3 terminals

# T1 — Watch pods

```
watch -n5 'kubectl get pods'
```

# T2 — Port-forward

```
kubectl port-forward -n kourier-system svc/kourier 8080:80
```

# T3 — Demo commands

# Act 1: Cold start (0→1), new session

# Confirm zero pods (T1 should show nothing)
```
kubectl get pods -l serving.knative.dev/service=serverless-harness
```

# Send first message — watch T1 light up with a new pod
```
curl -s -H "Host: serverless-harness.default.example.com" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Remember the secret word: pineapple. Reply only with OK."}' \
  http://localhost:8080/turn | jq .
```

Expected response:
```
{
  "sessionId": "019ed8e8-...",
  "response": "OK"
}
```

Save the session ID:
```
export SID="<paste sessionId from above>"
```

---
# Act 2: Scale back to zero

# Wait ~30-90s, watch T1 — pod terminates
# You can watch with:
```
watch -n5 'kubectl get pods -l serving.knative.dev/service=serverless-harness'
```

Once T1 shows the pod gone (or Terminating → gone), you're at zero.

---

# Act 3: Resume session across cold start (0→1 again, remembers state)

# Pod is at zero — send a request on the SAME session
```
curl -s -H "Host: serverless-harness.default.example.com" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"$SID\",\"prompt\":\"What was the secret word I told you?\"}" \
  http://localhost:8080/turn | jq .
```

Expected: pod spins up from zero (visible in T1), response contains "pineapple".

---
# Act 4: Sandbox command execution


# Ask the agent to run a command — it will kubectl exec into sandbox-0
```
curl -s -H "Host: serverless-harness.default.example.com" \
  -H "Content-Type: application/json" \
  -d "{\"sessionId\":\"$SID\",\"prompt\":\"Run this shell command and show me the output: uname -a && cat /etc/os-release | head -5\"}" \
  http://localhost:8080/turn | jq .
```  
