import {
  AgentConfig,
  AgentTeamConfig,
  AgentTeamEventStream,
  BaseAgentUserInputMessageProcessor,
  BaseLLMResponseProcessor,
  BaseLifecycleEventProcessor,
  BaseSystemPromptProcessor,
  BaseToolExecutionResultProcessor,
  BaseToolInvocationPreprocessor,
  TeamNodeConfig,
  defaultAgentTeamFactory,
  defaultInputProcessorRegistry,
  defaultLlmResponseProcessorRegistry,
  defaultLifecycleEventProcessorRegistry,
  defaultSystemPromptProcessorRegistry,
  defaultToolExecutionResultProcessorRegistry,
  defaultToolInvocationPreprocessorRegistry,
  LLMFactory,
} from "autobyteus-ts";
import { waitForTeamToBeIdle } from "autobyteus-ts/agent-team/utils/wait-for-idle.js";
import { defaultToolRegistry } from "autobyteus-ts/tools/registry/tool-registry.js";
import { LLMConfig } from "autobyteus-ts/llm/utils/llm-config.js";
import { AgentDefinitionService } from "../../agent-definition/services/agent-definition-service.js";
import { mergeMandatoryAndOptional } from "../../agent-definition/utils/processor-defaults.js";
import { NodeType } from "../../agent-team-definition/domain/enums.js";
import { AgentTeamDefinitionService } from "../../agent-team-definition/services/agent-team-definition-service.js";
import { PromptLoader, getPromptLoader } from "../../prompt-engineering/utils/prompt-loader.js";
import { SkillService } from "../../skills/services/skill-service.js";
import { WorkspaceManager, getWorkspaceManager } from "../../workspaces/workspace-manager.js";
import { AgentTeamCreationError, AgentTeamTerminationError } from "../errors.js";
import { normalizeMemberRouteKey } from "../../run-history/utils/team-member-agent-id.js";

const logger = {
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};

const EMBEDDED_LOCAL_NODE_ID = "embedded-local";

const normalizeOptionalString = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const isMemberLocalToNode = (memberHomeNodeId: string | null | undefined): boolean => {
  const normalizedHomeNodeId = normalizeOptionalString(memberHomeNodeId);
  if (!normalizedHomeNodeId || normalizedHomeNodeId === EMBEDDED_LOCAL_NODE_ID) {
    return true;
  }
  const localNodeId = normalizeOptionalString(process.env.AUTOBYTEUS_NODE_ID);
  return !!localNodeId && normalizedHomeNodeId === localNodeId;
};

const cloneMemberConfigInput = (config: TeamMemberConfigInput): TeamMemberConfigInput => {
  const cloned: TeamMemberConfigInput = {
    memberName: config.memberName,
    agentDefinitionId: config.agentDefinitionId,
    llmModelIdentifier: config.llmModelIdentifier,
    autoExecuteTools: config.autoExecuteTools,
    workspaceId: config.workspaceId ?? null,
    workspaceRootPath: config.workspaceRootPath ?? null,
    llmConfig: config.llmConfig ? { ...config.llmConfig } : null,
  };
  if (typeof config.memberRouteKey === "string") {
    cloned.memberRouteKey = config.memberRouteKey;
  }
  if (typeof config.memberAgentId === "string") {
    cloned.memberAgentId = config.memberAgentId;
  }
  if (typeof config.memoryDir === "string") {
    cloned.memoryDir = config.memoryDir;
  }
  return cloned;
};

type TeamFactoryLike = typeof defaultAgentTeamFactory;
type LlmFactoryLike = typeof LLMFactory;

type ProcessorOption = { name: string; isMandatory: boolean };

type ProcessorRegistry<T> = {
  getProcessor: (name: string) => T | undefined;
  getOrderedProcessorOptions: () => ProcessorOption[];
};

type PreprocessorRegistry<T> = {
  getPreprocessor: (name: string) => T | undefined;
  getOrderedProcessorOptions: () => ProcessorOption[];
};

type ProcessorRegistries = {
  input: ProcessorRegistry<BaseAgentUserInputMessageProcessor>;
  llmResponse: ProcessorRegistry<BaseLLMResponseProcessor>;
  systemPrompt: ProcessorRegistry<BaseSystemPromptProcessor>;
  toolExecutionResult: ProcessorRegistry<BaseToolExecutionResultProcessor>;
  toolInvocationPreprocessor: PreprocessorRegistry<BaseToolInvocationPreprocessor>;
  lifecycle: ProcessorRegistry<BaseLifecycleEventProcessor>;
};

type TeamLike = {
  teamId: string;
  notifier?: unknown;
};

export type TeamMemberConfigInput = {
  memberName: string;
  agentDefinitionId: string;
  llmModelIdentifier: string;
  autoExecuteTools: boolean;
  workspaceId?: string | null;
  workspaceRootPath?: string | null;
  llmConfig?: Record<string, unknown> | null;
  memberRouteKey?: string | null;
  memberAgentId?: string | null;
  memoryDir?: string | null;
};

type AgentTeamInstanceManagerOptions = {
  teamFactory?: TeamFactoryLike;
  teamDefinitionService?: AgentTeamDefinitionService;
  agentDefinitionService?: AgentDefinitionService;
  llmFactory?: LlmFactoryLike;
  workspaceManager?: WorkspaceManager;
  skillService?: SkillService;
  promptLoader?: PromptLoader;
  registries?: Partial<ProcessorRegistries>;
  waitForIdle?: (team: TeamLike, timeout?: number) => Promise<void>;
};

export class AgentTeamInstanceManager {
  private static instance: AgentTeamInstanceManager | null = null;
  private readonly teamDefinitionIdByTeamId = new Map<string, string>();
  private readonly teamIdByTeamDefinitionId = new Map<string, string>();
  private readonly memberConfigsByTeamDefinitionId = new Map<string, TeamMemberConfigInput[]>();
  private readonly memberConfigsByTeamId = new Map<string, TeamMemberConfigInput[]>();
  private readonly memberNamesByTeamId = new Map<string, string[]>();
  private teamFactory: TeamFactoryLike;
  private teamDefinitionService: AgentTeamDefinitionService;
  private agentDefinitionService: AgentDefinitionService;
  private llmFactory: LlmFactoryLike;
  private workspaceManager: WorkspaceManager;
  private skillService: SkillService;
  private promptLoader: PromptLoader;
  private registries: ProcessorRegistries;
  private waitForIdle: (team: TeamLike, timeout?: number) => Promise<void>;

  static getInstance(options: AgentTeamInstanceManagerOptions = {}): AgentTeamInstanceManager {
    if (!AgentTeamInstanceManager.instance) {
      AgentTeamInstanceManager.instance = new AgentTeamInstanceManager(options);
    }
    return AgentTeamInstanceManager.instance;
  }

  constructor(options: AgentTeamInstanceManagerOptions = {}) {
    this.teamFactory = options.teamFactory ?? defaultAgentTeamFactory;
    this.teamDefinitionService =
      options.teamDefinitionService ?? AgentTeamDefinitionService.getInstance();
    this.agentDefinitionService =
      options.agentDefinitionService ?? AgentDefinitionService.getInstance();
    this.llmFactory = options.llmFactory ?? LLMFactory;
    this.workspaceManager = options.workspaceManager ?? getWorkspaceManager();
    this.skillService = options.skillService ?? SkillService.getInstance();
    this.promptLoader = options.promptLoader ?? getPromptLoader();
    this.registries = {
      input: options.registries?.input ?? defaultInputProcessorRegistry,
      llmResponse: options.registries?.llmResponse ?? defaultLlmResponseProcessorRegistry,
      systemPrompt: options.registries?.systemPrompt ?? defaultSystemPromptProcessorRegistry,
      toolExecutionResult:
        options.registries?.toolExecutionResult ??
        defaultToolExecutionResultProcessorRegistry,
      toolInvocationPreprocessor:
        options.registries?.toolInvocationPreprocessor ??
        defaultToolInvocationPreprocessorRegistry,
      lifecycle: options.registries?.lifecycle ?? defaultLifecycleEventProcessorRegistry,
    };
    this.waitForIdle = options.waitForIdle ?? waitForTeamToBeIdle;
    logger.info("AgentTeamInstanceManager initialized.");
  }

  async createTeamInstance(
    teamDefinitionId: string,
    memberConfigs: TeamMemberConfigInput[],
  ): Promise<string> {
    return this.createTeamInstanceInternal({
      teamDefinitionId,
      memberConfigs,
      preferredTeamId: null,
    });
  }

  async createTeamInstanceWithId(
    teamId: string,
    teamDefinitionId: string,
    memberConfigs: TeamMemberConfigInput[],
  ): Promise<string> {
    return this.createTeamInstanceInternal({
      teamDefinitionId,
      memberConfigs,
      preferredTeamId: teamId,
    });
  }

  private async createTeamInstanceInternal(input: {
    teamDefinitionId: string;
    memberConfigs: TeamMemberConfigInput[];
    preferredTeamId: string | null;
  }): Promise<string> {
    logger.info(
      `Attempting to create agent team instance from definition ID: ${input.teamDefinitionId}`,
    );

    try {
      const memberConfigSnapshots = input.memberConfigs.map((config) => cloneMemberConfigInput(config));
      const memberConfigsMap: Record<string, TeamMemberConfigInput> = {};
      for (const config of memberConfigSnapshots) {
        memberConfigsMap[config.memberName] = config;
        if (typeof config.memberRouteKey === "string" && config.memberRouteKey.trim()) {
          const normalizedRouteKey = normalizeMemberRouteKey(config.memberRouteKey);
          memberConfigsMap[normalizedRouteKey] = config;
        }
      }

      const teamConfig = await this.buildTeamConfigFromDefinition(
        input.teamDefinitionId,
        memberConfigsMap,
        new Set(),
      );

      const createTeamWithId = (this.teamFactory as any).createTeamWithId;
      const team =
        input.preferredTeamId && typeof createTeamWithId === "function"
          ? (createTeamWithId.call(this.teamFactory, input.preferredTeamId, teamConfig) as TeamLike & {
              start?: () => void;
            })
          : (this.teamFactory.createTeam(teamConfig) as TeamLike & {
              start?: () => void;
            });
      const teamMemberNames = teamConfig.nodes.map((node) => node.name);
      this.teamDefinitionIdByTeamId.set(team.teamId, input.teamDefinitionId);
      this.teamIdByTeamDefinitionId.set(input.teamDefinitionId, team.teamId);
      this.memberConfigsByTeamDefinitionId.set(input.teamDefinitionId, memberConfigSnapshots);
      this.memberConfigsByTeamId.set(team.teamId, memberConfigSnapshots);
      this.memberNamesByTeamId.set(team.teamId, teamMemberNames);
      team.start?.();
      await this.waitForIdle(team, 120.0);

      logger.info(
        `Successfully created and started agent team '${teamConfig.name}' with ID: ${team.teamId}`,
      );
      return team.teamId;
    } catch (error) {
      logger.error(
        `Failed to create agent team from definition ID '${input.teamDefinitionId}': ${String(error)}`,
      );
      if (error instanceof AgentTeamCreationError) {
        throw error;
      }
      throw new AgentTeamCreationError(`Failed to create agent team: ${String(error)}`);
    }
  }

  private async buildAgentConfigFromDefinition(
    memberName: string,
    agentDefinitionId: string,
    memberConfig: TeamMemberConfigInput,
    memberRouteKey: string,
    memberHomeNodeId: string | null | undefined,
  ): Promise<AgentConfig> {
    const agentDef = await this.agentDefinitionService.getAgentDefinitionById(agentDefinitionId);
    if (!agentDef) {
      throw new Error(`AgentDefinition with ID ${agentDefinitionId} not found.`);
    }

    const systemPrompt = await this.promptLoader.getPromptTemplateForAgent(
      agentDefinitionId,
      memberConfig.llmModelIdentifier,
    );
    const resolvedPrompt = systemPrompt ?? agentDef.description;

    const tools = [];
    if (agentDef.toolNames?.length) {
      for (const name of agentDef.toolNames) {
        if (!defaultToolRegistry.getToolDefinition(name)) {
          logger.warn(
            `Tool '${name}' defined in agent definition '${agentDef.name}' not found in registry. Skipping.`,
          );
          continue;
        }
        try {
          tools.push(defaultToolRegistry.createTool(name));
        } catch (error) {
          logger.error(
            `Failed to create tool instance for '${name}' from agent definition '${agentDef.name}': ${String(error)}`,
          );
        }
      }
    }

    const inputProcessors: BaseAgentUserInputMessageProcessor[] = [];
    for (const name of mergeMandatoryAndOptional(agentDef.inputProcessorNames, this.registries.input)) {
      const processor = this.registries.input.getProcessor(name);
      if (processor) {
        inputProcessors.push(processor);
      } else {
        logger.warn(
          `Input processor '${name}' defined in agent definition '${agentDef.name}' not found in registry. Skipping.`,
        );
      }
    }

    const llmResponseProcessors: BaseLLMResponseProcessor[] = [];
    for (const name of mergeMandatoryAndOptional(
      agentDef.llmResponseProcessorNames,
      this.registries.llmResponse,
    )) {
      const processor = this.registries.llmResponse.getProcessor(name);
      if (processor) {
        llmResponseProcessors.push(processor);
      } else {
        logger.warn(
          `LLM response processor '${name}' defined in agent definition '${agentDef.name}' not found in registry. Skipping.`,
        );
      }
    }

    const systemPromptProcessors: BaseSystemPromptProcessor[] = [];
    for (const name of mergeMandatoryAndOptional(
      agentDef.systemPromptProcessorNames,
      this.registries.systemPrompt,
    )) {
      const processor = this.registries.systemPrompt.getProcessor(name);
      if (processor) {
        systemPromptProcessors.push(processor);
      } else {
        logger.warn(
          `System prompt processor '${name}' defined in agent definition '${agentDef.name}' not found in registry. Skipping.`,
        );
      }
    }

    const toolExecutionResultProcessors: BaseToolExecutionResultProcessor[] = [];
    for (const name of mergeMandatoryAndOptional(
      agentDef.toolExecutionResultProcessorNames,
      this.registries.toolExecutionResult,
    )) {
      const processor = this.registries.toolExecutionResult.getProcessor(name);
      if (processor) {
        toolExecutionResultProcessors.push(processor);
      } else {
        logger.warn(
          `Tool result processor '${name}' defined in agent definition '${agentDef.name}' not found in registry. Skipping.`,
        );
      }
    }

    const toolInvocationPreprocessors: BaseToolInvocationPreprocessor[] = [];
    for (const name of mergeMandatoryAndOptional(
      agentDef.toolInvocationPreprocessorNames,
      this.registries.toolInvocationPreprocessor,
    )) {
      const processor = this.registries.toolInvocationPreprocessor.getPreprocessor(name);
      if (processor) {
        toolInvocationPreprocessors.push(processor);
      } else {
        logger.warn(
          `Tool invocation preprocessor '${name}' defined in agent definition '${agentDef.name}' not found in registry. Skipping.`,
        );
      }
    }

    const lifecycleProcessors: BaseLifecycleEventProcessor[] = [];
    for (const name of mergeMandatoryAndOptional(
      agentDef.lifecycleProcessorNames,
      this.registries.lifecycle,
    )) {
      const processor = this.registries.lifecycle.getProcessor(name);
      if (processor) {
        lifecycleProcessors.push(processor);
      } else {
        logger.warn(
          `Lifecycle processor '${name}' defined in agent definition '${agentDef.name}' not found in registry. Skipping.`,
        );
      }
    }

    const workspaceId = normalizeOptionalString(memberConfig.workspaceId);
    const workspaceRootPath = normalizeOptionalString(memberConfig.workspaceRootPath);
    let workspaceInstance = workspaceId ? this.workspaceManager.getWorkspaceById(workspaceId) : undefined;
    if (!workspaceInstance && !workspaceId && workspaceRootPath && isMemberLocalToNode(memberHomeNodeId)) {
      workspaceInstance = await this.workspaceManager.ensureWorkspaceByRootPath(workspaceRootPath);
    }
    if (!workspaceInstance && workspaceId) {
      logger.warn(
        `Workspace '${workspaceId}' not found for member '${memberName}'. Proceeding without workspace binding.`,
      );
    }

    const skillPaths: string[] = [];
    if (agentDef.skillNames?.length) {
      for (const skillName of agentDef.skillNames) {
        const skill = this.skillService.getSkill(skillName);
        if (skill) {
          skillPaths.push(skill.rootPath);
          logger.info(
            `Resolved skill '${skillName}' to path: ${skill.rootPath} for team member '${memberName}'`,
          );
        } else {
          logger.warn(
            `Skill '${skillName}' defined in agent definition '${agentDef.name}' not found via SkillService. Skipping.`,
          );
        }
      }
    }

    const config = memberConfig.llmConfig
      ? new LLMConfig({ extraParams: memberConfig.llmConfig })
      : undefined;
    const llmInstance = await this.llmFactory.createLLM(
      memberConfig.llmModelIdentifier,
      config,
    );

    const initialCustomData: Record<string, unknown> = {
      agent_definition_id: agentDefinitionId,
      is_first_user_turn: true,
    };

    const normalizedRouteKey = normalizeMemberRouteKey(
      memberConfig.memberRouteKey ?? memberRouteKey,
    );
    const memberAgentId =
      typeof memberConfig.memberAgentId === "string" && memberConfig.memberAgentId.trim().length > 0
        ? memberConfig.memberAgentId.trim()
        : null;
    const memoryDir =
      typeof memberConfig.memoryDir === "string" && memberConfig.memoryDir.trim().length > 0
        ? memberConfig.memoryDir.trim()
        : null;

    if (memberAgentId) {
      initialCustomData.teamMemberIdentity = {
        memberRouteKey: normalizedRouteKey,
        memberAgentId,
      };

      if (memoryDir) {
        initialCustomData.teamRestore = {
          [memberName]: {
            memberAgentId,
            memoryDir,
          },
        };
      }
    }

    return new AgentConfig(
      memberName,
      agentDef.role,
      agentDef.description,
      llmInstance,
      resolvedPrompt,
      tools,
      memberConfig.autoExecuteTools,
      inputProcessors,
      llmResponseProcessors,
      systemPromptProcessors,
      toolExecutionResultProcessors,
      toolInvocationPreprocessors,
      workspaceInstance ?? null,
      lifecycleProcessors,
      initialCustomData,
      skillPaths,
    );
  }

  private async buildTeamConfigFromDefinition(
    teamDefinitionId: string,
    memberConfigsMap: Record<string, TeamMemberConfigInput>,
    visited: Set<string>,
    routePrefix: string = "",
  ): Promise<AgentTeamConfig> {
    if (visited.has(teamDefinitionId)) {
      throw new AgentTeamCreationError(
        `Circular dependency detected in team definitions involving ID: ${teamDefinitionId}`,
      );
    }
    visited.add(teamDefinitionId);

    const teamDef = await this.teamDefinitionService.getDefinitionById(teamDefinitionId);
    if (!teamDef) {
      throw new Error(`AgentTeamDefinition with ID ${teamDefinitionId} not found.`);
    }

    const hydratedConfigs: Record<string, AgentConfig | AgentTeamConfig> = {};
    for (const member of teamDef.nodes) {
      const memberRouteKey = routePrefix
        ? normalizeMemberRouteKey(`${routePrefix}/${member.memberName}`)
        : normalizeMemberRouteKey(member.memberName);
      if (member.referenceType === NodeType.AGENT) {
        const memberConfig = memberConfigsMap[memberRouteKey] ?? memberConfigsMap[member.memberName];
        if (!memberConfig) {
          throw new AgentTeamCreationError(
            `Configuration for team member '${member.memberName}' was not provided.`,
          );
        }
        const normalizedHomeNodeId = normalizeOptionalString(member.homeNodeId);
        const requiresLocalWorkspacePath =
          normalizedHomeNodeId !== null &&
          normalizedHomeNodeId !== EMBEDDED_LOCAL_NODE_ID &&
          isMemberLocalToNode(member.homeNodeId) &&
          !normalizeOptionalString(memberConfig.workspaceId);
        if (requiresLocalWorkspacePath && !normalizeOptionalString(memberConfig.workspaceRootPath)) {
          throw new AgentTeamCreationError(
            `Remote member '${member.memberName}' requires workspaceRootPath on node '${normalizeOptionalString(process.env.AUTOBYTEUS_NODE_ID) ?? "local"}'.`,
          );
        }
        hydratedConfigs[member.memberName] = await this.buildAgentConfigFromDefinition(
          member.memberName,
          member.referenceId,
          memberConfig,
          memberRouteKey,
          member.homeNodeId,
        );
      } else if (member.referenceType === NodeType.AGENT_TEAM) {
        hydratedConfigs[member.memberName] = await this.buildTeamConfigFromDefinition(
          member.referenceId,
          memberConfigsMap,
          new Set(visited),
          memberRouteKey,
        );
      }
    }

    const teamNodeMap = new Map<string, TeamNodeConfig>();
    for (const [memberName, config] of Object.entries(hydratedConfigs)) {
      teamNodeMap.set(memberName, new TeamNodeConfig({ nodeDefinition: config }));
    }

    const coordinatorNode = teamNodeMap.get(teamDef.coordinatorMemberName);
    if (!coordinatorNode) {
      throw new Error(
        `Coordinator member name '${teamDef.coordinatorMemberName}' not found in team '${teamDef.name}'.`,
      );
    }
    if (!(coordinatorNode.nodeDefinition instanceof AgentConfig)) {
      throw new TypeError(
        `The designated coordinator '${coordinatorNode.name}' must be an AGENT, but is a TEAM.`,
      );
    }

    return new AgentTeamConfig({
      name: teamDef.name,
      description: teamDef.description,
      role: teamDef.role ?? null,
      nodes: Array.from(teamNodeMap.values()),
      coordinatorNode,
    });
  }

  getTeamInstance(teamId: string): TeamLike | null {
    return (this.teamFactory.getTeam(teamId) as TeamLike | undefined) ?? null;
  }

  listActiveInstances(): string[] {
    return this.teamFactory.listActiveTeamIds();
  }

  async terminateTeamInstance(teamId: string): Promise<boolean> {
    try {
      const removed = await this.teamFactory.removeTeam(teamId);
      if (removed) {
        const definitionId = this.teamDefinitionIdByTeamId.get(teamId) ?? null;
        this.teamDefinitionIdByTeamId.delete(teamId);
        this.memberConfigsByTeamId.delete(teamId);
        this.memberNamesByTeamId.delete(teamId);
        if (definitionId && this.teamIdByTeamDefinitionId.get(definitionId) === teamId) {
          this.teamIdByTeamDefinitionId.delete(definitionId);
          this.memberConfigsByTeamDefinitionId.delete(definitionId);
        }
      }
      return removed;
    } catch (error) {
      logger.error(`Failed to terminate team '${teamId}': ${String(error)}`);
      if (error instanceof AgentTeamTerminationError) {
        throw error;
      }
      throw new AgentTeamTerminationError(`Failed to terminate team: ${String(error)}`);
    }
  }

  getTeamDefinitionId(teamId: string): string | null {
    return this.teamDefinitionIdByTeamId.get(teamId) ?? null;
  }

  getTeamIdByDefinitionId(teamDefinitionId: string): string | null {
    return this.teamIdByTeamDefinitionId.get(teamDefinitionId) ?? null;
  }

  getTeamMemberConfigsByDefinitionId(teamDefinitionId: string): TeamMemberConfigInput[] {
    const configs = this.memberConfigsByTeamDefinitionId.get(teamDefinitionId);
    if (!Array.isArray(configs)) {
      return [];
    }
    return configs.map((config) => cloneMemberConfigInput(config));
  }

  getTeamMemberConfigs(teamId: string): TeamMemberConfigInput[] {
    const configs = this.memberConfigsByTeamId.get(teamId);
    if (!Array.isArray(configs)) {
      return [];
    }
    return configs.map((config) => cloneMemberConfigInput(config));
  }

  getTeamMemberNames(teamId: string): string[] {
    const names = this.memberNamesByTeamId.get(teamId);
    return Array.isArray(names) ? [...names] : [];
  }

  getTeamEventStream(teamId: string): AgentTeamEventStream | null {
    const team = this.getTeamInstance(teamId);
    if (!team) {
      logger.warn(
        `AgentTeamInstanceManager: Attempted to get event stream for non-existent team_id '${teamId}'.`,
      );
      return null;
    }
    return new AgentTeamEventStream(team as any);
  }
}
