#!/usr/bin/env python3
"""Sum one leaf's token usage + cost from its pi session stream.

The harness persists a `session:<sessionId>` Redis STREAM per leaf; each assistant event
carries a `"usage":{input,output,cacheRead,cacheWrite,totalTokens,cost:{...,total}}` object
(pi computes `cost.total` at the model's own rates). This reads `redis-cli XRANGE` output on
stdin and emits ONE JSON line summing that leaf's usage — the authoritative per-leaf cost
source for the sharing experiments (the in-harness `usage` field is unreliable on the pinned
pi build, so cost is derived from the session stream instead).

Usage: redis-cli XRANGE session:<sid> - + | SID=<sid> python3 session-usage.py
Emits: {"sid","turns","input","output","cacheRead","cacheWrite","total","costUsd"}
"""
import sys
import os
import json

txt = sys.stdin.read()
tok = {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}
cost = 0.0
turns = 0
i = 0
needle = '"usage":'
while True:
    j = txt.find(needle, i)
    if j < 0:
        break
    # brace-match the object after "usage":
    b = txt.find("{", j)
    depth = 0
    k = b
    while k < len(txt):
        if txt[k] == "{":
            depth += 1
        elif txt[k] == "}":
            depth -= 1
            if depth == 0:
                break
        k += 1
    obj = txt[b:k + 1]
    i = k + 1
    try:
        u = json.loads(obj)
    except Exception:
        continue
    # a message-usage object has integer token fields + a nested cost object;
    # this excludes the nested `cost` object (its fields are floats).
    if all(f in u for f in tok) and isinstance(u.get("input"), int):
        turns += 1
        for f in tok:
            tok[f] += u[f]
        c = u.get("cost") or {}
        if isinstance(c.get("total"), (int, float)):
            cost += c["total"]

print(json.dumps({
    "sid": os.environ.get("SID", ""),
    "turns": turns,
    **tok,
    "total": sum(tok.values()),
    "costUsd": round(cost, 4),
}))
