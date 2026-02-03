import "reflect-metadata";
import path from "node:path";
import { createRequire } from "node:module";
import { beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import type { graphql as graphqlFn, GraphQLSchema } from "graphql";
import { buildGraphqlSchema } from "../../../src/api/graphql/schema.js";
import { ArtifactService } from "../../../src/agent-artifacts/services/artifact-service.js";
import { SqlAgentArtifactRepository } from "../../../src/agent-artifacts/repositories/sql/agent-artifact-repository.js";

const repo = new SqlAgentArtifactRepository();

describe("Agent artifacts GraphQL e2e", () => {
  let schema: GraphQLSchema;
  let graphql: typeof graphqlFn;

  beforeAll(async () => {
    schema = await buildGraphqlSchema();
    const require = createRequire(import.meta.url);
    const typeGraphqlRoot = path.dirname(require.resolve("type-graphql"));
    const graphqlPath = require.resolve("graphql", { paths: [typeGraphqlRoot] });
    const graphqlModule = await import(graphqlPath);
    graphql = graphqlModule.graphql as typeof graphqlFn;
  });

  beforeEach(async () => {
    await repo.deleteMany({});
    ArtifactService.resetInstance();
  });

  afterEach(async () => {
    await repo.deleteMany({});
    ArtifactService.resetInstance();
  });

  const execGraphql = async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
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

  it("returns empty list for unknown agent", async () => {
    const query = `
      query AgentArtifacts($agentId: String!) {
        agentArtifacts(agentId: $agentId) {
          id
          agentId
          path
          type
          createdAt
          updatedAt
        }
      }
    `;

    const data = await execGraphql<{ agentArtifacts: unknown[] }>(query, {
      agentId: "non-existent-agent-e2e",
    });

    expect(data.agentArtifacts).toEqual([]);
  });

  it("returns created artifacts", async () => {
    const service = ArtifactService.getInstance();
    const agentId = "e2e-test-agent-graphql";

    await service.createArtifact({ agentId, path: "/e2e/file1.py", type: "file" });
    await service.createArtifact({ agentId, path: "/e2e/file2.py", type: "file" });

    const query = `
      query AgentArtifacts($agentId: String!) {
        agentArtifacts(agentId: $agentId) {
          id
          agentId
          path
          type
          createdAt
          updatedAt
        }
      }
    `;

    const data = await execGraphql<{ agentArtifacts: Array<{ path: string; agentId: string; type: string; id: string; createdAt: string; updatedAt: string }> }>(
      query,
      { agentId },
    );

    expect(data.agentArtifacts.length).toBeGreaterThanOrEqual(2);
    const paths = data.agentArtifacts.map((artifact) => artifact.path);
    expect(paths).toContain("/e2e/file1.py");
    expect(paths).toContain("/e2e/file2.py");

    for (const artifact of data.agentArtifacts) {
      expect(artifact.agentId).toBe(agentId);
      expect(artifact.type).toBe("file");
      expect(artifact.id).toBeTruthy();
      expect(artifact.createdAt).toBeTruthy();
      expect(artifact.updatedAt).toBeTruthy();
    }
  });
});
