import { describe, expect, it } from "vitest";
import { NodeType } from "../../../src/agent-team-definition/domain/enums.js";
import { AgentTeamDefinition, TeamMember } from "../../../src/agent-team-definition/domain/models.js";
import { MemberPlacementResolver } from "../../../src/distributed/member-placement/member-placement-resolver.js";
import {
  RequiredNodeUnavailableError,
  UnknownPlacementNodeError,
} from "../../../src/distributed/policies/placement-constraint-policy.js";

describe("MemberPlacementResolver", () => {
  const resolver = new MemberPlacementResolver();

  const buildTeamDefinition = () =>
    new AgentTeamDefinition({
      id: "def-1",
      name: "dist-team",
      description: "Distributed test",
      coordinatorMemberName: "leader",
      nodes: [
        new TeamMember({
          memberName: "leader",
          referenceId: "agent-1",
          referenceType: NodeType.AGENT,
          requiredNodeId: "node-a",
        }),
        new TeamMember({
          memberName: "helper",
          referenceId: "agent-2",
          referenceType: NodeType.AGENT,
          preferredNodeId: "node-b",
        }),
        new TeamMember({
          memberName: "observer",
          referenceId: "agent-3",
          referenceType: NodeType.AGENT,
        }),
      ],
    });

  it("resolves required, preferred, and default placements", () => {
    const placement = resolver.resolvePlacement({
      teamDefinition: buildTeamDefinition(),
      nodeSnapshots: [
        { nodeId: "node-a", isHealthy: true },
        { nodeId: "node-b", isHealthy: true },
        { nodeId: "node-c", isHealthy: true },
      ],
      defaultNodeId: "node-c",
    });

    expect(placement.leader).toEqual({
      memberName: "leader",
      nodeId: "node-a",
      source: "required",
    });
    expect(placement.helper).toEqual({
      memberName: "helper",
      nodeId: "node-b",
      source: "preferred",
    });
    expect(placement.observer).toEqual({
      memberName: "observer",
      nodeId: "node-c",
      source: "default",
    });
  });

  it("falls back to default policy when preferred node is unavailable", () => {
    const teamDefinition = buildTeamDefinition();
    teamDefinition.nodes[1]!.preferredNodeId = "node-b";

    const placement = resolver.resolvePlacement({
      teamDefinition,
      nodeSnapshots: [
        { nodeId: "node-a", isHealthy: true },
        { nodeId: "node-b", isHealthy: false },
        { nodeId: "node-c", isHealthy: true },
      ],
      defaultNodeId: "node-c",
    });

    expect(placement.helper?.source).toBe("default");
    expect(placement.helper?.nodeId).toBe("node-c");
  });

  it("prefers homeNodeId before default placement", () => {
    const teamDefinition = buildTeamDefinition();
    teamDefinition.nodes[2]!.homeNodeId = "node-b";

    const placement = resolver.resolvePlacement({
      teamDefinition,
      nodeSnapshots: [
        { nodeId: "node-a", isHealthy: true },
        { nodeId: "node-b", isHealthy: true },
        { nodeId: "node-c", isHealthy: true },
      ],
      defaultNodeId: "node-c",
    });

    expect(placement.observer?.source).toBe("home");
    expect(placement.observer?.nodeId).toBe("node-b");
  });

  it("maps embedded-local homeNodeId to default node id", () => {
    const teamDefinition = buildTeamDefinition();
    teamDefinition.nodes[0]!.requiredNodeId = null;
    teamDefinition.nodes[1]!.preferredNodeId = null;
    teamDefinition.nodes[2]!.homeNodeId = "embedded-local";

    const placement = resolver.resolvePlacement({
      teamDefinition,
      nodeSnapshots: [
        { nodeId: "node-runtime", isHealthy: true },
        { nodeId: "node-remote", isHealthy: true },
      ],
      defaultNodeId: "node-runtime",
    });

    expect(placement.observer?.source).toBe("home");
    expect(placement.observer?.nodeId).toBe("node-runtime");
  });

  it("maps embedded-local requiredNodeId to default node id", () => {
    const teamDefinition = buildTeamDefinition();
    teamDefinition.nodes[1]!.preferredNodeId = null;
    teamDefinition.nodes[0]!.requiredNodeId = "embedded-local";

    const placement = resolver.resolvePlacement({
      teamDefinition,
      nodeSnapshots: [
        { nodeId: "node-runtime", isHealthy: true },
        { nodeId: "node-remote", isHealthy: true },
      ],
      defaultNodeId: "node-runtime",
    });

    expect(placement.leader?.source).toBe("required");
    expect(placement.leader?.nodeId).toBe("node-runtime");
  });

  it("throws for unknown hint node ids", () => {
    const teamDefinition = buildTeamDefinition();
    teamDefinition.nodes[1]!.preferredNodeId = "node-missing";

    expect(() =>
      resolver.resolvePlacement({
        teamDefinition,
        nodeSnapshots: [{ nodeId: "node-a", isHealthy: true }],
      })
    ).toThrow(UnknownPlacementNodeError);
  });

  it("throws when required node is known but unavailable", () => {
    const teamDefinition = buildTeamDefinition();

    expect(() =>
      resolver.resolvePlacement({
        teamDefinition,
        nodeSnapshots: [
          { nodeId: "node-a", isHealthy: false },
          { nodeId: "node-b", isHealthy: true },
        ],
      })
    ).toThrow(RequiredNodeUnavailableError);
  });
});
