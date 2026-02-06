import { BaseLLMResponseProcessor, type AgentContext } from "autobyteus-ts";
import type { LLMCompleteResponseReceivedEvent } from "autobyteus-ts/agent/events/agent-events.js";
import type { CompleteResponse } from "autobyteus-ts/llm/utils/response-types.js";
import { PersistenceProxy } from "../../../agent-conversation/providers/persistence-proxy.js";

const logger = {
  debug: (...args: unknown[]) => console.debug(...args),
  info: (...args: unknown[]) => console.info(...args),
  error: (...args: unknown[]) => console.error(...args),
};

export class AssistantResponsePersistenceProcessor extends BaseLLMResponseProcessor {
  private persistenceProxy: PersistenceProxy;

  constructor() {
    super();
    this.persistenceProxy = new PersistenceProxy();
    logger.debug("AssistantResponsePersistenceProcessor initialized.");
  }

  static override getName(): string {
    return "AssistantResponsePersistenceProcessor";
  }

  static override getOrder(): number {
    return 800;
  }

  static override isMandatory(): boolean {
    return false;
  }

  async processResponse(
    response: CompleteResponse,
    context: AgentContext,
    _triggeringEvent: LLMCompleteResponseReceivedEvent,
  ): Promise<boolean> {
    const agentId = context.agentId;

    const tokenCount = response.usage ? response.usage.completion_tokens : null;
    const cost = response.usage ? response.usage.completion_cost ?? null : null;

    try {
      logger.debug(
        `Agent '${agentId}': Persisting assistant response to conversation for agent '${agentId}'.`,
      );

      await this.persistenceProxy.storeMessage({
        agentId,
        role: "assistant",
        message: response.content,
        tokenCount,
        cost,
        reasoning: response.reasoning,
        imageUrls: response.image_urls,
        audioUrls: response.audio_urls,
        videoUrls: response.video_urls,
      });

      logger.info(
        `Agent '${agentId}': Successfully persisted assistant response for agent '${agentId}'.`,
      );
    } catch (error) {
      logger.error(
        `Agent '${agentId}': Failed to persist assistant response for agent '${agentId}': ${String(
          error,
        )}`,
      );
    }

    return false;
  }
}
