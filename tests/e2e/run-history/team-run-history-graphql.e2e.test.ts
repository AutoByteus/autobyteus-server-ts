import "reflect-metadata";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { graphql as graphqlFn, GraphQLSchema } from "graphql";
import { buildGraphqlSchema } from "../../../src/api/graphql/schema.js";
import { appConfigProvider } from "../../../src/config/app-config-provider.js";

type TeamRunIndexRow = {
  teamId: string;
  teamDefinitionId: string;
  teamDefinitionName: string;
  summary: string;
  lastActivityAt: string;
  lastKnownStatus: "ACTIVE" | "IDLE" | "ERROR";
  deleteLifecycle: "READY" | "CLEANUP_PENDING";
};

type TeamRunIndexFile = {
  version: number;
  rows: TeamRunIndexRow[];
};

const readTeamIndex = (indexFilePath: string): TeamRunIndexFile => {
  try {
    const raw = fs.readFileSync(indexFilePath, "utf-8");
    const parsed = JSON.parse(raw) as TeamRunIndexFile;
    return {
      version: 1,
      rows: Array.isArray(parsed.rows) ? parsed.rows : [],
    };
  } catch {
    return { version: 1, rows: [] };
  }
};

const writeTeamIndex = (indexFilePath: string, index: TeamRunIndexFile): void => {
  fs.mkdirSync(path.dirname(indexFilePath), { recursive: true });
  fs.writeFileSync(indexFilePath, JSON.stringify(index, null, 2), "utf-8");
};

describe("Team run history GraphQL e2e", () => {
  let schema: GraphQLSchema;
  let graphql: typeof graphqlFn;
  let tempRoot: string;
  let usingTemp = false;
  let memoryDir: string;
  let indexFilePath: string;
  const createdTeamIds = new Set<string>();
  const config = appConfigProvider.config;

  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autobyteus-team-run-history-e2e-"));
    if (!config.isInitialized()) {
      config.setCustomAppDataDir(tempRoot);
      usingTemp = true;
    }
    memoryDir = config.getMemoryDir();
    indexFilePath = path.join(memoryDir, "team_run_history_index.json");

    schema = await buildGraphqlSchema();
    const require = createRequire(import.meta.url);
    const typeGraphqlRoot = path.dirname(require.resolve("type-graphql"));
    const graphqlPath = require.resolve("graphql", { paths: [typeGraphqlRoot] });
    const graphqlModule = await import(graphqlPath);
    graphql = graphqlModule.graphql as typeof graphqlFn;
  });

  afterEach(() => {
    const index = readTeamIndex(indexFilePath);
    index.rows = index.rows.filter((row) => !createdTeamIds.has(row.teamId));
    writeTeamIndex(indexFilePath, index);

    for (const teamId of createdTeamIds) {
      fs.rmSync(path.join(memoryDir, "agent_teams", teamId), { recursive: true, force: true });
    }
    createdTeamIds.clear();
  });

  afterAll(() => {
    if (usingTemp) {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
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

  it("lists team run history rows and returns resume manifest payload", async () => {
    const teamId = `team_history_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    createdTeamIds.add(teamId);
    const nowIso = new Date().toISOString();

    const teamDir = path.join(memoryDir, "agent_teams", teamId);
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, "team_run_manifest.json"),
      JSON.stringify(
        {
          teamId,
          teamDefinitionId: "team-def-e2e",
          teamDefinitionName: "Team E2E",
          coordinatorMemberRouteKey: "coordinator",
          runVersion: 1,
          createdAt: nowIso,
          updatedAt: nowIso,
          memberBindings: [
            {
              memberRouteKey: "coordinator",
              memberName: "coordinator",
              memberAgentId: "member_e2e_a",
              agentDefinitionId: "agent-def-a",
              llmModelIdentifier: "gpt-4o-mini",
              autoExecuteTools: true,
              llmConfig: null,
              workspaceRootPath: "/tmp/team-e2e",
              hostNodeId: "node-local",
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const index = readTeamIndex(indexFilePath);
    index.rows = index.rows
      .filter((row) => row.teamId !== teamId)
      .concat({
        teamId,
        teamDefinitionId: "team-def-e2e",
        teamDefinitionName: "Team E2E",
        summary: "team summary",
        lastActivityAt: nowIso,
        lastKnownStatus: "IDLE",
        deleteLifecycle: "READY",
      });
    writeTeamIndex(indexFilePath, index);

    const listQuery = `
      query ListTeamRunHistory {
        listTeamRunHistory {
          teamId
          teamDefinitionId
          summary
          members {
            memberRouteKey
            memberName
            memberAgentId
            workspaceRootPath
            hostNodeId
          }
        }
      }
    `;
    const listed = await execGraphql<{
      listTeamRunHistory: Array<{
        teamId: string;
        teamDefinitionId: string;
        summary: string;
        members: Array<{ memberRouteKey: string; memberAgentId: string }>;
      }>;
    }>(listQuery);

    const row = listed.listTeamRunHistory.find((item) => item.teamId === teamId);
    expect(row).toBeTruthy();
    expect(row?.teamDefinitionId).toBe("team-def-e2e");
    expect(row?.summary).toBe("team summary");
    expect(row?.members[0]?.memberRouteKey).toBe("coordinator");
    expect(row?.members[0]?.memberAgentId).toBe("member_e2e_a");

    const resumeQuery = `
      query TeamRunResumeConfig($teamId: String!) {
        getTeamRunResumeConfig(teamId: $teamId) {
          teamId
          isActive
          manifest
        }
      }
    `;
    const resumed = await execGraphql<{
      getTeamRunResumeConfig: {
        teamId: string;
        isActive: boolean;
        manifest: { teamDefinitionId: string; memberBindings: Array<{ memberRouteKey: string }> };
      };
    }>(resumeQuery, { teamId });

    expect(resumed.getTeamRunResumeConfig.teamId).toBe(teamId);
    expect(resumed.getTeamRunResumeConfig.isActive).toBe(false);
    expect(resumed.getTeamRunResumeConfig.manifest.teamDefinitionId).toBe("team-def-e2e");
    expect(resumed.getTeamRunResumeConfig.manifest.memberBindings[0]?.memberRouteKey).toBe("coordinator");
  });

  it("deletes inactive team run history and removes team directory", async () => {
    const teamId = `team_delete_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    createdTeamIds.add(teamId);
    const nowIso = new Date().toISOString();

    const teamDir = path.join(memoryDir, "agent_teams", teamId);
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, "team_run_manifest.json"),
      JSON.stringify(
        {
          teamId,
          teamDefinitionId: "team-def-delete",
          teamDefinitionName: "Team Delete",
          coordinatorMemberRouteKey: "coordinator",
          runVersion: 1,
          createdAt: nowIso,
          updatedAt: nowIso,
          memberBindings: [],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const index = readTeamIndex(indexFilePath);
    index.rows = index.rows
      .filter((row) => row.teamId !== teamId)
      .concat({
        teamId,
        teamDefinitionId: "team-def-delete",
        teamDefinitionName: "Team Delete",
        summary: "delete me",
        lastActivityAt: nowIso,
        lastKnownStatus: "IDLE",
        deleteLifecycle: "READY",
      });
    writeTeamIndex(indexFilePath, index);

    const deleteMutation = `
      mutation DeleteTeamRunHistory($teamId: String!) {
        deleteTeamRunHistory(teamId: $teamId) {
          success
          message
        }
      }
    `;
    const deleted = await execGraphql<{
      deleteTeamRunHistory: { success: boolean; message: string };
    }>(deleteMutation, { teamId });

    expect(deleted.deleteTeamRunHistory.success).toBe(true);
    expect(fs.existsSync(teamDir)).toBe(false);

    const updatedIndex = readTeamIndex(indexFilePath);
    expect(updatedIndex.rows.some((row) => row.teamId === teamId)).toBe(false);
  });

  it("lists all team run history rows ordered by lastActivityAt desc", async () => {
    const base = Date.now();
    const rows = [
      {
        teamId: `team_history_multi_${base}_a`,
        teamDefinitionId: "team-def-a",
        teamDefinitionName: "Team A",
        summary: "summary a",
        lastActivityAt: new Date(base - 10_000).toISOString(),
      },
      {
        teamId: `team_history_multi_${base}_b`,
        teamDefinitionId: "team-def-b",
        teamDefinitionName: "Team B",
        summary: "summary b",
        lastActivityAt: new Date(base - 1_000).toISOString(),
      },
      {
        teamId: `team_history_multi_${base}_c`,
        teamDefinitionId: "team-def-c",
        teamDefinitionName: "Team C",
        summary: "summary c",
        lastActivityAt: new Date(base - 5_000).toISOString(),
      },
    ] as const;

    for (const row of rows) {
      createdTeamIds.add(row.teamId);
      const teamDir = path.join(memoryDir, "agent_teams", row.teamId);
      fs.mkdirSync(teamDir, { recursive: true });
      fs.writeFileSync(
        path.join(teamDir, "team_run_manifest.json"),
        JSON.stringify(
          {
            teamId: row.teamId,
            teamDefinitionId: row.teamDefinitionId,
            teamDefinitionName: row.teamDefinitionName,
            coordinatorMemberRouteKey: "coordinator",
            runVersion: 1,
            createdAt: row.lastActivityAt,
            updatedAt: row.lastActivityAt,
            memberBindings: [
              {
                memberRouteKey: "coordinator",
                memberName: "coordinator",
                memberAgentId: `member_${row.teamId}`,
                agentDefinitionId: "agent-def-a",
                llmModelIdentifier: "gpt-4o-mini",
                autoExecuteTools: true,
                llmConfig: null,
                workspaceRootPath: "/tmp/team-multi",
                hostNodeId: "node-local",
              },
            ],
          },
          null,
          2,
        ),
        "utf-8",
      );
    }

    const index = readTeamIndex(indexFilePath);
    index.rows = index.rows
      .filter((row) => !rows.some((candidate) => candidate.teamId === row.teamId))
      .concat(
        rows.map((row) => ({
          teamId: row.teamId,
          teamDefinitionId: row.teamDefinitionId,
          teamDefinitionName: row.teamDefinitionName,
          summary: row.summary,
          lastActivityAt: row.lastActivityAt,
          lastKnownStatus: "IDLE" as const,
          deleteLifecycle: "READY" as const,
        })),
      );
    writeTeamIndex(indexFilePath, index);

    const listQuery = `
      query ListTeamRunHistory {
        listTeamRunHistory {
          teamId
          lastActivityAt
          summary
        }
      }
    `;
    const listed = await execGraphql<{
      listTeamRunHistory: Array<{
        teamId: string;
        lastActivityAt: string;
        summary: string;
      }>;
    }>(listQuery);

    const listedRows = listed.listTeamRunHistory.filter((row) =>
      rows.some((candidate) => candidate.teamId === row.teamId),
    );
    expect(listedRows).toHaveLength(rows.length);

    const expectedOrder = [...rows]
      .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
      .map((row) => row.teamId);
    expect(listedRows.map((row) => row.teamId)).toEqual(expectedOrder);
  });
});
