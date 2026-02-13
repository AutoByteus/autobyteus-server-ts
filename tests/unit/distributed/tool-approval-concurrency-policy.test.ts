import { describe, expect, it } from "vitest";
import {
  MissingInvocationVersionError,
  StaleInvocationVersionError,
  ToolApprovalConcurrencyPolicy,
} from "../../../src/distributed/policies/tool-approval-concurrency-policy.js";

describe("ToolApprovalConcurrencyPolicy", () => {
  it("accepts matching invocation version for registered pending invocation", () => {
    const policy = new ToolApprovalConcurrencyPolicy();
    policy.registerPendingInvocation("inv-1", 2);

    expect(() => policy.validateInvocationVersion("inv-1", 2)).not.toThrow();
  });

  it("rejects stale invocation versions", () => {
    const policy = new ToolApprovalConcurrencyPolicy();
    policy.registerPendingInvocation("inv-2", 3);

    expect(() => policy.validateInvocationVersion("inv-2", 2)).toThrow(
      StaleInvocationVersionError,
    );
  });

  it("rejects missing invocation state", () => {
    const policy = new ToolApprovalConcurrencyPolicy();
    expect(() => policy.validateInvocationVersion("missing", 1)).toThrow(
      MissingInvocationVersionError,
    );
  });

  it("clears invocation state after completion", () => {
    const policy = new ToolApprovalConcurrencyPolicy();
    policy.registerPendingInvocation("inv-3", 1);
    policy.completeInvocation("inv-3");

    expect(() => policy.validateInvocationVersion("inv-3", 1)).toThrow(
      MissingInvocationVersionError,
    );
  });
});
