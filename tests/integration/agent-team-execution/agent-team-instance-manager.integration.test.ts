import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentConfig, AgentTeamConfig } from "autobyteus-ts";
import { LLMConfig } from "autobyteus-ts/llm/utils/llm-config.js";
import {
  AgentTeamInstanceManager,
  TeamMemberConfigInput,
} from "../../../src/agent-team-execution/services/agent-team-instance-manager.js";
import { AgentTeamDefinition, TeamMember } from "../../../src/agent-team-definition/domain/models.js";
import { NodeType } from "../../../src/agent-team-definition/domain/enums.js";
import { AgentDefinition } from "../../../src/agent-definition/domain/models.js";
import { AgentTeamCreationError, AgentTeamTerminationError } from "../../../src/agent-team-execution/errors.js";

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

const createManager = (overrides: Partial<ConstructorParameters<typeof AgentTeamInstanceManager>[0]> = {}) => {
  const fakeTeam = { teamId: "test_team_123", start: vi.fn() };
  const teamFactory = {
    createTeam: vi.fn().mockReturnValue(fakeTeam),
    removeTeam: vi.fn().mockResolvedValue(true),
    getTeam: vi.fn().mockReturnValue(fakeTeam),
    listActiveTeamIds: vi.fn().mockReturnValue(["test_team_123"]),
  };

  const teamDefinitionService = {
    getDefinitionById: vi.fn(),
  };

  const agentDefinitionService = {
    getAgentDefinitionById: vi.fn(),
  };

  const llmFactory = {
    createLLM: vi.fn().mockResolvedValue({}),
  };

  const workspaceManager = {
    getWorkspaceById: vi.fn().mockReturnValue(null),
  };

  const skillService = {
    getSkill: vi.fn(),
  };

  const promptLoader = {
    getPromptTemplateForAgent: vi.fn().mockResolvedValue(null),
  };

  const waitForIdle = vi.fn().mockResolvedValue(undefined);

  const registries = makeEmptyRegistries();

  const manager = new AgentTeamInstanceManager({
    teamFactory,
    teamDefinitionService: teamDefinitionService as any,
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
    teamFactory,
    teamDefinitionService,
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

describe("AgentTeamInstanceManager integration", () => {
  it("creates a team instance with member configs applied", async () => {
    const { manager, teamDefinitionService, agentDefinitionService, teamFactory, llmFactory } =
      createManager();

    const coordAgentDef = new AgentDefinition({
      id: "1",
      name: "CoordinatorBlueprint",
      role: "Coord",
      description: "...",
    });
    const workerAgentDef = new AgentDefinition({
      id: "2",
      name: "WorkerBlueprint",
      role: "Worker",
      description: "...",
    });

    agentDefinitionService.getAgentDefinitionById.mockImplementation(async (id: string) => {
      if (id === "1") return coordAgentDef;
      if (id === "2") return workerAgentDef;
      return null;
    });

    const teamDef = new AgentTeamDefinition({
      id: "main1",
      name: "MainTeam",
      description: "...",
      nodes: [
        new TeamMember({
          memberName: "TheCoordinator",
          referenceId: "1",
          referenceType: NodeType.AGENT,
        }),
        new TeamMember({
          memberName: "TheWorker",
          referenceId: "2",
          referenceType: NodeType.AGENT,
        }),
      ],
      coordinatorMemberName: "TheCoordinator",
    });

    teamDefinitionService.getDefinitionById.mockResolvedValue(teamDef);

    const memberConfigs: TeamMemberConfigInput[] = [
      {
        memberName: "TheCoordinator",
        agentDefinitionId: "1",
        llmModelIdentifier: "gpt-4o",
        autoExecuteTools: false,
      },
      {
        memberName: "TheWorker",
        agentDefinitionId: "2",
        llmModelIdentifier: "claude-3",
        autoExecuteTools: true,
      },
    ];

    const teamId = await manager.createTeamInstance("main1", memberConfigs);

    expect(teamId).toBe("test_team_123");
    expect(teamFactory.createTeam).toHaveBeenCalledTimes(1);
    const models = llmFactory.createLLM.mock.calls.map((call) => call[0]);
    expect(models).toContain("gpt-4o");
    expect(models).toContain("claude-3");

    const finalConfig = teamFactory.createTeam.mock.calls[0][0] as AgentTeamConfig;
    const coordConfig = finalConfig.coordinatorNode.nodeDefinition;
    const workerNode = finalConfig.nodes.find((node) => node.name === "TheWorker");
    const workerConfig = workerNode?.nodeDefinition;

    expect(coordConfig).toBeInstanceOf(AgentConfig);
    expect((coordConfig as AgentConfig).name).toBe("TheCoordinator");
    expect((coordConfig as AgentConfig).autoExecuteTools).toBe(false);
    expect(workerConfig).toBeInstanceOf(AgentConfig);
    expect((workerConfig as AgentConfig).name).toBe("TheWorker");
    expect((workerConfig as AgentConfig).autoExecuteTools).toBe(true);
  });

  it("throws when member config is missing", async () => {
    const { manager, teamDefinitionService, agentDefinitionService } = createManager();

    const teamDef = new AgentTeamDefinition({
      id: "main1",
      name: "MainTeam",
      description: "...",
      nodes: [
        new TeamMember({
          memberName: "AgentOne",
          referenceId: "1",
          referenceType: NodeType.AGENT,
        }),
      ],
      coordinatorMemberName: "AgentOne",
    });

    teamDefinitionService.getDefinitionById.mockResolvedValue(teamDef);
    agentDefinitionService.getAgentDefinitionById.mockResolvedValue(
      new AgentDefinition({
        id: "1",
        name: "A",
        role: "B",
        description: "C",
      }),
    );

    await expect(manager.createTeamInstance("main1", [])).rejects.toThrow(
      AgentTeamCreationError,
    );
  });

  it("detects circular dependencies between team definitions", async () => {
    const { manager, teamDefinitionService } = createManager();

    const teamA = new AgentTeamDefinition({
      id: "A",
      name: "TeamA",
      description: "...",
      nodes: [
        new TeamMember({
          memberName: "SubTeamB",
          referenceId: "B",
          referenceType: NodeType.AGENT_TEAM,
        }),
      ],
      coordinatorMemberName: "SubTeamB",
    });

    const teamB = new AgentTeamDefinition({
      id: "B",
      name: "TeamB",
      description: "...",
      nodes: [
        new TeamMember({
          memberName: "SubTeamA",
          referenceId: "A",
          referenceType: NodeType.AGENT_TEAM,
        }),
      ],
      coordinatorMemberName: "SubTeamA",
    });

    teamDefinitionService.getDefinitionById.mockImplementation(async (id: string) => {
      if (id === "A") return teamA;
      if (id === "B") return teamB;
      return null;
    });

    await expect(manager.createTeamInstance("A", [])).rejects.toThrow(
      AgentTeamCreationError,
    );
  });

  it("throws if coordinator is a team instead of an agent", async () => {
    const { manager, teamDefinitionService, agentDefinitionService } = createManager();

    const subCoordAgentDef = new AgentDefinition({
      id: "sub_agent_1",
      name: "SubCoordinator",
      role: "Sub",
      description: "...",
    });

    const subTeamDef = new AgentTeamDefinition({
      id: "sub1",
      name: "SubTeam",
      description: "...",
      nodes: [
        new TeamMember({
          memberName: "SubCoordinator",
          referenceId: "sub_agent_1",
          referenceType: NodeType.AGENT,
        }),
      ],
      coordinatorMemberName: "SubCoordinator",
    });

    const mainTeamDef = new AgentTeamDefinition({
      id: "main1",
      name: "MainTeam",
      description: "...",
      nodes: [
        new TeamMember({
          memberName: "MySubTeam",
          referenceId: "sub1",
          referenceType: NodeType.AGENT_TEAM,
        }),
      ],
      coordinatorMemberName: "MySubTeam",
    });

    teamDefinitionService.getDefinitionById.mockImplementation(async (id: string) => {
      if (id === "main1") return mainTeamDef;
      if (id === "sub1") return subTeamDef;
      return null;
    });
    agentDefinitionService.getAgentDefinitionById.mockResolvedValue(subCoordAgentDef);

    const memberConfigs: TeamMemberConfigInput[] = [
      {
        memberName: "SubCoordinator",
        agentDefinitionId: "sub_agent_1",
        llmModelIdentifier: "gpt-3.5",
        autoExecuteTools: true,
      },
    ];

    await expect(manager.createTeamInstance("main1", memberConfigs)).rejects.toThrow(
      AgentTeamCreationError,
    );
  });

  it("terminates team instances and propagates failures", async () => {
    const { manager, teamFactory } = createManager();

    const success = await manager.terminateTeamInstance("test_team_123");
    expect(success).toBe(true);
    expect(teamFactory.removeTeam).toHaveBeenCalledWith("test_team_123");

    teamFactory.removeTeam.mockRejectedValueOnce(new Error("Factory failed"));
    await expect(manager.terminateTeamInstance("bad_id")).rejects.toThrow(
      AgentTeamTerminationError,
    );
  });

  it("retrieves team instance and lists active IDs", () => {
    const { manager, teamFactory } = createManager();

    const team = manager.getTeamInstance("test_team_123");
    expect(teamFactory.getTeam).toHaveBeenCalledWith("test_team_123");
    expect(team?.teamId).toBe("test_team_123");

    const ids = manager.listActiveInstances();
    expect(teamFactory.listActiveTeamIds).toHaveBeenCalledTimes(1);
    expect(ids).toEqual(["test_team_123"]);
  });

  it("passes llmConfig into createLLM for team members", async () => {
    const { manager, teamDefinitionService, agentDefinitionService, llmFactory } = createManager();

    agentDefinitionService.getAgentDefinitionById.mockResolvedValue(
      new AgentDefinition({
        id: "1",
        name: "TestAgent",
        role: "Worker",
        description: "...",
      }),
    );

    const teamDef = new AgentTeamDefinition({
      id: "main1",
      name: "MainTeam",
      description: "...",
      nodes: [
        new TeamMember({
          memberName: "TheAgent",
          referenceId: "1",
          referenceType: NodeType.AGENT,
        }),
      ],
      coordinatorMemberName: "TheAgent",
    });

    teamDefinitionService.getDefinitionById.mockResolvedValue(teamDef);

    const memberConfigs: TeamMemberConfigInput[] = [
      {
        memberName: "TheAgent",
        agentDefinitionId: "1",
        llmModelIdentifier: "gemini-3-flash-preview",
        autoExecuteTools: true,
        llmConfig: { thinking_level: "high" },
      },
    ];

    const teamId = await manager.createTeamInstance("main1", memberConfigs);
    expect(teamId).toBe("test_team_123");
    expect(llmFactory.createLLM).toHaveBeenCalledTimes(1);
    const [, passedConfig] = llmFactory.createLLM.mock.calls[0];
    expect(passedConfig).toBeInstanceOf(LLMConfig);
    expect((passedConfig as LLMConfig).extraParams).toEqual({ thinking_level: "high" });
  });

  it("stores and returns member config snapshots by team definition id", async () => {
    const { manager, teamDefinitionService, agentDefinitionService } = createManager();

    agentDefinitionService.getAgentDefinitionById.mockResolvedValue(
      new AgentDefinition({
        id: "1",
        name: "SnapshotAgent",
        role: "Worker",
        description: "...",
      }),
    );

    const teamDef = new AgentTeamDefinition({
      id: "main1",
      name: "MainTeam",
      description: "...",
      nodes: [
        new TeamMember({
          memberName: "SnapshotMember",
          referenceId: "1",
          referenceType: NodeType.AGENT,
        }),
      ],
      coordinatorMemberName: "SnapshotMember",
    });
    teamDefinitionService.getDefinitionById.mockResolvedValue(teamDef);

    const memberConfigs: TeamMemberConfigInput[] = [
      {
        memberName: "SnapshotMember",
        agentDefinitionId: "1",
        llmModelIdentifier: "gpt-4o-mini",
        autoExecuteTools: true,
        llmConfig: { temperature: 0.2 },
      },
    ];

    await manager.createTeamInstance("main1", memberConfigs);
    const snapshot = manager.getTeamMemberConfigsByDefinitionId("main1");

    expect(snapshot).toEqual([
      {
        ...memberConfigs[0],
        workspaceId: null,
      },
    ]);
    expect(snapshot).not.toBe(memberConfigs);
    expect(snapshot[0]).not.toBe(memberConfigs[0]);
  });

  it("clears member config snapshot when mapped team instance is terminated", async () => {
    const { manager, teamDefinitionService, agentDefinitionService } = createManager();

    agentDefinitionService.getAgentDefinitionById.mockResolvedValue(
      new AgentDefinition({
        id: "1",
        name: "CleanupAgent",
        role: "Worker",
        description: "...",
      }),
    );

    const teamDef = new AgentTeamDefinition({
      id: "main1",
      name: "MainTeam",
      description: "...",
      nodes: [
        new TeamMember({
          memberName: "CleanupMember",
          referenceId: "1",
          referenceType: NodeType.AGENT,
        }),
      ],
      coordinatorMemberName: "CleanupMember",
    });
    teamDefinitionService.getDefinitionById.mockResolvedValue(teamDef);

    await manager.createTeamInstance("main1", [
      {
        memberName: "CleanupMember",
        agentDefinitionId: "1",
        llmModelIdentifier: "gpt-4o-mini",
        autoExecuteTools: true,
      },
    ]);
    expect(manager.getTeamMemberConfigsByDefinitionId("main1")).toHaveLength(1);

    await manager.terminateTeamInstance("test_team_123");
    expect(manager.getTeamMemberConfigsByDefinitionId("main1")).toEqual([]);
  });
});
