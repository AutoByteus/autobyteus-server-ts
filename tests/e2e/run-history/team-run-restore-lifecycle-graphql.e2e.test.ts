import "reflect-metadata";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { graphql as graphqlFn, GraphQLSchema } from "graphql";
import { LLMFactory } from "autobyteus-ts";
import { BaseLLM } from "autobyteus-ts/llm/base.js";
import { LLMModel } from "autobyteus-ts/llm/models.js";
import { LLMProvider } from "autobyteus-ts/llm/providers.js";
import { LLMConfig } from "autobyteus-ts/llm/utils/llm-config.js";
import { ChunkResponse, CompleteResponse } from "autobyteus-ts/llm/utils/response-types.js";
import { AgentDefinitionService } from "../../../src/agent-definition/services/agent-definition-service.js";
import { AgentTeamDefinitionService } from "../../../src/agent-team-definition/services/agent-team-definition-service.js";
import { buildGraphqlSchema } from "../../../src/api/graphql/schema.js";
import { AgentTeamInstanceManager } from "../../../src/agent-team-execution/services/agent-team-instance-manager.js";
import {
  getDefaultTeamCommandIngressService,
  resetDefaultDistributedRuntimeCompositionForTests,
} from "../../../src/distributed/bootstrap/default-distributed-runtime-composition.js";
import { PromptService } from "../../../src/prompt-engineering/services/prompt-service.js";
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

class DummyLLM extends BaseLLM {
  protected async _sendMessagesToLLM(
    _messages: any[],
    _kwargs: Record<string, unknown> = {},
  ): Promise<CompleteResponse> {
    return new CompleteResponse({ content: "ok" });
  }

  protected async *_streamMessagesToLLM(
    _messages: any[],
    _kwargs: Record<string, unknown> = {},
  ): AsyncGenerator<ChunkResponse, void, unknown> {
    yield new ChunkResponse({ content: "ok", is_complete: true });
  }
}

const createDummyLlm = (): DummyLLM => {
  const model = new LLMModel({
    name: "dummy",
    value: "dummy",
    canonicalName: "dummy",
    provider: LLMProvider.OPENAI,
  });
  return new DummyLLM(model, new LLMConfig());
};

describe("Team run restore lifecycle GraphQL e2e", () => {
  let schema: GraphQLSchema;
  let graphql: typeof graphqlFn;
  let tempRoot: string;
  let memoryDir: string;
  let indexFilePath: string;
  let originalMemoryDirEnv: string | undefined;
  const createdTeamIds = new Set<string>();
  const createdTeamDefinitionIds = new Set<string>();
  const createdAgentDefinitionIds = new Set<string>();
  const createdPromptIds = new Set<string>();

  let ingressDispatchSpy: ReturnType<typeof vi.spyOn> | null = null;
  let llmCreateSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autobyteus-team-run-restore-e2e-"));
    originalMemoryDirEnv = process.env.AUTOBYTEUS_MEMORY_DIR;
    memoryDir = path.join(tempRoot, "memory");
    process.env.AUTOBYTEUS_MEMORY_DIR = memoryDir;
    fs.mkdirSync(memoryDir, { recursive: true });
    indexFilePath = path.join(memoryDir, "team_run_history_index.json");

    resetDefaultDistributedRuntimeCompositionForTests();
    llmCreateSpy = vi.spyOn(LLMFactory, "createLLM").mockImplementation(async () => createDummyLlm());

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

  afterEach(async () => {
    const teamManager = AgentTeamInstanceManager.getInstance();
    for (const teamId of createdTeamIds) {
      await teamManager.terminateTeamInstance(teamId).catch(() => false);
    }

    const index = readTeamIndex(indexFilePath);
    index.rows = index.rows.filter((row) => !createdTeamIds.has(row.teamId));
    writeTeamIndex(indexFilePath, index);

    for (const teamId of createdTeamIds) {
      fs.rmSync(path.join(memoryDir, "agent_teams", teamId), { recursive: true, force: true });
    }
    createdTeamIds.clear();

    const teamDefinitionService = AgentTeamDefinitionService.getInstance();
    for (const teamDefinitionId of createdTeamDefinitionIds) {
      await teamDefinitionService.deleteDefinition(teamDefinitionId).catch(() => false);
    }
    createdTeamDefinitionIds.clear();

    const agentDefinitionService = AgentDefinitionService.getInstance();
    for (const agentDefinitionId of createdAgentDefinitionIds) {
      await agentDefinitionService.deleteAgentDefinition(agentDefinitionId).catch(() => false);
    }
    createdAgentDefinitionIds.clear();

    const promptService = PromptService.getInstance();
    for (const promptId of createdPromptIds) {
      await promptService.deletePrompt(promptId).catch(() => false);
    }
    createdPromptIds.clear();
  });

  afterAll(() => {
    llmCreateSpy?.mockRestore();
    ingressDispatchSpy?.mockRestore();
    resetDefaultDistributedRuntimeCompositionForTests();
    vi.restoreAllMocks();
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

  const createSingleMemberTeamFixture = async (unique: string): Promise<{
    teamDefinitionId: string;
    memberName: string;
    agentDefinitionId: string;
  }> => {
    const promptName = `Prompt_${unique}`;
    const promptCategory = `Category_${unique}`;

    const createdPrompt = await execGraphql<{
      createPrompt: { id: string };
    }>(
      `
        mutation CreatePrompt($input: CreatePromptInput!) {
          createPrompt(input: $input) {
            id
          }
        }
      `,
      {
        input: {
          name: promptName,
          category: promptCategory,
          promptContent: "You are a concise assistant.",
          description: "Prompt for team restore lifecycle e2e",
        },
      },
    );
    createdPromptIds.add(createdPrompt.createPrompt.id);

    const createdAgent = await execGraphql<{
      createAgentDefinition: { id: string };
    }>(
      `
        mutation CreateAgentDefinition($input: CreateAgentDefinitionInput!) {
          createAgentDefinition(input: $input) {
            id
          }
        }
      `,
      {
        input: {
          name: `agent_${unique}`,
          role: "assistant",
          description: "Team coordinator agent",
          systemPromptCategory: promptCategory,
          systemPromptName: promptName,
          toolNames: [],
          skillNames: [],
        },
      },
    );
    createdAgentDefinitionIds.add(createdAgent.createAgentDefinition.id);

    const memberName = "coordinator";
    const createdTeam = await execGraphql<{
      createAgentTeamDefinition: { id: string };
    }>(
      `
        mutation CreateTeam($input: CreateAgentTeamDefinitionInput!) {
          createAgentTeamDefinition(input: $input) {
            id
          }
        }
      `,
      {
        input: {
          name: `team_${unique}`,
          description: "Single member restore lifecycle team",
          coordinatorMemberName: memberName,
          nodes: [
            {
              memberName,
              referenceId: createdAgent.createAgentDefinition.id,
              referenceType: "AGENT",
              homeNodeId: "embedded-local",
            },
          ],
        },
      },
    );
    createdTeamDefinitionIds.add(createdTeam.createAgentTeamDefinition.id);

    return {
      teamDefinitionId: createdTeam.createAgentTeamDefinition.id,
      memberName,
      agentDefinitionId: createdAgent.createAgentDefinition.id,
    };
  };

  it("supports single-node team create, terminate, restore, and rerun via GraphQL", async () => {
    const unique = `team_restore_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const fixture = await createSingleMemberTeamFixture(unique);
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
        teamDefinitionId: fixture.teamDefinitionId,
        targetMemberName: fixture.memberName,
        memberConfigs: [
          {
            memberName: fixture.memberName,
            agentDefinitionId: fixture.agentDefinitionId,
            llmModelIdentifier: "dummy",
            autoExecuteTools: true,
          },
        ],
      },
    });

    expect(firstSend.sendMessageToTeam.success).toBe(true);
    const teamId = firstSend.sendMessageToTeam.teamId;
    createdTeamIds.add(teamId);
    expect(teamId).toBeTruthy();
    expect(ingressDispatchSpy).toHaveBeenCalledTimes(1);

    const teamManager = AgentTeamInstanceManager.getInstance();
    expect(teamManager.getTeamInstance(teamId)).toBeTruthy();
    expect(teamManager.getTeamMemberConfigs(teamId)).toEqual([
      expect.objectContaining({
        memberRouteKey: fixture.memberName,
        memberAgentId: buildTeamMemberAgentId(teamId, fixture.memberName),
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
    ).toBe(fixture.memberName);
    expect(
      resumeBeforeTerminate.getTeamRunResumeConfig.manifest.memberBindings[0]?.memberAgentId,
    ).toBe(buildTeamMemberAgentId(teamId, fixture.memberName));

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
    expect(teamManager.getTeamInstance(teamId)).toBeNull();

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
        targetMemberName: fixture.memberName,
      },
    });
    expect(secondSend.sendMessageToTeam.success).toBe(true);
    expect(secondSend.sendMessageToTeam.teamId).toBe(teamId);
    expect(ingressDispatchSpy).toHaveBeenCalledTimes(2);
    expect(teamManager.getTeamMemberConfigs(teamId)).toEqual([
      expect.objectContaining({
        memberRouteKey: fixture.memberName,
        memberAgentId: buildTeamMemberAgentId(teamId, fixture.memberName),
        memoryDir,
      }),
    ]);

    const listed = await execGraphql<{
      listTeamRunHistory: Array<{ teamId: string; lastKnownStatus: string; summary: string }>;
    }>(listQuery);
    const row = listed.listTeamRunHistory.find((item) => item.teamId === teamId);
    expect(row).toBeTruthy();
    expect(row?.lastKnownStatus).toBe("ACTIVE");
    expect(row?.summary).toContain("resume team");
  });
});
