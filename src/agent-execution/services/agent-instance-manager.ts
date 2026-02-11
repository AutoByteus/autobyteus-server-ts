import {
  AgentConfig,
  AgentEventStream,
  BaseAgentUserInputMessageProcessor,
  BaseLLMResponseProcessor,
  BaseLifecycleEventProcessor,
  BaseSystemPromptProcessor,
  BaseToolExecutionResultProcessor,
  BaseToolInvocationPreprocessor,
  SkillAccessMode,
  defaultAgentFactory,
  defaultInputProcessorRegistry,
  defaultLlmResponseProcessorRegistry,
  defaultLifecycleEventProcessorRegistry,
  defaultSystemPromptProcessorRegistry,
  defaultToolExecutionResultProcessorRegistry,
  defaultToolInvocationPreprocessorRegistry,
  LLMFactory,
  waitForAgentToBeIdle,
} from "autobyteus-ts";
import type { Agent } from "autobyteus-ts/agent/agent.js";
import { defaultToolRegistry } from "autobyteus-ts/tools/registry/tool-registry.js";
import { LLMConfig } from "autobyteus-ts/llm/utils/llm-config.js";
import { AgentDefinition } from "../../agent-definition/domain/models.js";
import { AgentDefinitionService } from "../../agent-definition/services/agent-definition-service.js";
import { mergeMandatoryAndOptional } from "../../agent-definition/utils/processor-defaults.js";
import { PromptLoader, getPromptLoader } from "../../prompt-engineering/utils/prompt-loader.js";
import { SkillService } from "../../skills/services/skill-service.js";
import { WorkspaceManager, getWorkspaceManager } from "../../workspaces/workspace-manager.js";
import { AgentCreationError, AgentTerminationError } from "../errors.js";
import { appConfigProvider } from "../../config/app-config-provider.js";

const logger = {
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};

type AgentFactoryLike = typeof defaultAgentFactory;
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

type AgentLike = {
  agentId: string;
  context?: {
    statusManager?: {
      notifier?: unknown;
    } | null;
  };
};

type AgentInstanceManagerOptions = {
  agentFactory?: AgentFactoryLike;
  agentDefinitionService?: AgentDefinitionService;
  llmFactory?: LlmFactoryLike;
  workspaceManager?: WorkspaceManager;
  skillService?: SkillService;
  promptLoader?: PromptLoader;
  registries?: Partial<ProcessorRegistries>;
  waitForIdle?: (agent: Agent, timeout?: number) => Promise<void>;
};

export class AgentInstanceManager {
  private static instance: AgentInstanceManager | null = null;
  private agentFactory: AgentFactoryLike;
  private agentDefinitionService: AgentDefinitionService;
  private llmFactory: LlmFactoryLike;
  private workspaceManager: WorkspaceManager;
  private skillService: SkillService;
  private promptLoader: PromptLoader;
  private registries: ProcessorRegistries;
  private waitForIdle: (agent: Agent, timeout?: number) => Promise<void>;

  static getInstance(options: AgentInstanceManagerOptions = {}): AgentInstanceManager {
    if (!AgentInstanceManager.instance) {
      AgentInstanceManager.instance = new AgentInstanceManager(options);
    }
    return AgentInstanceManager.instance;
  }

  constructor(options: AgentInstanceManagerOptions = {}) {
    this.agentFactory = options.agentFactory ?? defaultAgentFactory;
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
    this.waitForIdle = options.waitForIdle ?? waitForAgentToBeIdle;
    logger.info("AgentInstanceManager initialized.");
  }

  async createAgentInstance(options: {
    agentDefinitionId: string;
    llmModelIdentifier: string;
    autoExecuteTools: boolean;
    workspaceId?: string | null;
    llmConfig?: Record<string, unknown> | null;
    skillAccessMode?: SkillAccessMode | null;
  }): Promise<string> {
    const {
      agentDefinitionId,
      llmModelIdentifier,
      autoExecuteTools,
      workspaceId,
      llmConfig,
      skillAccessMode,
    } = options;

    let agentDef: AgentDefinition | null = null;
    try {
      agentDef = await this.agentDefinitionService.getAgentDefinitionById(agentDefinitionId);
    } catch (error) {
      logger.error(
        `Failed to fetch agent definition '${agentDefinitionId}': ${String(error)}`,
      );
    }

    if (!agentDef) {
      throw new AgentCreationError(
        `AgentDefinition with ID ${agentDefinitionId} not found.`,
      );
    }

    const systemPrompt = await this.promptLoader.getPromptTemplateForAgent(
      agentDefinitionId,
      llmModelIdentifier,
    );

    const resolvedPrompt = systemPrompt ?? agentDef.description;
    if (!systemPrompt) {
      logger.warn(
        `No suitable active system prompt found for AgentDefinition ${agentDefinitionId} and model '${llmModelIdentifier}'. Using agent description as fallback.`,
      );
    } else {
      logger.info(
        `Resolved system prompt for AgentDefinition ${agentDefinitionId} and model '${llmModelIdentifier}'.`,
      );
    }

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

    const skillPaths: string[] = [];
    if (agentDef.skillNames?.length) {
      for (const skillName of agentDef.skillNames) {
        const skill = this.skillService.getSkill(skillName);
        if (skill) {
          skillPaths.push(skill.rootPath);
          logger.info(`Resolved skill '${skillName}' to path: ${skill.rootPath}`);
        } else {
          logger.warn(
            `Skill '${skillName}' defined in agent definition '${agentDef.name}' not found via SkillService. Skipping.`,
          );
        }
      }
    }

    const config = llmConfig ? new LLMConfig({ extraParams: llmConfig }) : undefined;
    const llmInstance = await this.llmFactory.createLLM(llmModelIdentifier, config);

    let workspaceInstance = workspaceId
      ? this.workspaceManager.getWorkspaceById(workspaceId)
      : undefined;
    if (workspaceId && !workspaceInstance) {
      logger.warn(
        `Workspace with ID ${workspaceId} not found. Falling back to temp workspace.`,
      );
    }
    if (!workspaceInstance) {
      workspaceInstance = await this.workspaceManager.getOrCreateTempWorkspace();
      logger.info(`Using temp workspace (ID: ${workspaceInstance.workspaceId}) for agent.`);
    }

    const initialCustomData = {
      agent_definition_id: agentDefinitionId,
      is_on_first_turn: true,
    };

    const agentConfig = new AgentConfig(
      agentDef.name,
      agentDef.role,
      agentDef.description,
      llmInstance,
      resolvedPrompt,
      tools,
      autoExecuteTools,
      inputProcessors,
      llmResponseProcessors,
      systemPromptProcessors,
      toolExecutionResultProcessors,
      toolInvocationPreprocessors,
      workspaceInstance ?? null,
      lifecycleProcessors,
      initialCustomData,
      skillPaths,
      appConfigProvider.config.getMemoryDir(),
      skillAccessMode ?? null,
    );

    const agent = this.agentFactory.createAgent(agentConfig) as AgentLike & {
      start?: () => void;
    };
    agent.start?.();
    await this.waitForIdle(agent as Agent);
    logger.info(
      `Successfully created and started agent instance '${agent.agentId}' from definition '${agentDef.name}'.`,
    );
    return agent.agentId;
  }

  getAgentInstance(agentId: string): AgentLike | null {
    return (this.agentFactory.getAgent(agentId) as AgentLike | undefined) ?? null;
  }

  listActiveInstances(): string[] {
    return this.agentFactory.listActiveAgentIds();
  }

  async terminateAgentInstance(agentId: string): Promise<boolean> {
    try {
      return await this.agentFactory.removeAgent(agentId);
    } catch (error) {
      logger.error(`Failed to terminate agent instance '${agentId}': ${String(error)}`);
      throw new AgentTerminationError(String(error));
    }
  }

  getAgentEventStream(agentId: string): AgentEventStream | null {
    const agent = this.getAgentInstance(agentId);
    if (!agent) {
      logger.warn(
        `AgentInstanceManager: Attempted to get event stream for non-existent agent_id '${agentId}'.`,
      );
      return null;
    }
    return new AgentEventStream(agent as any);
  }
}
