import type {
  AgentConversation as DomainAgentConversation,
  ConversationHistory as DomainConversationHistory,
  Message as DomainMessage,
} from "../../../agent-conversation/domain/models.js";
import { AgentDefinitionService } from "../../../agent-definition/services/agent-definition-service.js";
import type {
  AgentConversation as GraphqlAgentConversation,
  ConversationHistory as GraphqlConversationHistory,
  Message as GraphqlMessage,
} from "../types/conversation.js";

const agentDefinitionService = AgentDefinitionService.getInstance();

export class MessageConverter {
  static toGraphql(domainMessage: DomainMessage): GraphqlMessage {
    return {
      messageId: domainMessage.messageId ?? null,
      role: domainMessage.role,
      message: domainMessage.message,
      timestamp: domainMessage.timestamp.toISOString(),
      contextPaths: domainMessage.contextPaths ?? null,
      originalMessage: domainMessage.originalMessage ?? null,
      tokenCount: domainMessage.tokenCount ?? null,
      cost: domainMessage.cost ?? null,
      reasoning: domainMessage.reasoning ?? null,
      imageUrls: domainMessage.imageUrls ?? null,
      audioUrls: domainMessage.audioUrls ?? null,
      videoUrls: domainMessage.videoUrls ?? null,
    };
  }
}

export class AgentConversationConverter {
  static async toGraphql(
    domainConversation: DomainAgentConversation,
  ): Promise<GraphqlAgentConversation> {
    const messages = domainConversation.messages.map((msg) => MessageConverter.toGraphql(msg));

    let agentName: string | null = null;
    if (domainConversation.agentDefinitionId) {
      try {
        const definition = await agentDefinitionService.getAgentDefinitionById(
          domainConversation.agentDefinitionId,
        );
        if (definition) {
          agentName = definition.name;
        }
      } catch {
        agentName = null;
      }
    }

    return {
      agentId: domainConversation.agentId,
      agentDefinitionId: domainConversation.agentDefinitionId,
      createdAt: domainConversation.createdAt.toISOString(),
      messages,
      llmModel: domainConversation.llmModel ?? null,
      useXmlToolFormat: domainConversation.useXmlToolFormat,
      agentName,
    };
  }
}

export class ConversationHistoryConverter {
  static async toGraphql(
    domainHistory: DomainConversationHistory,
  ): Promise<GraphqlConversationHistory> {
    const conversations = await Promise.all(
      domainHistory.conversations.map((conv) => AgentConversationConverter.toGraphql(conv)),
    );
    return {
      conversations,
      totalConversations: domainHistory.totalConversations,
      totalPages: domainHistory.totalPages,
      currentPage: domainHistory.currentPage,
    };
  }
}
