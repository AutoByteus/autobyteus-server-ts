import {
  BaseAgentUserInputMessageProcessor,
  type AgentContext,
  type AgentInputUserMessage,
} from "autobyteus-ts";
import type { UserMessageReceivedEvent } from "autobyteus-ts/agent/events/agent-events.js";
import { SenderType } from "autobyteus-ts/agent/sender-type.js";
import { PersistenceProxy } from "../../../agent-conversation/providers/persistence-proxy.js";

const logger = {
  debug: (...args: unknown[]) => console.debug(...args),
  info: (...args: unknown[]) => console.info(...args),
  error: (...args: unknown[]) => console.error(...args),
};

export class UserInputPersistenceProcessor extends BaseAgentUserInputMessageProcessor {
  private persistenceProxy: PersistenceProxy;

  constructor() {
    super();
    this.persistenceProxy = new PersistenceProxy();
    logger.debug("UserInputPersistenceProcessor initialized.");
  }

  static override getName(): string {
    return "UserInputPersistenceProcessor";
  }

  static override getOrder(): number {
    return 950;
  }

  static override isMandatory(): boolean {
    return false;
  }

  private getPersistenceRole(senderType: SenderType): string {
    if (senderType === SenderType.TOOL) {
      return "user";
    }
    return "user";
  }

  async process(
    message: AgentInputUserMessage,
    context: AgentContext,
    triggeringEvent: UserMessageReceivedEvent,
  ): Promise<AgentInputUserMessage> {
    const agentId = context.agentId;
    const originalMessage = triggeringEvent.agentInputUserMessage;
    const contextPaths = originalMessage.contextFiles?.map((cf) => cf.uri) ?? [];
    const persistenceRole = this.getPersistenceRole(originalMessage.senderType);

    try {
      logger.debug(
        `Agent '${agentId}': Persisting message with senderType '${originalMessage.senderType}' as role '${persistenceRole}'.`,
      );

      await this.persistenceProxy.storeMessage({
        agentId,
        role: persistenceRole,
        message: message.content,
        originalMessage: originalMessage.content,
        contextPaths,
        reasoning: null,
        imageUrls: null,
        audioUrls: null,
        videoUrls: null,
      });

      logger.info(
        `Agent '${agentId}': Successfully persisted '${persistenceRole}' message (origin: ${originalMessage.senderType}).`,
      );
    } catch (error) {
      logger.error(
        `Agent '${agentId}': Failed to persist '${persistenceRole}' message: ${String(error)}`,
      );
    }

    return message;
  }
}
