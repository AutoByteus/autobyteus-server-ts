import type { TeamMember } from "../../agent-team-definition/domain/models.js";

const normalizeNodeId = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export class UnknownPlacementNodeError extends Error {
  readonly memberName: string;
  readonly hintField: "requiredNodeId" | "preferredNodeId";
  readonly nodeId: string;

  constructor(
    memberName: string,
    hintField: "requiredNodeId" | "preferredNodeId",
    nodeId: string,
  ) {
    super(
      `Team member '${memberName}' references unknown ${hintField} '${nodeId}'.`
    );
    this.name = "UnknownPlacementNodeError";
    this.memberName = memberName;
    this.hintField = hintField;
    this.nodeId = nodeId;
  }
}

export class RequiredNodeUnavailableError extends Error {
  readonly memberName: string;
  readonly nodeId: string;

  constructor(memberName: string, nodeId: string) {
    super(
      `Team member '${memberName}' requires node '${nodeId}', but it is unavailable.`
    );
    this.name = "RequiredNodeUnavailableError";
    this.memberName = memberName;
    this.nodeId = nodeId;
  }
}

export class UnknownHomeNodeError extends Error {
  readonly memberName: string;
  readonly homeNodeId: string;

  constructor(memberName: string, homeNodeId: string) {
    super(`Team member '${memberName}' references unknown homeNodeId '${homeNodeId}'.`);
    this.name = "UnknownHomeNodeError";
    this.memberName = memberName;
    this.homeNodeId = homeNodeId;
  }
}

export class HomeNodeUnavailableError extends Error {
  readonly memberName: string;
  readonly homeNodeId: string;

  constructor(memberName: string, homeNodeId: string) {
    super(`Team member '${memberName}' home node '${homeNodeId}' is unavailable.`);
    this.name = "HomeNodeUnavailableError";
    this.memberName = memberName;
    this.homeNodeId = homeNodeId;
  }
}

export class OwnershipPlacementMismatchError extends Error {
  readonly memberName: string;
  readonly homeNodeId: string;
  readonly hintField: "requiredNodeId" | "preferredNodeId";
  readonly hintedNodeId: string;

  constructor(
    memberName: string,
    homeNodeId: string,
    hintField: "requiredNodeId" | "preferredNodeId",
    hintedNodeId: string,
  ) {
    super(
      `Team member '${memberName}' has homeNodeId '${homeNodeId}' but ${hintField} '${hintedNodeId}'.`,
    );
    this.name = "OwnershipPlacementMismatchError";
    this.memberName = memberName;
    this.homeNodeId = homeNodeId;
    this.hintField = hintField;
    this.hintedNodeId = hintedNodeId;
  }
}

export class PlacementConstraintPolicy {
  validateRequiredAndPreferred(
    member: TeamMember,
    knownNodeIds: Set<string>,
    availableNodeIds: Set<string>
  ): void {
    const homeNodeId = normalizeNodeId(member.homeNodeId);
    const requiredNodeId = normalizeNodeId(member.requiredNodeId);
    const preferredNodeId = normalizeNodeId(member.preferredNodeId);

    if (homeNodeId && !knownNodeIds.has(homeNodeId)) {
      throw new UnknownHomeNodeError(member.memberName, homeNodeId);
    }

    if (homeNodeId && !availableNodeIds.has(homeNodeId)) {
      throw new HomeNodeUnavailableError(member.memberName, homeNodeId);
    }

    if (homeNodeId && requiredNodeId && requiredNodeId !== homeNodeId) {
      throw new OwnershipPlacementMismatchError(
        member.memberName,
        homeNodeId,
        "requiredNodeId",
        requiredNodeId,
      );
    }

    if (homeNodeId && preferredNodeId && preferredNodeId !== homeNodeId) {
      throw new OwnershipPlacementMismatchError(
        member.memberName,
        homeNodeId,
        "preferredNodeId",
        preferredNodeId,
      );
    }

    if (requiredNodeId && !knownNodeIds.has(requiredNodeId)) {
      throw new UnknownPlacementNodeError(member.memberName, "requiredNodeId", requiredNodeId);
    }

    if (preferredNodeId && !knownNodeIds.has(preferredNodeId)) {
      throw new UnknownPlacementNodeError(member.memberName, "preferredNodeId", preferredNodeId);
    }

    if (requiredNodeId && !availableNodeIds.has(requiredNodeId)) {
      throw new RequiredNodeUnavailableError(member.memberName, requiredNodeId);
    }
  }
}
