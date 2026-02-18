import "reflect-metadata";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { graphql as graphqlFn, GraphQLSchema } from "graphql";
import { buildGraphqlSchema } from "../../../src/api/graphql/schema.js";
import { appConfigProvider } from "../../../src/config/app-config-provider.js";
import { AgentTeamInstanceManager } from "../../../src/agent-team-execution/services/agent-team-instance-manager.js";
import { getDefaultTeamCommandIngressService } from "../../../src/distributed/bootstrap/default-distributed-runtime-composition.js";
import { buildTeamMemberAgentId } from "../../../src/run-history/utils/team-member-agent-id.js";

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

describe("Team run restore lifecycle GraphQL e2e", () => {
  let schema: GraphQLSchema;
  let graphql: typeof graphqlFn;
  let tempRoot: string;
  let usingTemp = false;
  let memoryDir: string;
  let indexFilePath: string;
  const createdTeamIds = new Set<string>();

  const config = appConfigProvider.config;
  const activeTeams = new Set<string>();
  let createTeamInstanceWithIdSpy: ReturnType<typeof vi.spyOn> | null = null;
  let terminateTeamInstanceSpy: ReturnType<typeof vi.spyOn> | null = null;
  let getTeamInstanceSpy: ReturnType<typeof vi.spyOn> | null = null;
  let ingressDispatchSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autobyteus-team-run-restore-e2e-"));
    if (!config.isInitialized()) {
      config.setCustomAppDataDir(tempRoot);
      usingTemp = true;
    }
    memoryDir = config.getMemoryDir();
    indexFilePath = path.join(memoryDir, "team_run_history_index.json");

    const teamManager = AgentTeamInstanceManager.getInstance();
    createTeamInstanceWithIdSpy = vi
      .spyOn(teamManager, "createTeamInstanceWithId")
      .mockImplementation(async (teamId: string) => {
        createdTeamIds.add(teamId);
        activeTeams.add(teamId);
        return teamId;
      });
    terminateTeamInstanceSpy = vi
      .spyOn(teamManager, "terminateTeamInstance")
      .mockImplementation(async (teamId: string) => {
        activeTeams.delete(teamId);
        return true;
      });
    getTeamInstanceSpy = vi
      .spyOn(teamManager, "getTeamInstance")
      .mockImplementation((teamId: string) => (activeTeams.has(teamId) ? ({ teamId } as any) : null));

    ingressDispatchSpy = vi
      .spyOn(getDefaultTeamCommandIngressService(), "dispatchUserMessage")
      .mockResolvedValue({
        teamId: "stub-team",
        teamRunId: "stub-run",
        runVersion: 1,
      } as any);

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
      activeTeams.delete(teamId);
      fs.rmSync(path.join(memoryDir, "agent_teams", teamId), { recursive: true, force: true });
    }
    createdTeamIds.clear();
  });

  afterAll(() => {
    ingressDispatchSpy?.mockRestore();
    getTeamInstanceSpy?.mockRestore();
    terminateTeamInstanceSpy?.mockRestore();
    createTeamInstanceWithIdSpy?.mockRestore();
    vi.restoreAllMocks();
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

  it("supports single-node team create, terminate, restore, and rerun via GraphQL", async () => {
    const sendMutation = `
      mutation SendMessageToTeam($input: SendMessageToTeamInput!) {
        sendMessageToTeam(input: $input) {
          success
          message
          teamId
        }
      }
    `;

    const firstSend = await execGraphql<{
      sendMessageToTeam: { success: boolean; teamId: string };
    }>(sendMutation, {
      input: {
        userInput: {
          content: "start team",
          contextFiles: null,
        },
        teamDefinitionId: "team-def-e2e",
        targetMemberName: "coordinator",
        memberConfigs: [
          {
            memberName: "coordinator",
            agentDefinitionId: "agent-def-1",
            llmModelIdentifier: "gpt-4o-mini",
            autoExecuteTools: true,
          },
        ],
      },
    });

    expect(firstSend.sendMessageToTeam.success).toBe(true);
    const teamId = firstSend.sendMessageToTeam.teamId;
    expect(teamId).toBeTruthy();
    expect(createTeamInstanceWithIdSpy).toHaveBeenCalledTimes(1);
    expect(ingressDispatchSpy).toHaveBeenCalledTimes(1);
    const firstCreateCall = createTeamInstanceWithIdSpy?.mock.calls[0];
    const firstCreateMemberConfigs = (firstCreateCall?.[2] ?? []) as Array<Record<string, unknown>>;
    expect(firstCreateMemberConfigs).toEqual([
      expect.objectContaining({
        memberRouteKey: "coordinator",
        memberAgentId: buildTeamMemberAgentId(teamId, "coordinator"),
      }),
    ]);

    const listQuery = `
      query ListTeamRunHistory {
        listTeamRunHistory {
          teamId
          lastKnownStatus
          summary
        }
      }
    `;
    const listedAfterFirstSend = await execGraphql<{
      listTeamRunHistory: Array<{ teamId: string; lastKnownStatus: string; summary: string }>;
    }>(listQuery);
    const firstRow = listedAfterFirstSend.listTeamRunHistory.find((item) => item.teamId === teamId);
    expect(firstRow).toBeTruthy();
    expect(firstRow?.lastKnownStatus).toBe("ACTIVE");
    expect(firstRow?.summary).toContain("start team");

    const resumeQuery = `
      query GetTeamRunResumeConfig($teamId: String!) {
        getTeamRunResumeConfig(teamId: $teamId) {
          teamId
          isActive
          manifest
        }
      }
    `;
    const resumeBeforeTerminate = await execGraphql<{
      getTeamRunResumeConfig: {
        teamId: string;
        isActive: boolean;
        manifest: { memberBindings: Array<{ memberRouteKey: string; memberAgentId: string }> };
      };
    }>(resumeQuery, { teamId });
    expect(resumeBeforeTerminate.getTeamRunResumeConfig.teamId).toBe(teamId);
    expect(resumeBeforeTerminate.getTeamRunResumeConfig.isActive).toBe(true);
    expect(
      resumeBeforeTerminate.getTeamRunResumeConfig.manifest.memberBindings[0]?.memberRouteKey,
    ).toBe("coordinator");
    expect(
      resumeBeforeTerminate.getTeamRunResumeConfig.manifest.memberBindings[0]?.memberAgentId,
    ).toBe(buildTeamMemberAgentId(teamId, "coordinator"));

    const terminateMutation = `
      mutation TerminateTeam($id: String!) {
        terminateAgentTeamInstance(id: $id) {
          success
          message
        }
      }
    `;
    const terminated = await execGraphql<{
      terminateAgentTeamInstance: { success: boolean };
    }>(terminateMutation, { id: teamId });
    expect(terminated.terminateAgentTeamInstance.success).toBe(true);

    const listedAfterTerminate = await execGraphql<{
      listTeamRunHistory: Array<{ teamId: string; lastKnownStatus: string; summary: string }>;
    }>(listQuery);
    const terminatedRow = listedAfterTerminate.listTeamRunHistory.find((item) => item.teamId === teamId);
    expect(terminatedRow).toBeTruthy();
    expect(terminatedRow?.lastKnownStatus).toBe("IDLE");

    const secondSend = await execGraphql<{
      sendMessageToTeam: { success: boolean; teamId: string };
    }>(sendMutation, {
      input: {
        userInput: {
          content: "resume team",
          contextFiles: null,
        },
        teamId,
        targetMemberName: "coordinator",
      },
    });
    expect(secondSend.sendMessageToTeam.success).toBe(true);
    expect(secondSend.sendMessageToTeam.teamId).toBe(teamId);
    expect(createTeamInstanceWithIdSpy).toHaveBeenCalledTimes(2);
    expect(ingressDispatchSpy).toHaveBeenCalledTimes(2);

    const listed = await execGraphql<{
      listTeamRunHistory: Array<{ teamId: string; lastKnownStatus: string; summary: string }>;
    }>(listQuery);
    const row = listed.listTeamRunHistory.find((item) => item.teamId === teamId);
    expect(row).toBeTruthy();
    expect(row?.lastKnownStatus).toBe("ACTIVE");
    expect(row?.summary).toContain("resume team");
  });
});
