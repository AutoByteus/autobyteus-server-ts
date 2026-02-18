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

describe("Team member projection contract e2e", () => {
  let schema: GraphQLSchema;
  let graphql: typeof graphqlFn;
  let tempRoot: string;
  let usingTemp = false;
  let memoryDir: string;
  let indexFilePath: string;

  const config = appConfigProvider.config;
  const activeTeams = new Set<string>();
  const createdTeamIds = new Set<string>();
  const createdMemberIds = new Set<string>();

  let createTeamInstanceWithIdSpy: ReturnType<typeof vi.spyOn> | null = null;
  let terminateTeamInstanceSpy: ReturnType<typeof vi.spyOn> | null = null;
  let getTeamInstanceSpy: ReturnType<typeof vi.spyOn> | null = null;
  let ingressDispatchSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autobyteus-team-member-projection-e2e-"));
    if (!config.isInitialized()) {
      config.setCustomAppDataDir(tempRoot);
      usingTemp = true;
    }
    memoryDir = config.getMemoryDir();
    indexFilePath = path.join(memoryDir, "team_run_history_index.json");

    const teamManager = AgentTeamInstanceManager.getInstance();
    createTeamInstanceWithIdSpy = vi
      .spyOn(teamManager, "createTeamInstanceWithId")
      .mockImplementation(async (teamId: string, _teamDefinitionId: string, memberConfigs: any[]) => {
        activeTeams.add(teamId);
        createdTeamIds.add(teamId);

        for (const memberConfig of memberConfigs) {
          const memberAgentId =
            typeof memberConfig?.memberAgentId === "string" ? memberConfig.memberAgentId.trim() : "";
          if (!memberAgentId) {
            continue;
          }
          createdMemberIds.add(memberAgentId);
          const memberDir = path.join(memoryDir, "agents", memberAgentId);
          fs.mkdirSync(memberDir, { recursive: true });
          fs.writeFileSync(
            path.join(memberDir, "raw_traces.jsonl"),
            [
              JSON.stringify({
                trace_type: "user",
                content: `hello ${memberConfig.memberName}`,
                turn_id: "turn_1",
                seq: 1,
                ts: 1_700_000_000,
              }),
              JSON.stringify({
                trace_type: "assistant",
                content: `hi from ${memberConfig.memberName}`,
                turn_id: "turn_1",
                seq: 2,
                ts: 1_700_000_001,
              }),
            ].join("\n") + "\n",
            "utf-8",
          );
        }

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

    for (const memberId of createdMemberIds) {
      fs.rmSync(path.join(memoryDir, "agents", memberId), { recursive: true, force: true });
    }
    createdMemberIds.clear();
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

  it("keeps manifest member IDs aligned with runtime projection IDs", async () => {
    const sendMutation = `
      mutation SendMessageToTeam($input: SendMessageToTeamInput!) {
        sendMessageToTeam(input: $input) {
          success
          teamId
        }
      }
    `;

    const sent = await execGraphql<{
      sendMessageToTeam: { success: boolean; teamId: string };
    }>(sendMutation, {
      input: {
        userInput: {
          content: "start team",
          contextFiles: null,
        },
        teamDefinitionId: "def-projection",
        targetMemberName: "professor",
        memberConfigs: [
          {
            memberName: "professor",
            agentDefinitionId: "agent-def-professor",
            llmModelIdentifier: "gpt-4o-mini",
            autoExecuteTools: false,
          },
          {
            memberName: "student",
            agentDefinitionId: "agent-def-student",
            llmModelIdentifier: "gpt-4o-mini",
            autoExecuteTools: false,
          },
        ],
      },
    });

    expect(sent.sendMessageToTeam.success).toBe(true);
    expect(createTeamInstanceWithIdSpy).toHaveBeenCalledTimes(1);
    const teamId = sent.sendMessageToTeam.teamId;
    const createdCall = createTeamInstanceWithIdSpy?.mock.calls[0];
    const createdMemberConfigs = (createdCall?.[2] ?? []) as Array<{
      memberName: string;
      memberRouteKey: string;
      memberAgentId: string;
    }>;
    expect(createdMemberConfigs).toHaveLength(2);
    expect(createdMemberConfigs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          memberName: "professor",
          memberRouteKey: "professor",
          memberAgentId: buildTeamMemberAgentId(teamId, "professor"),
        }),
        expect.objectContaining({
          memberName: "student",
          memberRouteKey: "student",
          memberAgentId: buildTeamMemberAgentId(teamId, "student"),
        }),
      ]),
    );

    const resumeQuery = `
      query GetTeamRunResumeConfig($teamId: String!) {
        getTeamRunResumeConfig(teamId: $teamId) {
          teamId
          manifest
        }
      }
    `;
    const resumed = await execGraphql<{
      getTeamRunResumeConfig: {
        teamId: string;
        manifest: {
          memberBindings: Array<{
            memberRouteKey: string;
            memberAgentId: string;
          }>;
        };
      };
    }>(resumeQuery, { teamId });

    const manifestBindings = resumed.getTeamRunResumeConfig.manifest.memberBindings;
    for (const member of createdMemberConfigs) {
      const manifestBinding = manifestBindings.find(
        (binding) => binding.memberRouteKey === member.memberRouteKey,
      );
      expect(manifestBinding?.memberAgentId).toBe(member.memberAgentId);
    }

    const projectionQuery = `
      query GetRunProjection($agentId: String!) {
        getRunProjection(agentId: $agentId) {
          agentId
          conversation
        }
      }
    `;
    for (const member of createdMemberConfigs) {
      const projection = await execGraphql<{
        getRunProjection: {
          agentId: string;
          conversation: Array<Record<string, unknown>>;
        };
      }>(projectionQuery, { agentId: member.memberAgentId });
      expect(projection.getRunProjection.agentId).toBe(member.memberAgentId);
      expect(projection.getRunProjection.conversation.length).toBeGreaterThan(0);
    }
  });
});
