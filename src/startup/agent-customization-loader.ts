import {
  AgentUserInputMessageProcessorDefinition,
  LLMResponseProcessorDefinition,
  LifecycleEventProcessorDefinition,
  ToolExecutionResultProcessorDefinition,
  ToolInvocationPreprocessorDefinition,
  type BaseAgentUserInputMessageProcessor,
  type BaseLLMResponseProcessor,
  type BaseLifecycleEventProcessor,
  type BaseToolExecutionResultProcessor,
  type BaseToolInvocationPreprocessor,
  defaultSystemPromptProcessorRegistry,
  defaultInputProcessorRegistry,
  defaultLlmResponseProcessorRegistry,
  defaultLifecycleEventProcessorRegistry,
  defaultToolExecutionResultProcessorRegistry,
  defaultToolInvocationPreprocessorRegistry,
  registerSystemPromptProcessors,
} from "autobyteus-ts";
import { CreateAgentConversationRecordProcessor } from "../agent-customization/lifecycle/create-agent-conversation-record-processor.js";
import { UserInputPersistenceProcessor } from "../agent-customization/processors/persistence/user-input-persistence-processor.js";
import { AssistantResponsePersistenceProcessor } from "../agent-customization/processors/persistence/assistant-response-persistence-processor.js";
import { TokenUsagePersistenceProcessor } from "../agent-customization/processors/persistence/token-usage-persistence-processor.js";
import { UserInputContextBuildingProcessor } from "../agent-customization/processors/prompt/user-input-context-building-processor.js";
import { WorkspacePathSanitizationProcessor } from "../agent-customization/processors/security-processor/workspace-path-sanitization-processor.js";
import { MediaToolResultUrlTransformerProcessor } from "../agent-customization/processors/tool-result/media-tool-result-url-transformer-processor.js";
import { AgentArtifactPersistenceProcessor } from "../agent-customization/processors/tool-result/agent-artifact-persistence-processor.js";
import { MediaInputPathToUrlPreprocessor } from "../agent-customization/processors/tool-invocation/media-input-path-to-url-preprocessor.js";
import { MediaUrlTransformerProcessor } from "../agent-customization/processors/response-customization/media-url-transformer-processor.js";

const logger = {
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
};

type InputProcessorClass = typeof BaseAgentUserInputMessageProcessor &
  (new () => BaseAgentUserInputMessageProcessor);
type LlmResponseProcessorClass = typeof BaseLLMResponseProcessor & (new () => BaseLLMResponseProcessor);
type LifecycleProcessorClass = typeof BaseLifecycleEventProcessor &
  (new () => BaseLifecycleEventProcessor);
type ToolResultProcessorClass = typeof BaseToolExecutionResultProcessor &
  (new () => BaseToolExecutionResultProcessor);
type ToolInvocationPreprocessorClass = typeof BaseToolInvocationPreprocessor &
  (new () => BaseToolInvocationPreprocessor);

function registerInputProcessor(processorClass: InputProcessorClass): void {
  const name = processorClass.getName();
  if (defaultInputProcessorRegistry.contains(name)) {
    return;
  }
  defaultInputProcessorRegistry.registerProcessor(
    new AgentUserInputMessageProcessorDefinition(name, processorClass),
  );
  logger.info(`Registered input processor '${name}'.`);
}

function registerLlmResponseProcessor(processorClass: LlmResponseProcessorClass): void {
  const name = processorClass.getName();
  if (defaultLlmResponseProcessorRegistry.contains(name)) {
    return;
  }
  defaultLlmResponseProcessorRegistry.registerProcessor(
    new LLMResponseProcessorDefinition(name, processorClass),
  );
  logger.info(`Registered LLM response processor '${name}'.`);
}

function registerLifecycleProcessor(processorClass: LifecycleProcessorClass): void {
  const name = processorClass.getName();
  if (defaultLifecycleEventProcessorRegistry.has(name)) {
    return;
  }
  defaultLifecycleEventProcessorRegistry.registerProcessor(
    new LifecycleEventProcessorDefinition(name, processorClass),
  );
  logger.info(`Registered lifecycle processor '${name}'.`);
}

function registerToolResultProcessor(processorClass: ToolResultProcessorClass): void {
  const name = processorClass.getName();
  if (defaultToolExecutionResultProcessorRegistry.contains(name)) {
    return;
  }
  defaultToolExecutionResultProcessorRegistry.registerProcessor(
    new ToolExecutionResultProcessorDefinition(name, processorClass),
  );
  logger.info(`Registered tool result processor '${name}'.`);
}

function registerToolInvocationPreprocessor(processorClass: ToolInvocationPreprocessorClass): void {
  const name = processorClass.getName();
  if (defaultToolInvocationPreprocessorRegistry.contains(name)) {
    return;
  }
  defaultToolInvocationPreprocessorRegistry.registerPreprocessor(
    new ToolInvocationPreprocessorDefinition(name, processorClass),
  );
  logger.info(`Registered tool invocation preprocessor '${name}'.`);
}

function ensureSystemPromptProcessorsRegistered(): void {
  const requiredNames = ["ToolManifestInjector", "AvailableSkillsProcessor"];
  const missing = requiredNames.filter((name) => !defaultSystemPromptProcessorRegistry.contains(name));
  if (missing.length === 0) {
    logger.info("System prompt processors already registered.");
    return;
  }
  registerSystemPromptProcessors();
  logger.info(`Registered system prompt processors: ${requiredNames.join(", ")}`);
}

export function loadAgentCustomizations(): void {
  logger.info("Registering agent customization processors...");

  ensureSystemPromptProcessorsRegistered();

  registerLifecycleProcessor(CreateAgentConversationRecordProcessor);

  registerInputProcessor(WorkspacePathSanitizationProcessor);
  registerInputProcessor(UserInputContextBuildingProcessor);
  registerInputProcessor(UserInputPersistenceProcessor);

  registerLlmResponseProcessor(AssistantResponsePersistenceProcessor);
  registerLlmResponseProcessor(TokenUsagePersistenceProcessor);
  registerLlmResponseProcessor(MediaUrlTransformerProcessor);

  registerToolInvocationPreprocessor(MediaInputPathToUrlPreprocessor);
  registerToolResultProcessor(MediaToolResultUrlTransformerProcessor);
  registerToolResultProcessor(AgentArtifactPersistenceProcessor);

  logger.info("Agent customization processor registration complete.");
}
