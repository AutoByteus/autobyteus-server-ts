import "reflect-metadata";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { graphql as graphqlFn, GraphQLSchema } from "graphql";
import { buildGraphqlSchema } from "../../../src/api/graphql/schema.js";
import { appConfigProvider } from "../../../src/config/app-config-provider.js";
import type { TeamRunManifest } from "../../../src/run-history/domain/team-models.js";
import { getTeamRunHistoryService } from "../../../src/run-history/services/team-run-history-service.js";
import { AgentTeamInstanceManager } from "../../../src/agent-team-execution/services/agent-team-instance-manager.js";

const listTeamRunHistoryQuery = `
  query ListTeamRunHistory {
    listTeamRunHistory {
      teamId
      teamDefinitionId
      teamDefinitionName
      workspaceRootPath
      summary
      lastActivityAt
      lastKnownStatus
      deleteLifecycle
      isActive
      members {
        memberRouteKey
        memberName
        memberAgentId
        workspaceRootPath
      }
    }
  }
`;

const getTeamRunResumeConfigQuery = `
  query GetTeamRunResumeConfig($teamId: String!) {
    getTeamRunResumeConfig(teamId: $teamId) {
      teamId
      isActive
      manifest
    }
  }
`;

const getTeamMemberRunProjectionQuery = `
  query GetTeamMemberRunProjection($teamId: String!, $memberRouteKey: String!) {
    getTeamMemberRunProjection(teamId: $teamId, memberRouteKey: $memberRouteKey) {
      agentId
      summary
      lastActivityAt
      conversation
    }
  }
`;

const deleteTeamRunHistoryMutation = `
  mutation DeleteTeamRunHistory($teamId: String!) {
    deleteTeamRunHistory(teamId: $teamId) {
      success
      message
    }
  }
`;

const sendMessageToTeamMutation = `
  mutation SendMessageToTeam($input: SendMessageToTeamInput!) {
    sendMessageToTeam(input: $input) {
      success
      message
      teamId
    }
  }
`;

describe("Team run history GraphQL e2e", () => {
  let schema: GraphQLSchema;
  let graphql: typeof graphqlFn;
  const seededTeamIds = new Set<string>();

  beforeAll(async () => {
    schema = await buildGraphqlSchema();
    const require = createRequire(import.meta.url);
    const typeGraphqlRoot = path.dirname(require.resolve("type-graphql"));
    const graphqlPath = require.resolve("graphql", { paths: [typeGraphqlRoot] });
    const graphqlModule = await import(graphqlPath);
    graphql = graphqlModule.graphql as typeof graphqlFn;
  });

  afterEach(async () => {
    vi.restoreAllMocks();

    const teamRunHistoryService = getTeamRunHistoryService();
    const memoryDir = appConfigProvider.config.getMemoryDir();

    for (const teamId of seededTeamIds) {
      await teamRunHistoryService.deleteTeamRunHistory(teamId);
      await fs.rm(path.join(memoryDir, "agent_teams", teamId), {
        recursive: true,
        force: true,
      });
    }
    seededTeamIds.clear();
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

  const seedTeamRunHistory = async (): Promise<{
    teamId: string;
    memberRouteKey: string;
    memberAgentId: string;
  }> => {
    const unique = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const teamId = `team_history_e2e_${unique}`;
    const memberRouteKey = "super_agent";
    const memberAgentId = `member_e2e_${unique}`;
    const workspaceRootPath = path.join(os.tmpdir(), `autobyteus-team-history-${unique}`);
    await fs.mkdir(workspaceRootPath, { recursive: true });

    const manifest: TeamRunManifest = {
      teamId,
      teamDefinitionId: `team_definition_${unique}`,
      teamDefinitionName: `Team ${unique}`,
      workspaceRootPath,
      coordinatorMemberRouteKey: memberRouteKey,
      runVersion: 1,
      createdAt: "2026-02-15T00:00:00.000Z",
      updatedAt: "2026-02-15T00:00:00.000Z",
      memberBindings: [
        {
          memberRouteKey,
          memberName: "super_agent",
          memberAgentId,
          agentDefinitionId: `agent_definition_${unique}`,
          llmModelIdentifier: "e2e-model",
          autoExecuteTools: false,
          llmConfig: null,
          workspaceRootPath,
          hostNodeId: null,
        },
      ],
    };

    await getTeamRunHistoryService().upsertTeamRunHistoryRow({
      teamId,
      manifest,
      summary: "team run seeded summary",
      lastKnownStatus: "IDLE",
      lastActivityAt: "2026-02-15T00:00:00.000Z",
    });

    seededTeamIds.add(teamId);

    return {
      teamId,
      memberRouteKey,
      memberAgentId,
    };
  };

  it("lists team run history, returns resume config/projection, and deletes history", async () => {
    const { teamId, memberRouteKey, memberAgentId } = await seedTeamRunHistory();

    const listResult = await execGraphql<{
      listTeamRunHistory: Array<{
        teamId: string;
        summary: string;
        lastKnownStatus: string;
        deleteLifecycle: string;
        isActive: boolean;
        members: Array<{ memberRouteKey: string; memberAgentId: string }>;
      }>;
    }>(listTeamRunHistoryQuery);

    const row = listResult.listTeamRunHistory.find((item) => item.teamId === teamId);
    expect(row).toBeTruthy();
    expect(row?.summary).toBe("team run seeded summary");
    expect(row?.lastKnownStatus).toBe("IDLE");
    expect(row?.deleteLifecycle).toBe("READY");
    expect(row?.isActive).toBe(false);
    expect(row?.members[0]?.memberRouteKey).toBe(memberRouteKey);
    expect(row?.members[0]?.memberAgentId).toBe(memberAgentId);

    const resumeResult = await execGraphql<{
      getTeamRunResumeConfig: {
        teamId: string;
        isActive: boolean;
        manifest: {
          teamId: string;
          teamDefinitionId: string;
          workspaceRootPath: string;
        };
      };
    }>(getTeamRunResumeConfigQuery, { teamId });

    expect(resumeResult.getTeamRunResumeConfig.teamId).toBe(teamId);
    expect(resumeResult.getTeamRunResumeConfig.isActive).toBe(false);
    expect(resumeResult.getTeamRunResumeConfig.manifest.teamId).toBe(teamId);

    const projectionResult = await execGraphql<{
      getTeamMemberRunProjection: {
        agentId: string;
        conversation: Array<Record<string, unknown>>;
      };
    }>(getTeamMemberRunProjectionQuery, {
      teamId,
      memberRouteKey,
    });

    expect(projectionResult.getTeamMemberRunProjection.agentId).toBe(memberAgentId);
    expect(Array.isArray(projectionResult.getTeamMemberRunProjection.conversation)).toBe(true);

    const deleteResult = await execGraphql<{
      deleteTeamRunHistory: { success: boolean; message: string };
    }>(deleteTeamRunHistoryMutation, { teamId });

    expect(deleteResult.deleteTeamRunHistory.success).toBe(true);
    expect(deleteResult.deleteTeamRunHistory.message).toContain(teamId);

    seededTeamIds.delete(teamId);
  });

  it("continues an offline team run for an existing teamId", async () => {
    const { teamId } = await seedTeamRunHistory();

    const manager = AgentTeamInstanceManager.getInstance();
    let active = false;
    const postMessage = vi.fn().mockResolvedValue(undefined);

    vi.spyOn(manager, "getTeamInstance").mockImplementation((id: string) => {
      if (id !== teamId || !active) {
        return null;
      }
      return {
        teamId,
        postMessage,
      } as any;
    });

    vi.spyOn(manager, "createTeamInstanceWithId").mockImplementation(async (id: string) => {
      if (id === teamId) {
        active = true;
      }
      return id;
    });

    const result = await execGraphql<{
      sendMessageToTeam: {
        success: boolean;
        message: string;
        teamId: string | null;
      };
    }>(sendMessageToTeamMutation, {
      input: {
        teamId,
        targetMemberName: "super_agent",
        userInput: {
          content: "hello continuation",
          contextFiles: [],
        },
      },
    });

    expect(result.sendMessageToTeam.success).toBe(true);
    expect(result.sendMessageToTeam.teamId).toBe(teamId);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(expect.any(Object), "super_agent");
  });
});
