import { describe, it, expect } from "vitest";
import { predictionRecord } from "../src/workload.js";

describe("predictions.jsonl record", () => {
  it("is the official SWE-bench predictions shape", () => {
    const r = predictionRecord("django__django-123", "claude-haiku-4-5", "diff --git a b\n");
    expect(r).toEqual({ instance_id: "django__django-123", model_name_or_path: "claude-haiku-4-5", model_patch: "diff --git a b\n" });
  });
});
