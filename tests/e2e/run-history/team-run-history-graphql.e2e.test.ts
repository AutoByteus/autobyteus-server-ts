import "reflect-metadata";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { graphql as graphqlFn, GraphQLSchema } from "graphql";
import { LLMFactory } from "autobyteus-ts/llm/llm-factory.js";
import { BaseLLM } from "autobyteus-ts/llm/base.js";
import { LLMModel } from "autobyteus-ts/llm/models.js";
import { LLMProvider } from "autobyteus-ts/llm/providers.js";
import { LLMConfig } from "autobyteus-ts/llm/utils/llm-config.js";
import { Message, MessageRole } from "autobyteus-ts/llm/utils/messages.js";
import { CompleteResponse, ChunkResponse } from "autobyteus-ts/llm/utils/response-types.js";
import { buildGraphqlSchema } from "../../../src/api/graphql/schema.js";
import { appConfigProvider } from "../../../src/config/app-config-provider.js";
import type { TeamRunManifest } from "../../../src/run-history/domain/team-models.js";
import { getTeamRunHistoryService } from "../../../src/run-history/services/team-run-history-service.js";
import { AgentTeamInstanceManager } from "../../../src/agent-team-execution/services/agent-team-instance-manager.js";
import { AgentDefinitionService } from "../../../src/agent-definition/services/agent-definition-service.js";
import { AgentTeamDefinitionService } from "../../../src/agent-team-definition/services/agent-team-definition-service.js";
import { PromptService } from "../../../src/prompt-engineering/services/prompt-service.js";

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

const createPromptMutation = `
  mutation CreatePrompt($input: CreatePromptInput!) {
    createPrompt(input: $input) {
      id
      name
      category
    }
  }
`;

const createAgentDefinitionMutation = `
  mutation CreateAgentDefinition($input: CreateAgentDefinitionInput!) {
    createAgentDefinition(input: $input) {
      id
      name
    }
  }
`;

const createAgentTeamDefinitionMutation = `
  mutation CreateAgentTeamDefinition($input: CreateAgentTeamDefinitionInput!) {
    createAgentTeamDefinition(input: $input) {
      id
      name
    }
  }
`;

const createAgentTeamInstanceMutation = `
  mutation CreateAgentTeamInstance($input: CreateAgentTeamInstanceInput!) {
    createAgentTeamInstance(input: $input) {
      success
      message
      teamId
    }
  }
`;

const terminateAgentTeamInstanceMutation = `
  mutation TerminateAgentTeamInstance($id: String!) {
    terminateAgentTeamInstance(id: $id) {
      success
      message
    }
  }
`;

const turnOneMarker = "remember-token-restore-e2e";
const turnTwoQuestion = "what did i ask before?";

class HistoryAwareDummyLLM extends BaseLLM {
  private buildContent(messages: Message[]): string {
    const userMessages = messages
      .filter((message) => message.role === MessageRole.USER)
      .map((message) => message.content ?? "");
    const sawTurnOneMarker = userMessages.some((content) => content.includes(turnOneMarker));
    const isTurnTwoQuestion = userMessages.some((content) => content.includes(turnTwoQuestion));

    if (isTurnTwoQuestion) {
      return sawTurnOneMarker ? "history_visible=true" : "history_visible=false";
    }
    return "acknowledged";
  }

  protected async _sendMessagesToLLM(messages: Message[]): Promise<CompleteResponse> {
    return new CompleteResponse({ content: this.buildContent(messages) });
  }

  protected async *_streamMessagesToLLM(
    messages: Message[],
  ): AsyncGenerator<ChunkResponse, void, unknown> {
    yield new ChunkResponse({
      content: this.buildContent(messages),
      is_complete: true,
    });
  }
}

const createDummyLLM = (): HistoryAwareDummyLLM => {
  const model = new LLMModel({
    name: "dummy-history-aware",
    value: "dummy-history-aware",
    canonicalName: "dummy-history-aware",
    provider: LLMProvider.OPENAI,
  });
  return new HistoryAwareDummyLLM(model, new LLMConfig({ systemMessage: "test-system" }));
};

const waitFor = async (
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 15000,
  intervalMs = 100,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${timeoutMs}ms.`);
};

describe("Team run history GraphQL e2e", () => {
  let schema: GraphQLSchema;
  let graphql: typeof graphqlFn;
  const seededTeamIds = new Set<string>();
  const createdPromptIds = new Set<string>();
  const createdAgentDefinitionIds = new Set<string>();
  const createdTeamDefinitionIds = new Set<string>();

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

    const agentTeamDefinitionService = AgentTeamDefinitionService.getInstance();
    for (const teamDefinitionId of createdTeamDefinitionIds) {
      try {
        await agentTeamDefinitionService.deleteDefinition(teamDefinitionId);
      } catch {
        // Ignore cleanup failures caused by already-deleted records.
      }
    }
    createdTeamDefinitionIds.clear();

    const agentDefinitionService = AgentDefinitionService.getInstance();
    for (const agentDefinitionId of createdAgentDefinitionIds) {
      try {
        await agentDefinitionService.deleteAgentDefinition(agentDefinitionId);
      } catch {
        // Ignore cleanup failures caused by already-deleted records.
      }
    }
    createdAgentDefinitionIds.clear();

    const promptService = PromptService.getInstance();
    for (const promptId of createdPromptIds) {
      try {
        await promptService.deletePrompt(promptId);
      } catch {
        // Ignore cleanup failures caused by already-deleted records.
      }
    }
    createdPromptIds.clear();
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

  it("persists team member memory and restores it after terminate/continue", async () => {
    vi.spyOn(LLMFactory, "createLLM").mockImplementation(async () => createDummyLLM());
    vi.spyOn(LLMFactory, "getProvider").mockResolvedValue(LLMProvider.OPENAI);

    const unique = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const promptName = `team_history_prompt_${unique}`;
    const promptCategory = `team_history_category_${unique}`;
    const workspaceRootPath = path.join(os.tmpdir(), `team-history-workspace-${unique}`);
    await fs.mkdir(workspaceRootPath, { recursive: true });

    const promptResult = await execGraphql<{
      createPrompt: { id: string };
    }>(createPromptMutation, {
      input: {
        name: promptName,
        category: promptCategory,
        promptContent: "You are a concise assistant.",
      },
    });
    createdPromptIds.add(promptResult.createPrompt.id);

    const agentDefinitionResult = await execGraphql<{
      createAgentDefinition: { id: string };
    }>(createAgentDefinitionMutation, {
      input: {
        name: `history-agent-${unique}`,
        role: "assistant",
        description: "History restore test agent",
        systemPromptCategory: promptCategory,
        systemPromptName: promptName,
      },
    });
    const agentDefinitionId = agentDefinitionResult.createAgentDefinition.id;
    createdAgentDefinitionIds.add(agentDefinitionId);

    const teamDefinitionResult = await execGraphql<{
      createAgentTeamDefinition: { id: string };
    }>(createAgentTeamDefinitionMutation, {
      input: {
        name: `history-team-${unique}`,
        description: "History restore team",
        coordinatorMemberName: "professor",
        nodes: [
          {
            memberName: "professor",
            referenceId: agentDefinitionId,
            referenceType: "AGENT",
          },
        ],
      },
    });
    const teamDefinitionId = teamDefinitionResult.createAgentTeamDefinition.id;
    createdTeamDefinitionIds.add(teamDefinitionId);

    const createTeamResult = await execGraphql<{
      createAgentTeamInstance: {
        success: boolean;
        teamId: string | null;
        message: string;
      };
    }>(createAgentTeamInstanceMutation, {
      input: {
        teamDefinitionId,
        memberConfigs: [
          {
            memberName: "professor",
            agentDefinitionId,
            llmModelIdentifier: "dummy-history-aware-model",
            autoExecuteTools: false,
            workspaceRootPath,
          },
        ],
      },
    });
    expect(createTeamResult.createAgentTeamInstance.success).toBe(true);
    expect(createTeamResult.createAgentTeamInstance.teamId).toBeTruthy();
    const teamId = createTeamResult.createAgentTeamInstance.teamId as string;
    seededTeamIds.add(teamId);

    const firstSendResult = await execGraphql<{
      sendMessageToTeam: { success: boolean; teamId: string | null; message: string };
    }>(sendMessageToTeamMutation, {
      input: {
        teamId,
        targetMemberName: "professor",
        userInput: {
          content: `please remember ${turnOneMarker}`,
          contextFiles: [],
        },
      },
    });
    expect(firstSendResult.sendMessageToTeam.success).toBe(true);
    expect(firstSendResult.sendMessageToTeam.teamId).toBe(teamId);

    const resumeResult = await execGraphql<{
      getTeamRunResumeConfig: {
        teamId: string;
        manifest: {
          memberBindings: Array<{
            memberName: string;
            memberRouteKey: string;
            memberAgentId: string;
          }>;
        };
      };
    }>(getTeamRunResumeConfigQuery, { teamId });

    const binding = resumeResult.getTeamRunResumeConfig.manifest.memberBindings.find(
      (candidate) => candidate.memberName === "professor",
    );
    expect(binding).toBeTruthy();
    const memberRouteKey = binding?.memberRouteKey ?? "professor";
    const memberAgentId = binding?.memberAgentId as string;

    const memoryDir = appConfigProvider.config.getMemoryDir();
    const rawTraceFile = path.join(memoryDir, "agents", memberAgentId, "raw_traces.jsonl");
    const snapshotFile = path.join(
      memoryDir,
      "agents",
      memberAgentId,
      "working_context_snapshot.json",
    );

    await waitFor(async () => {
      try {
        const rawTrace = await fs.readFile(rawTraceFile, "utf-8");
        return rawTrace.includes(turnOneMarker);
      } catch {
        return false;
      }
    });

    await waitFor(async () => {
      try {
        await fs.access(snapshotFile);
        return true;
      } catch {
        return false;
      }
    });

    const terminateResult = await execGraphql<{
      terminateAgentTeamInstance: { success: boolean; message: string };
    }>(terminateAgentTeamInstanceMutation, { id: teamId });
    expect(terminateResult.terminateAgentTeamInstance.success).toBe(true);

    const continueResult = await execGraphql<{
      sendMessageToTeam: { success: boolean; teamId: string | null; message: string };
    }>(sendMessageToTeamMutation, {
      input: {
        teamId,
        targetMemberName: memberRouteKey,
        userInput: {
          content: turnTwoQuestion,
          contextFiles: [],
        },
      },
    });
    expect(continueResult.sendMessageToTeam.success).toBe(true);
    expect(continueResult.sendMessageToTeam.teamId).toBe(teamId);

    let projection: {
      summary: string | null;
      conversation: Array<{ role?: string; content?: string | null }>;
    } | null = null;

    await waitFor(async () => {
      const projectionResult = await execGraphql<{
        getTeamMemberRunProjection: {
          summary: string | null;
          conversation: Array<{ role?: string; content?: string | null }>;
        };
      }>(getTeamMemberRunProjectionQuery, {
        teamId,
        memberRouteKey,
      });
      projection = projectionResult.getTeamMemberRunProjection;
      return projection.conversation.some((entry) =>
        String(entry.content ?? "").includes("history_visible=true"),
      );
    });

    expect(projection).toBeTruthy();
    expect(projection?.conversation.some((entry) => String(entry.content ?? "").includes(turnOneMarker))).toBe(true);
    expect(projection?.conversation.some((entry) => String(entry.content ?? "").includes("history_visible=true"))).toBe(true);
    expect(projection?.summary).toContain(turnOneMarker);
  });
});
