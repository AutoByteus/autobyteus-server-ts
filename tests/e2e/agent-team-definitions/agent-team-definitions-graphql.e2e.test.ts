import "reflect-metadata";
import path from "node:path";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import type { graphql as graphqlFn, GraphQLSchema } from "graphql";
import { buildSchema } from "type-graphql";
import { AgentTeamDefinitionResolver } from "../../../src/api/graphql/types/agent-team-definition.js";

describe("Agent team definitions GraphQL e2e", () => {
  let schema: GraphQLSchema;
  let graphql: typeof graphqlFn;

  beforeAll(async () => {
    schema = await buildSchema({
      resolvers: [AgentTeamDefinitionResolver],
      validate: false,
    });
    const require = createRequire(import.meta.url);
    const typeGraphqlRoot = path.dirname(require.resolve("type-graphql"));
    const graphqlPath = require.resolve("graphql", { paths: [typeGraphqlRoot] });
    const graphqlModule = await import(graphqlPath);
    graphql = graphqlModule.graphql as typeof graphqlFn;
  });

  const execGraphql = async <T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> => {
    const result = await graphql({
      schema,
      source: query,
      variableValues: variables,
    });
    if (result.errors?.length) {
      throw result.errors[0];
    }
    return result.data as T;
  };

  it("creates, updates, and deletes agent team definitions", async () => {
    const unique = `team_def_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const teamName = `team_${unique}`;

    const createMutation = `
      mutation CreateTeam($input: CreateAgentTeamDefinitionInput!) {
        createAgentTeamDefinition(input: $input) {
          id
          name
          description
          role
          avatarUrl
          coordinatorMemberName
          nodes {
            memberName
            referenceId
            referenceType
            requiredNodeId
            preferredNodeId
          }
        }
      }
    `;

    const created = await execGraphql<{
      createAgentTeamDefinition: {
        id: string;
        name: string;
        description: string;
        role: string | null;
        avatarUrl: string | null;
        coordinatorMemberName: string;
        nodes: Array<{
          memberName: string;
          referenceId: string;
          referenceType: string;
          requiredNodeId: string | null;
          preferredNodeId: string | null;
        }>;
      };
    }>(createMutation, {
      input: {
        name: teamName,
        description: "Team definition for e2e",
        role: "Coordinator",
        avatarUrl: "http://localhost:8000/rest/files/images/e2e-team-avatar.png",
        coordinatorMemberName: "leader",
        nodes: [
          {
            memberName: "leader",
            referenceId: "agent-1",
            referenceType: "AGENT",
            requiredNodeId: "embedded-local",
            preferredNodeId: "remote-node-1",
          },
          {
            memberName: "helper",
            referenceId: "agent-2",
            referenceType: "AGENT",
            requiredNodeId: null,
            preferredNodeId: "remote-node-2",
          },
        ],
      },
    });

    expect(created.createAgentTeamDefinition.name).toBe(teamName);
    expect(created.createAgentTeamDefinition.avatarUrl).toBe(
      "http://localhost:8000/rest/files/images/e2e-team-avatar.png",
    );
    expect(created.createAgentTeamDefinition.nodes.length).toBe(2);
    expect(created.createAgentTeamDefinition.nodes[0]?.requiredNodeId).toBe("embedded-local");
    expect(created.createAgentTeamDefinition.nodes[0]?.preferredNodeId).toBe("remote-node-1");
    expect(created.createAgentTeamDefinition.nodes[1]?.requiredNodeId).toBeNull();
    expect(created.createAgentTeamDefinition.nodes[1]?.preferredNodeId).toBe("remote-node-2");

    const updateMutation = `
      mutation UpdateTeam($input: UpdateAgentTeamDefinitionInput!) {
        updateAgentTeamDefinition(input: $input) {
          id
          description
          role
          avatarUrl
          nodes {
            memberName
            requiredNodeId
            preferredNodeId
          }
        }
      }
    `;
    const updated = await execGraphql<{
      updateAgentTeamDefinition: {
        id: string;
        description: string;
        role: string | null;
        avatarUrl: string | null;
        nodes: Array<{
          memberName: string;
          requiredNodeId: string | null;
          preferredNodeId: string | null;
        }>;
      };
    }>(updateMutation, {
      input: {
        id: created.createAgentTeamDefinition.id,
        description: "Updated team description",
        role: "UpdatedRole",
        avatarUrl: "",
        nodes: [
          {
            memberName: "leader",
            referenceId: "agent-1",
            referenceType: "AGENT",
            requiredNodeId: "remote-node-1",
            preferredNodeId: "remote-node-2",
          },
          {
            memberName: "helper",
            referenceId: "agent-2",
            referenceType: "AGENT",
            requiredNodeId: null,
            preferredNodeId: null,
          },
        ],
      },
    });
    expect(updated.updateAgentTeamDefinition.description).toBe("Updated team description");
    expect(updated.updateAgentTeamDefinition.role).toBe("UpdatedRole");
    expect(updated.updateAgentTeamDefinition.avatarUrl).toBeNull();
    expect(updated.updateAgentTeamDefinition.nodes[0]?.requiredNodeId).toBe("remote-node-1");
    expect(updated.updateAgentTeamDefinition.nodes[0]?.preferredNodeId).toBe("remote-node-2");
    expect(updated.updateAgentTeamDefinition.nodes[1]?.requiredNodeId).toBeNull();
    expect(updated.updateAgentTeamDefinition.nodes[1]?.preferredNodeId).toBeNull();

    const query = `
      query GetTeam($id: String!) {
        agentTeamDefinition(id: $id) {
          id
          name
        }
      }
    `;
    const fetched = await execGraphql<{ agentTeamDefinition: { id: string; name: string } | null }>(
      query,
      { id: created.createAgentTeamDefinition.id },
    );
    expect(fetched.agentTeamDefinition?.id).toBe(created.createAgentTeamDefinition.id);

    const deleteMutation = `
      mutation DeleteTeam($id: String!) {
        deleteAgentTeamDefinition(id: $id) {
          success
          message
        }
      }
    `;
    const deleted = await execGraphql<{ deleteAgentTeamDefinition: { success: boolean } }>(
      deleteMutation,
      { id: created.createAgentTeamDefinition.id },
    );
    expect(deleted.deleteAgentTeamDefinition.success).toBe(true);

    const afterDelete = await execGraphql<{
      agentTeamDefinition: { id: string; name: string } | null;
    }>(query, { id: created.createAgentTeamDefinition.id });
    expect(afterDelete.agentTeamDefinition).toBeNull();
  });
});
