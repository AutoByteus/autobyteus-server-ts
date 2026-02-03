import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentInstanceManager } from "../../../src/agent-execution/services/agent-instance-manager.js";
import { AgentDefinition } from "../../../src/agent-definition/domain/models.js";
import { LLMConfig } from "autobyteus-ts/llm/utils/llm-config.js";

type ProcessorRegistry<T> = {
  getProcessor: (name: string) => T | undefined;
  getOrderedProcessorOptions: () => Array<{ name: string; isMandatory: boolean }>;
};

type PreprocessorRegistry<T> = {
  getPreprocessor: (name: string) => T | undefined;
  getOrderedProcessorOptions: () => Array<{ name: string; isMandatory: boolean }>;
};

const makeEmptyRegistries = () => ({
  input: {
    getProcessor: vi.fn(),
    getOrderedProcessorOptions: () => [],
  } as ProcessorRegistry<unknown>,
  llmResponse: {
    getProcessor: vi.fn(),
    getOrderedProcessorOptions: () => [],
  } as ProcessorRegistry<unknown>,
  systemPrompt: {
    getProcessor: vi.fn(),
    getOrderedProcessorOptions: () => [],
  } as ProcessorRegistry<unknown>,
  toolExecutionResult: {
    getProcessor: vi.fn(),
    getOrderedProcessorOptions: () => [],
  } as ProcessorRegistry<unknown>,
  toolInvocationPreprocessor: {
    getPreprocessor: vi.fn(),
    getOrderedProcessorOptions: () => [],
  } as PreprocessorRegistry<unknown>,
  lifecycle: {
    getProcessor: vi.fn(),
    getOrderedProcessorOptions: () => [],
  } as ProcessorRegistry<unknown>,
});

const createManager = (overrides: Partial<ConstructorParameters<typeof AgentInstanceManager>[0]> = {}) => {
  const fakeAgent = { agentId: "agent_123", start: vi.fn() };
  const agentFactory = {
    createAgent: vi.fn().mockReturnValue(fakeAgent),
    getAgent: vi.fn().mockReturnValue(fakeAgent),
    removeAgent: vi.fn().mockResolvedValue(true),
    listActiveAgentIds: vi.fn().mockReturnValue(["agent_123"]),
  };

  const agentDefinitionService = {
    getAgentDefinitionById: vi.fn(),
  };

  const llmFactory = {
    createLLM: vi.fn().mockResolvedValue({}),
  };

  const workspaceManager = {
    getWorkspaceById: vi.fn().mockReturnValue(null),
    getOrCreateTempWorkspace: vi.fn().mockResolvedValue({
      workspaceId: "temp_ws",
      name: "Temp Workspace",
    }),
  };

  const skillService = {
    getSkill: vi.fn(),
  };

  const promptLoader = {
    getPromptTemplateForAgent: vi.fn().mockResolvedValue(null),
  };

  const waitForIdle = vi.fn().mockResolvedValue(undefined);

  const registries = makeEmptyRegistries();

  const manager = new AgentInstanceManager({
    agentFactory,
    agentDefinitionService: agentDefinitionService as any,
    llmFactory: llmFactory as any,
    workspaceManager: workspaceManager as any,
    skillService: skillService as any,
    promptLoader: promptLoader as any,
    registries,
    waitForIdle,
    ...overrides,
  });

  return {
    manager,
    agentFactory,
    agentDefinitionService,
    llmFactory,
    workspaceManager,
    skillService,
    promptLoader,
    waitForIdle,
  };
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("AgentInstanceManager integration", () => {
  it("resolves skill names to paths via SkillService", async () => {
    const { manager, agentDefinitionService, skillService, agentFactory } = createManager();
    const agentDef = new AgentDefinition({
      id: "def_1",
      name: "SkillfulAgent",
      role: "Worker",
      description: "A skilled worker",
      skillNames: ["coding_skill", "testing_skill"],
    });

    agentDefinitionService.getAgentDefinitionById.mockResolvedValue(agentDef);
    skillService.getSkill.mockImplementation((name: string) => {
      if (name === "coding_skill") {
        return { rootPath: "/path/to/coding_skill" };
      }
      if (name === "testing_skill") {
        return { rootPath: "/path/to/testing_skill" };
      }
      return null;
    });

    const createdId = await manager.createAgentInstance({
      agentDefinitionId: "def_1",
      llmModelIdentifier: "gpt-4",
      autoExecuteTools: true,
    });

    expect(createdId).toBe("agent_123");
    expect(agentFactory.createAgent).toHaveBeenCalledTimes(1);
    const config = agentFactory.createAgent.mock.calls[0][0] as { skills: string[] };
    expect(config.skills).toContain("/path/to/coding_skill");
    expect(config.skills).toContain("/path/to/testing_skill");
    expect(config.skills).toHaveLength(2);
  });

  it("falls back to temp workspace when none is provided", async () => {
    const { manager, agentDefinitionService, workspaceManager, agentFactory } = createManager();
    const agentDef = new AgentDefinition({
      id: "def_1",
      name: "TempWorkspaceAgent",
      role: "Worker",
      description: "An agent without explicit workspace",
    });

    agentDefinitionService.getAgentDefinitionById.mockResolvedValue(agentDef);

    const createdId = await manager.createAgentInstance({
      agentDefinitionId: "def_1",
      llmModelIdentifier: "gpt-4",
      autoExecuteTools: true,
      workspaceId: null,
    });

    expect(createdId).toBe("agent_123");
    expect(workspaceManager.getOrCreateTempWorkspace).toHaveBeenCalledTimes(1);
    const config = agentFactory.createAgent.mock.calls[0][0] as { workspace: unknown };
    expect(config.workspace).toEqual({ workspaceId: "temp_ws", name: "Temp Workspace" });
  });

  it("passes llmConfig into createLLM when provided", async () => {
    const { manager, agentDefinitionService, llmFactory } = createManager();
    const agentDef = new AgentDefinition({
      id: "def_1",
      name: "ConfiguredAgent",
      role: "Worker",
      description: "An agent with LLM config",
    });

    agentDefinitionService.getAgentDefinitionById.mockResolvedValue(agentDef);

    const createdId = await manager.createAgentInstance({
      agentDefinitionId: "def_1",
      llmModelIdentifier: "gemini-3-flash-preview",
      autoExecuteTools: true,
      llmConfig: { thinking_level: "high" },
    });

    expect(createdId).toBe("agent_123");
    expect(llmFactory.createLLM).toHaveBeenCalledTimes(1);
    const [, passedConfig] = llmFactory.createLLM.mock.calls[0];
    expect(passedConfig).toBeInstanceOf(LLMConfig);
    expect((passedConfig as LLMConfig).extraParams).toEqual({ thinking_level: "high" });
  });

  it("calls createLLM with undefined config when llmConfig is not provided", async () => {
    const { manager, agentDefinitionService, llmFactory } = createManager();
    const agentDef = new AgentDefinition({
      id: "def_1",
      name: "DefaultAgent",
      role: "Worker",
      description: "An agent without LLM config",
    });

    agentDefinitionService.getAgentDefinitionById.mockResolvedValue(agentDef);

    const createdId = await manager.createAgentInstance({
      agentDefinitionId: "def_1",
      llmModelIdentifier: "gpt-4",
      autoExecuteTools: true,
    });

    expect(createdId).toBe("agent_123");
    expect(llmFactory.createLLM).toHaveBeenCalledWith("gpt-4", undefined);
  });
});
