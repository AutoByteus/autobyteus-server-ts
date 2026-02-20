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

describe("Team member projection contract e2e", () => {
  let schema: GraphQLSchema;
  let graphql: typeof graphqlFn;
  let tempRoot: string;
  let memoryDir: string;
  let indexFilePath: string;
  let originalMemoryDirEnv: string | undefined;

  const createdTeamIds = new Set<string>();
  const createdMemberIds = new Set<string>();
  const createdTeamDefinitionIds = new Set<string>();
  const createdAgentDefinitionIds = new Set<string>();
  const createdPromptIds = new Set<string>();

  let ingressDispatchSpy: ReturnType<typeof vi.spyOn> | null = null;
  let llmCreateSpy: ReturnType<typeof vi.spyOn> | null = null;

  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "autobyteus-team-member-projection-e2e-"));
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

    for (const memberId of createdMemberIds) {
      fs.rmSync(path.join(memoryDir, "agents", memberId), { recursive: true, force: true });
    }
    createdMemberIds.clear();

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

  const createTwoMemberTeamFixture = async (unique: string): Promise<{
    teamDefinitionId: string;
    members: Array<{ memberName: string; agentDefinitionId: string }>;
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
          promptContent: "You are concise and deterministic.",
          description: "Prompt for team member projection e2e",
        },
      },
    );
    createdPromptIds.add(createdPrompt.createPrompt.id);

    const createMember = async (memberName: string): Promise<string> => {
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
            name: `${memberName}_${unique}`,
            role: "assistant",
            description: `Agent definition for ${memberName}`,
            systemPromptCategory: promptCategory,
            systemPromptName: promptName,
            toolNames: [],
            skillNames: [],
          },
        },
      );
      createdAgentDefinitionIds.add(createdAgent.createAgentDefinition.id);
      return createdAgent.createAgentDefinition.id;
    };

    const professorAgentDefinitionId = await createMember("professor");
    const studentAgentDefinitionId = await createMember("student");

    const members = [
      { memberName: "professor", agentDefinitionId: professorAgentDefinitionId },
      { memberName: "student", agentDefinitionId: studentAgentDefinitionId },
    ];

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
          name: `team_projection_${unique}`,
          description: "Team projection contract e2e",
          coordinatorMemberName: "professor",
          nodes: members.map((member) => ({
            memberName: member.memberName,
            referenceId: member.agentDefinitionId,
            referenceType: "AGENT",
            homeNodeId: "embedded-local",
          })),
        },
      },
    );
    createdTeamDefinitionIds.add(createdTeam.createAgentTeamDefinition.id);

    return {
      teamDefinitionId: createdTeam.createAgentTeamDefinition.id,
      members,
    };
  };

  it("keeps manifest member IDs aligned with runtime projection IDs", async () => {
    const unique = `projection_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const fixture = await createTwoMemberTeamFixture(unique);
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
        teamDefinitionId: fixture.teamDefinitionId,
        targetMemberName: "professor",
        memberConfigs: fixture.members.map((member) => ({
          memberName: member.memberName,
          agentDefinitionId: member.agentDefinitionId,
          llmModelIdentifier: "dummy",
          autoExecuteTools: false,
        })),
      },
    });

    expect(sent.sendMessageToTeam.success).toBe(true);
    const teamId = sent.sendMessageToTeam.teamId;
    createdTeamIds.add(teamId);
    expect(ingressDispatchSpy).toHaveBeenCalledTimes(1);

    const teamManager = AgentTeamInstanceManager.getInstance();
    const runtimeMemberConfigs = teamManager.getTeamMemberConfigs(teamId) as Array<{
      memberName: string;
      memberRouteKey: string;
      memberAgentId: string;
    }>;
    expect(runtimeMemberConfigs).toHaveLength(2);
    expect(runtimeMemberConfigs).toEqual(
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
            memberName: string;
          }>;
        };
      };
    }>(resumeQuery, { teamId });

    const manifestBindings = resumed.getTeamRunResumeConfig.manifest.memberBindings;
    for (const member of runtimeMemberConfigs) {
      const manifestBinding = manifestBindings.find(
        (binding) => binding.memberRouteKey === member.memberRouteKey,
      );
      expect(manifestBinding?.memberAgentId).toBe(member.memberAgentId);
    }

    for (const binding of manifestBindings) {
      createdMemberIds.add(binding.memberAgentId);
      const memberDir = path.join(memoryDir, "agents", binding.memberAgentId);
      fs.mkdirSync(memberDir, { recursive: true });
      fs.writeFileSync(
        path.join(memberDir, "raw_traces.jsonl"),
        [
          JSON.stringify({
            trace_type: "user",
            content: `hello ${binding.memberName}`,
            turn_id: "turn_1",
            seq: 1,
            ts: 1_700_000_000,
          }),
          JSON.stringify({
            trace_type: "assistant",
            content: `hi from ${binding.memberName}`,
            turn_id: "turn_1",
            seq: 2,
            ts: 1_700_000_001,
          }),
        ].join("\n") + "\n",
        "utf-8",
      );
    }

    const projectionQuery = `
      query GetRunProjection($agentId: String!) {
        getRunProjection(agentId: $agentId) {
          agentId
          conversation
        }
      }
    `;
    for (const member of runtimeMemberConfigs) {
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
