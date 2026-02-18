import "reflect-metadata";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { graphql as graphqlFn, GraphQLSchema } from "graphql";
import { buildGraphqlSchema } from "../../../src/api/graphql/schema.js";
import { appConfigProvider } from "../../../src/config/app-config-provider.js";

const writeJson = (filePath: string, payload: unknown) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload), "utf-8");
};

const touch = (filePath: string, mtime: number) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "{}", "utf-8");
  fs.utimesSync(filePath, mtime, mtime);
};

describe("Memory index GraphQL e2e", () => {
  let schema: GraphQLSchema;
  let graphql: typeof graphqlFn;
  let tempRoot: string;
  let usingTemp = false;
  let memoryDir: string;
  let previousMemoryDir: string | undefined;
  const createdAgentIds: string[] = [];
  const config = appConfigProvider.config;

  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autobyteus-memory-index-"));
    previousMemoryDir = process.env.AUTOBYTEUS_MEMORY_DIR;
    process.env.AUTOBYTEUS_MEMORY_DIR = path.join(tempRoot, "memory");
    if (!config.isInitialized()) {
      config.setCustomAppDataDir(tempRoot);
      usingTemp = true;
    }
    memoryDir = config.getMemoryDir();

    schema = await buildGraphqlSchema();
    const require = createRequire(import.meta.url);
    const typeGraphqlRoot = path.dirname(require.resolve("type-graphql"));
    const graphqlPath = require.resolve("graphql", { paths: [typeGraphqlRoot] });
    const graphqlModule = await import(graphqlPath);
    graphql = graphqlModule.graphql as typeof graphqlFn;
  });

  afterEach(() => {
    for (const agentId of createdAgentIds.splice(0)) {
      const dir = path.join(memoryDir, "agents", agentId);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    if (previousMemoryDir === undefined) {
      delete process.env.AUTOBYTEUS_MEMORY_DIR;
    } else {
      process.env.AUTOBYTEUS_MEMORY_DIR = previousMemoryDir;
    }
    if (fs.existsSync(tempRoot)) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
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

  it("lists memory snapshots ordered by newest", async () => {
    const agentA = "agent-alpha";
    const agentB = "agent-beta";
    createdAgentIds.push(agentA, agentB);

    touch(path.join(memoryDir, "agents", agentA, "raw_traces.jsonl"), 1000);
    touch(path.join(memoryDir, "agents", agentB, "raw_traces.jsonl"), 2000);

    const query = `
      query ListAgentMemorySnapshots($page: Int!, $pageSize: Int!) {
        listAgentMemorySnapshots(page: $page, pageSize: $pageSize) {
          entries {
            agentId
            hasRawTraces
            lastUpdatedAt
          }
          total
          page
          pageSize
          totalPages
        }
      }
    `;

    const data = await execGraphql<{ listAgentMemorySnapshots: { entries: Array<{ agentId: string }> } }>(
      query,
      { page: 1, pageSize: 10 },
    );

    expect(data.listAgentMemorySnapshots.entries[0]?.agentId).toBe(agentB);
    expect(data.listAgentMemorySnapshots.entries[1]?.agentId).toBe(agentA);
  });

  it("filters by search", async () => {
    const agentA = "search-alpha";
    const agentB = "search-beta";
    createdAgentIds.push(agentA, agentB);

    touch(path.join(memoryDir, "agents", agentA, "raw_traces.jsonl"), 1000);
    touch(path.join(memoryDir, "agents", agentB, "raw_traces.jsonl"), 2000);

    const query = `
      query ListAgentMemorySnapshots($search: String) {
        listAgentMemorySnapshots(search: $search) {
          entries { agentId }
          total
        }
      }
    `;

    const data = await execGraphql<{ listAgentMemorySnapshots: { entries: Array<{ agentId: string }>; total: number } }>(
      query,
      { search: "alpha" },
    );

    expect(data.listAgentMemorySnapshots.entries).toHaveLength(1);
    expect(data.listAgentMemorySnapshots.entries[0]?.agentId).toBe(agentA);
    expect(data.listAgentMemorySnapshots.total).toBe(1);
  });
});
