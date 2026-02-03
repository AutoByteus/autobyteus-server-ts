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
import { PromptLoader, promptLoader } from "../../prompt-engineering/utils/prompt-loader.js";
import { SkillService } from "../../skills/services/skill-service.js";
import { WorkspaceManager, workspaceManager } from "../../workspaces/workspace-manager.js";
import { AgentTeamCreationError, AgentTeamTerminationError } from "../errors.js";

const logger = {
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
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
  llmConfig?: Record<string, unknown> | null;
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
    this.workspaceManager = options.workspaceManager ?? workspaceManager;
    this.skillService = options.skillService ?? SkillService.getInstance();
    this.promptLoader = options.promptLoader ?? promptLoader;
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
    logger.info(
      `Attempting to create agent team instance from definition ID: ${teamDefinitionId}`,
    );

    try {
      const memberConfigsMap: Record<string, TeamMemberConfigInput> = {};
      for (const config of memberConfigs) {
        memberConfigsMap[config.memberName] = config;
      }

      const teamConfig = await this.buildTeamConfigFromDefinition(
        teamDefinitionId,
        memberConfigsMap,
        new Set(),
      );

      const team = this.teamFactory.createTeam(teamConfig) as TeamLike & {
        start?: () => void;
      };
      team.start?.();
      await this.waitForIdle(team, 120.0);

      logger.info(
        `Successfully created and started agent team '${teamConfig.name}' with ID: ${team.teamId}`,
      );
      return team.teamId;
    } catch (error) {
      logger.error(
        `Failed to create agent team from definition ID '${teamDefinitionId}': ${String(error)}`,
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

    let workspaceInstance = memberConfig.workspaceId
      ? this.workspaceManager.getWorkspaceById(memberConfig.workspaceId)
      : undefined;

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

    const initialCustomData = {
      agent_definition_id: agentDefinitionId,
      is_on_first_turn: true,
    };

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
      if (member.referenceType === NodeType.AGENT) {
        const memberConfig = memberConfigsMap[member.memberName];
        if (!memberConfig) {
          throw new AgentTeamCreationError(
            `Configuration for team member '${member.memberName}' was not provided.`,
          );
        }
        hydratedConfigs[member.memberName] = await this.buildAgentConfigFromDefinition(
          member.memberName,
          member.referenceId,
          memberConfig,
        );
      } else if (member.referenceType === NodeType.AGENT_TEAM) {
        hydratedConfigs[member.memberName] = await this.buildTeamConfigFromDefinition(
          member.referenceId,
          memberConfigsMap,
          new Set(visited),
        );
      }
    }

    const teamNodeMap = new Map<string, TeamNodeConfig>();
    for (const [memberName, config] of Object.entries(hydratedConfigs)) {
      teamNodeMap.set(memberName, new TeamNodeConfig({ nodeDefinition: config }));
    }

    for (const memberDef of teamDef.nodes) {
      const currentNode = teamNodeMap.get(memberDef.memberName);
      if (!currentNode) {
        continue;
      }
      const dependencies = memberDef.dependencies.map((depName) => {
        const depNode = teamNodeMap.get(depName);
        if (!depNode) {
          throw new AgentTeamCreationError(
            `Dependency '${depName}' for team member '${memberDef.memberName}' was not found.`,
          );
        }
        return depNode;
      });
      currentNode.dependencies = dependencies;
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
      return await this.teamFactory.removeTeam(teamId);
    } catch (error) {
      logger.error(`Failed to terminate team '${teamId}': ${String(error)}`);
      if (error instanceof AgentTeamTerminationError) {
        throw error;
      }
      throw new AgentTeamTerminationError(`Failed to terminate team: ${String(error)}`);
    }
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

export const agentTeamInstanceManager = AgentTeamInstanceManager.getInstance();
