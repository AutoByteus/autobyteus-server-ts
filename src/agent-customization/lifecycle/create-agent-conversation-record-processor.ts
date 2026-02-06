import {
  BaseLifecycleEventProcessor,
  LifecycleEvent,
  resolveToolCallFormat,
  type AgentContext,
} from "autobyteus-ts";
import { PersistenceProxy } from "../../agent-conversation/providers/persistence-proxy.js";

const logger = {
  info: (...args: unknown[]) => console.info(...args),
  error: (...args: unknown[]) => console.error(...args),
  debug: (...args: unknown[]) => console.debug(...args),
};

export class CreateAgentConversationRecordProcessor extends BaseLifecycleEventProcessor {
  private persistenceProxy: PersistenceProxy;

  constructor() {
    super();
    this.persistenceProxy = new PersistenceProxy();
    logger.debug("CreateAgentConversationRecordProcessor initialized.");
  }

  static override isMandatory(): boolean {
    return false;
  }

  get event(): LifecycleEvent {
    return LifecycleEvent.AGENT_READY;
  }

  async process(context: AgentContext, _eventData: Record<string, unknown>): Promise<void> {
    const agentId = context.agentId;

    try {
      const agentDefinitionId = context.customData["agent_definition_id"] as string | undefined;
      if (!agentDefinitionId) {
        logger.error(
          `Processor '${this.constructor.name}': CRITICAL - 'agent_definition_id' not found in customData for agent '${agentId}'.`,
        );
        return;
      }

      const llmModel = context.llmInstance?.model.value ?? null;
      const useXmlToolFormat = resolveToolCallFormat() === "xml";

      logger.info(
        `Processor '${this.constructor.name}': Running for agent '${agentId}' on AGENT_READY.`,
      );

      await this.persistenceProxy.createConversation(
        agentId,
        agentDefinitionId,
        llmModel,
        useXmlToolFormat,
      );

      logger.info(
        `Processor '${this.constructor.name}': Created DB record for agent '${agentId}' with definition '${agentDefinitionId}'.`,
      );
    } catch (error) {
      logger.error(
        `Processor '${this.constructor.name}': CRITICAL - Failed to create persistence record for agent '${agentId}'. Error: ${String(
          error,
        )}`,
      );
    }
  }
}
