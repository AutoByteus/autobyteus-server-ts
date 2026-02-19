import "reflect-metadata";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { graphql as graphqlFn, GraphQLSchema } from "graphql";
import { buildGraphqlSchema } from "../../../src/api/graphql/schema.js";

type RunHistoryIndexRow = {
  agentId: string;
  agentDefinitionId: string;
  agentName: string;
  workspaceRootPath: string;
  summary: string;
  lastActivityAt: string;
  lastKnownStatus: "ACTIVE" | "IDLE" | "ERROR";
};

type RunHistoryIndexFile = {
  version: number;
  rows: RunHistoryIndexRow[];
};

const readIndex = (indexFilePath: string): RunHistoryIndexFile => {
  try {
    const raw = fs.readFileSync(indexFilePath, "utf-8");
    const parsed = JSON.parse(raw) as RunHistoryIndexFile;
    if (!Array.isArray(parsed.rows)) {
      return { version: 1, rows: [] };
    }
    return {
      version: 1,
      rows: parsed.rows,
    };
  } catch {
    return { version: 1, rows: [] };
  }
};

const writeIndex = (indexFilePath: string, index: RunHistoryIndexFile): void => {
  fs.mkdirSync(path.dirname(indexFilePath), { recursive: true });
  fs.writeFileSync(indexFilePath, JSON.stringify(index, null, 2), "utf-8");
};

describe("Run history GraphQL e2e", () => {
  let schema: GraphQLSchema;
  let graphql: typeof graphqlFn;
  let tempRoot: string;
  let memoryDir: string;
  let indexFilePath: string;
  let originalMemoryDirEnv: string | undefined;
  const createdRunIds = new Set<string>();

  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autobyteus-run-history-e2e-"));
    originalMemoryDirEnv = process.env.AUTOBYTEUS_MEMORY_DIR;
    memoryDir = path.join(tempRoot, "memory");
    process.env.AUTOBYTEUS_MEMORY_DIR = memoryDir;
    fs.mkdirSync(memoryDir, { recursive: true });
    indexFilePath = path.join(memoryDir, "run_history_index.json");

    schema = await buildGraphqlSchema();
    const require = createRequire(import.meta.url);
    const typeGraphqlRoot = path.dirname(require.resolve("type-graphql"));
    const graphqlPath = require.resolve("graphql", { paths: [typeGraphqlRoot] });
    const graphqlModule = await import(graphqlPath);
    graphql = graphqlModule.graphql as typeof graphqlFn;
  });

  afterEach(() => {
    const index = readIndex(indexFilePath);
    index.rows = index.rows.filter((row) => !createdRunIds.has(row.agentId));
    writeIndex(indexFilePath, index);

    for (const agentId of createdRunIds) {
      fs.rmSync(path.join(memoryDir, "agents", agentId), { recursive: true, force: true });
    }
    createdRunIds.clear();
  });

  afterAll(() => {
    if (typeof originalMemoryDirEnv === "string") {
      process.env.AUTOBYTEUS_MEMORY_DIR = originalMemoryDirEnv;
    } else {
      delete process.env.AUTOBYTEUS_MEMORY_DIR;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
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

  it("deletes inactive run history and removes the memory directory", async () => {
    const agentId = `run_history_delete_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    createdRunIds.add(agentId);

    const runDir = path.join(memoryDir, "agents", agentId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, "raw_traces.jsonl"), "", "utf-8");
    fs.writeFileSync(
      path.join(runDir, "run_manifest.json"),
      JSON.stringify({
        agentDefinitionId: "agent-def-e2e",
        workspaceRootPath: "/tmp/e2e",
        llmModelIdentifier: "model-e2e",
        llmConfig: null,
        autoExecuteTools: false,
        skillAccessMode: null,
      }),
      "utf-8",
    );

    const index = readIndex(indexFilePath);
    index.rows = index.rows
      .filter((row) => row.agentId !== agentId)
      .concat({
        agentId,
        agentDefinitionId: "agent-def-e2e",
        agentName: "E2E Agent",
        workspaceRootPath: "/tmp/e2e",
        summary: "cleanup me",
        lastActivityAt: new Date().toISOString(),
        lastKnownStatus: "IDLE",
      });
    writeIndex(indexFilePath, index);

    const deleteMutation = `
      mutation DeleteRunHistory($agentId: String!) {
        deleteRunHistory(agentId: $agentId) {
          success
          message
        }
      }
    `;
    const deleted = await execGraphql<{
      deleteRunHistory: { success: boolean; message: string };
    }>(deleteMutation, { agentId });
    expect(deleted.deleteRunHistory.success).toBe(true);
    expect(fs.existsSync(runDir)).toBe(false);

    const listQuery = `
      query ListRunHistory {
        listRunHistory(limitPerAgent: 10) {
          agents {
            runs {
              agentId
            }
          }
        }
      }
    `;
    const listed = await execGraphql<{
      listRunHistory: Array<{
        agents: Array<{
          runs: Array<{ agentId: string }>;
        }>;
      }>;
    }>(listQuery);

    const remainingRunIds = listed.listRunHistory
      .flatMap((workspace) => workspace.agents)
      .flatMap((agent) => agent.runs)
      .map((run) => run.agentId);
    expect(remainingRunIds.includes(agentId)).toBe(false);
  });

  it("rejects path-traversal-like run IDs", async () => {
    const deleteMutation = `
      mutation DeleteRunHistory($agentId: String!) {
        deleteRunHistory(agentId: $agentId) {
          success
          message
        }
      }
    `;
    const result = await execGraphql<{
      deleteRunHistory: { success: boolean; message: string };
    }>(deleteMutation, { agentId: "../escape" });

    expect(result.deleteRunHistory.success).toBe(false);
    expect(result.deleteRunHistory.message).toContain("Invalid");
  });

  it("deletes stale index rows even when run directory is missing", async () => {
    const agentId = `run_history_stale_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    createdRunIds.add(agentId);

    const index = readIndex(indexFilePath);
    index.rows = index.rows
      .filter((row) => row.agentId !== agentId)
      .concat({
        agentId,
        agentDefinitionId: "agent-def-e2e",
        agentName: "E2E Agent",
        workspaceRootPath: "/tmp/e2e",
        summary: "stale row",
        lastActivityAt: new Date().toISOString(),
        lastKnownStatus: "IDLE",
      });
    writeIndex(indexFilePath, index);

    const deleteMutation = `
      mutation DeleteRunHistory($agentId: String!) {
        deleteRunHistory(agentId: $agentId) {
          success
          message
        }
      }
    `;
    const deleted = await execGraphql<{
      deleteRunHistory: { success: boolean; message: string };
    }>(deleteMutation, { agentId });
    expect(deleted.deleteRunHistory.success).toBe(true);

    const updatedIndex = readIndex(indexFilePath);
    expect(updatedIndex.rows.some((row) => row.agentId === agentId)).toBe(false);
  });
});
