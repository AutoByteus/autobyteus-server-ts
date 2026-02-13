import { describe, expect, it } from "vitest";
import { AgentTeamDefinitionConverter } from "../../../../../src/api/graphql/converters/agent-team-definition-converter.js";
import { AgentTeamDefinition, TeamMember } from "../../../../../src/agent-team-definition/domain/models.js";
import { NodeType } from "../../../../../src/agent-team-definition/domain/enums.js";

describe("AgentTeamDefinitionConverter", () => {
  it("maps node placement hints to GraphQL fields", () => {
    const domainDefinition = new AgentTeamDefinition({
      id: "7",
      name: "Distributed Team",
      description: "Team with explicit placement",
      coordinatorMemberName: "leader",
      nodes: [
        new TeamMember({
          memberName: "leader",
          referenceId: "agent-1",
          referenceType: NodeType.AGENT,
          homeNodeId: "embedded-local",
          requiredNodeId: "embedded-local",
          preferredNodeId: "remote-node-1",
        }),
        new TeamMember({
          memberName: "helper",
          referenceId: "agent-2",
          referenceType: NodeType.AGENT,
        }),
      ],
    });

    const graphqlDefinition = AgentTeamDefinitionConverter.toGraphql(domainDefinition);

    expect(graphqlDefinition.nodes[0]?.requiredNodeId).toBe("embedded-local");
    expect(graphqlDefinition.nodes[0]?.preferredNodeId).toBe("remote-node-1");
    expect(graphqlDefinition.nodes[0]?.homeNodeId).toBe("embedded-local");
    expect(graphqlDefinition.nodes[1]?.requiredNodeId).toBeNull();
    expect(graphqlDefinition.nodes[1]?.preferredNodeId).toBeNull();
    expect(graphqlDefinition.nodes[1]?.homeNodeId).toBeNull();
  });
});
