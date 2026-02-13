import { describe, expect, it } from "vitest";
import { NodeType } from "../../../src/agent-team-definition/domain/enums.js";
import { TeamMember } from "../../../src/agent-team-definition/domain/models.js";
import {
  HomeNodeUnavailableError,
  OwnershipPlacementMismatchError,
  PlacementConstraintPolicy,
  RequiredNodeUnavailableError,
  UnknownHomeNodeError,
  UnknownPlacementNodeError,
} from "../../../src/distributed/policies/placement-constraint-policy.js";

describe("PlacementConstraintPolicy", () => {
  const policy = new PlacementConstraintPolicy();

  it("rejects unknown requiredNodeId", () => {
    const member = new TeamMember({
      memberName: "writer",
      referenceId: "agent-1",
      referenceType: NodeType.AGENT,
      requiredNodeId: "missing-node",
    });

    expect(() =>
      policy.validateRequiredAndPreferred(member, new Set(["node-1"]), new Set(["node-1"]))
    ).toThrow(UnknownPlacementNodeError);
  });

  it("rejects unknown preferredNodeId", () => {
    const member = new TeamMember({
      memberName: "reviewer",
      referenceId: "agent-2",
      referenceType: NodeType.AGENT,
      preferredNodeId: "missing-node",
    });

    expect(() =>
      policy.validateRequiredAndPreferred(member, new Set(["node-1"]), new Set(["node-1"]))
    ).toThrow(UnknownPlacementNodeError);
  });

  it("rejects unavailable requiredNodeId", () => {
    const member = new TeamMember({
      memberName: "planner",
      referenceId: "agent-3",
      referenceType: NodeType.AGENT,
      requiredNodeId: "node-2",
    });

    expect(() =>
      policy.validateRequiredAndPreferred(
        member,
        new Set(["node-1", "node-2"]),
        new Set(["node-1"])
      )
    ).toThrow(RequiredNodeUnavailableError);
  });

  it("allows missing preferredNodeId availability", () => {
    const member = new TeamMember({
      memberName: "executor",
      referenceId: "agent-4",
      referenceType: NodeType.AGENT,
      preferredNodeId: "node-2",
    });

    expect(() =>
      policy.validateRequiredAndPreferred(
        member,
        new Set(["node-1", "node-2"]),
        new Set(["node-1"])
      )
    ).not.toThrow();
  });

  it("rejects unknown homeNodeId", () => {
    const member = new TeamMember({
      memberName: "owner",
      referenceId: "agent-5",
      referenceType: NodeType.AGENT,
      homeNodeId: "missing-node",
    });

    expect(() =>
      policy.validateRequiredAndPreferred(member, new Set(["node-1"]), new Set(["node-1"]))
    ).toThrow(UnknownHomeNodeError);
  });

  it("rejects unavailable homeNodeId", () => {
    const member = new TeamMember({
      memberName: "owner",
      referenceId: "agent-6",
      referenceType: NodeType.AGENT,
      homeNodeId: "node-2",
    });

    expect(() =>
      policy.validateRequiredAndPreferred(member, new Set(["node-1", "node-2"]), new Set(["node-1"]))
    ).toThrow(HomeNodeUnavailableError);
  });

  it("rejects contradictory requiredNodeId against homeNodeId", () => {
    const member = new TeamMember({
      memberName: "owner",
      referenceId: "agent-7",
      referenceType: NodeType.AGENT,
      homeNodeId: "node-1",
      requiredNodeId: "node-2",
    });

    expect(() =>
      policy.validateRequiredAndPreferred(
        member,
        new Set(["node-1", "node-2"]),
        new Set(["node-1", "node-2"])
      )
    ).toThrow(OwnershipPlacementMismatchError);
  });
});
