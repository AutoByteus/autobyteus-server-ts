import { describe, expect, it } from "vitest";
import { NodeType } from "../../../src/agent-team-definition/domain/enums.js";
import { AgentTeamDefinition, TeamMember } from "../../../src/agent-team-definition/domain/models.js";
import { MemberPlacementResolver } from "../../../src/distributed/member-placement/member-placement-resolver.js";

describe("Distributed run placement integration", () => {
  it("resolves required/preferred/default placements into a frozen map", () => {
    const teamDefinition = new AgentTeamDefinition({
      id: "def-1",
      name: "dist-team",
      description: "Distributed team",
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

    const placement = new MemberPlacementResolver().resolvePlacement({
      teamDefinition,
      nodeSnapshots: [
        { nodeId: "node-a", isHealthy: true },
        { nodeId: "node-b", isHealthy: true },
        { nodeId: "node-c", isHealthy: true },
      ],
      defaultNodeId: "node-c",
    });

    expect(placement.leader?.nodeId).toBe("node-a");
    expect(placement.leader?.source).toBe("required");
    expect(placement.helper?.nodeId).toBe("node-b");
    expect(placement.helper?.source).toBe("preferred");
    expect(placement.observer?.nodeId).toBe("node-c");
    expect(placement.observer?.source).toBe("default");
  });
});
