const normalizeInvocationId = (value: string): string => {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("invocationId must be a non-empty string.");
  }
  return normalized;
};

const normalizeVersion = (value: number): number => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("invocationVersion must be a positive integer.");
  }
  return value;
};

export class MissingInvocationVersionError extends Error {
  constructor(invocationId: string) {
    super(`No pending invocation state found for '${invocationId}'.`);
    this.name = "MissingInvocationVersionError";
  }
}

export class StaleInvocationVersionError extends Error {
  constructor(invocationId: string, expectedVersion: number, actualVersion: number) {
    super(
      `Stale invocation version for '${invocationId}': expected ${expectedVersion}, got ${actualVersion}.`,
    );
    this.name = "StaleInvocationVersionError";
  }
}

export class ToolApprovalConcurrencyPolicy {
  private readonly latestVersionByInvocationId = new Map<string, number>();

  registerPendingInvocation(invocationId: string, invocationVersion: number): void {
    const normalizedInvocationId = normalizeInvocationId(invocationId);
    const normalizedVersion = normalizeVersion(invocationVersion);
    const existing = this.latestVersionByInvocationId.get(normalizedInvocationId);
    if (existing === undefined || normalizedVersion > existing) {
      this.latestVersionByInvocationId.set(normalizedInvocationId, normalizedVersion);
    }
  }

  validateInvocationVersion(invocationId: string, invocationVersion: number): void {
    const normalizedInvocationId = normalizeInvocationId(invocationId);
    const normalizedVersion = normalizeVersion(invocationVersion);
    const expectedVersion = this.latestVersionByInvocationId.get(normalizedInvocationId);
    if (expectedVersion === undefined) {
      throw new MissingInvocationVersionError(normalizedInvocationId);
    }
    if (normalizedVersion !== expectedVersion) {
      throw new StaleInvocationVersionError(
        normalizedInvocationId,
        expectedVersion,
        normalizedVersion,
      );
    }
  }

  completeInvocation(invocationId: string): void {
    this.latestVersionByInvocationId.delete(normalizeInvocationId(invocationId));
  }
}
