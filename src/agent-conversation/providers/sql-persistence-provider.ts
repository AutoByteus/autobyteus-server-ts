import type { AgentConversation, ConversationHistory } from "../domain/models.js";
import { PrismaConversationConverter } from "../converters/prisma-converter.js";
import { SqlAgentConversationRepository } from "../repositories/sql/agent-conversation-repository.js";
import { SqlAgentConversationMessageRepository } from "../repositories/sql/agent-conversation-message-repository.js";
import type { PersistenceProvider } from "./persistence-provider.js";
import type { AgentConversation as PrismaAgentConversation } from "@prisma/client";

const logger = {
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};

export class SqlPersistenceProvider implements PersistenceProvider {
  private conversationRepository = new SqlAgentConversationRepository();
  private messageRepository = new SqlAgentConversationMessageRepository();
  private currentConversations = new Map<string, PrismaAgentConversation>();

  async createConversation(
    agentId: string,
    agentDefinitionId: string,
    llmModel?: string | null,
    useXmlToolFormat?: boolean,
  ): Promise<AgentConversation> {
    try {
      const sqlConversation = await this.conversationRepository.createAgentConversation({
        agentId,
        agentDefinitionId,
        llmModel: llmModel ?? null,
        useXmlToolFormat,
      });
      this.currentConversations.set(sqlConversation.agentId, sqlConversation);
      return PrismaConversationConverter.toDomainConversation(sqlConversation, []);
    } catch (error) {
      logger.error(`Error creating conversation for agent '${agentId}': ${String(error)}`);
      throw error;
    }
  }

  async storeMessage(options: {
    agentId: string;
    role: string;
    message: string;
    tokenCount?: number | null;
    cost?: number | null;
    originalMessage?: string | null;
    contextPaths?: string[] | null;
    reasoning?: string | null;
    imageUrls?: string[] | null;
    audioUrls?: string[] | null;
    videoUrls?: string[] | null;
  }): Promise<AgentConversation> {
    try {
      if (options.tokenCount !== undefined && options.tokenCount !== null && options.tokenCount < 0) {
        throw new Error("token_count cannot be negative");
      }
      if (options.cost !== undefined && options.cost !== null && options.cost < 0) {
        throw new Error("cost cannot be negative");
      }

      let sqlConv = this.currentConversations.get(options.agentId);
      if (!sqlConv) {
        const found = await this.conversationRepository.findByAgentId(options.agentId);
        if (!found) {
          logger.error(`Conversation for agent ID ${options.agentId} does not exist.`);
          throw new Error(`Conversation for agent ID ${options.agentId} does not exist.`);
        }
        sqlConv = found;
        this.currentConversations.set(options.agentId, sqlConv);
      }

      const createInput = PrismaConversationConverter.toMessageCreateInput({
        agentConversationId: sqlConv.id,
        role: options.role,
        message: options.message,
        originalMessage: options.originalMessage ?? null,
        contextPaths: options.contextPaths ?? null,
        tokenCount: options.tokenCount ?? null,
        cost: options.cost ?? null,
        reasoning: options.reasoning ?? null,
        imageUrls: options.imageUrls ?? null,
        audioUrls: options.audioUrls ?? null,
        videoUrls: options.videoUrls ?? null,
      });

      await this.messageRepository.createMessage(createInput);

      const messages = await this.messageRepository.getMessagesByAgentConversationId(sqlConv.id);
      const updatedConversation = PrismaConversationConverter.toDomainConversation(sqlConv, messages);
      this.currentConversations.set(options.agentId, sqlConv);
      return updatedConversation;
    } catch (error) {
      logger.error(
        `Failed to store message in conversation for agent '${options.agentId}': ${String(error)}`,
      );
      throw error;
    }
  }

  async getAgentConversationHistory(options: {
    agentDefinitionId: string;
    page?: number;
    pageSize?: number;
    searchQuery?: string | null;
  }): Promise<ConversationHistory> {
    try {
      const result = await this.conversationRepository.getConversationsByAgentDefinitionId({
        agentDefinitionId: options.agentDefinitionId,
        page: options.page ?? 1,
        pageSize: options.pageSize ?? 10,
        searchQuery: options.searchQuery ?? null,
      });
      return await this.buildHistoryResponse(result);
    } catch (error) {
      logger.error(
        `Error retrieving history for agent '${options.agentDefinitionId}': ${String(error)}`,
      );
      throw error;
    }
  }

  async getRawConversationHistory(options: {
    page?: number;
    pageSize?: number;
    searchQuery?: string | null;
    agentDefinitionId?: string | null;
  }): Promise<ConversationHistory> {
    try {
      const result = await this.conversationRepository.getRawConversations({
        page: options.page ?? 1,
        pageSize: options.pageSize ?? 10,
        searchQuery: options.searchQuery ?? null,
        agentDefinitionId: options.agentDefinitionId ?? null,
      });
      return await this.buildHistoryResponse(result);
    } catch (error) {
      logger.error(`Error retrieving raw history: ${String(error)}`);
      throw error;
    }
  }

  async updateLastUserMessageUsage(
    agentId: string,
    tokenCount: number,
    cost: number,
  ): Promise<AgentConversation> {
    try {
      if (tokenCount < 0) {
        throw new Error("token_count cannot be negative");
      }
      if (cost < 0) {
        throw new Error("cost cannot be negative");
      }

      let sqlConv = this.currentConversations.get(agentId);
      if (!sqlConv) {
        const found = await this.conversationRepository.findByAgentId(agentId);
        if (!found) {
          logger.error(`Conversation for agent ID ${agentId} does not exist.`);
          throw new Error(`Conversation for agent ID ${agentId} does not exist.`);
        }
        sqlConv = found;
        this.currentConversations.set(agentId, sqlConv);
      }

      const messages = await this.messageRepository.getMessagesByAgentConversationId(sqlConv.id);
      if (!messages.length) {
        logger.error("No messages found in the conversation.");
        throw new Error("No messages found in the conversation to update usage.");
      }

      const lastUserMessage = [...messages]
        .reverse()
        .find((message) => message.role.toLowerCase() === "user");

      if (!lastUserMessage) {
        logger.error("No user message found to update token usage.");
        throw new Error("No user message found in the conversation to update token usage.");
      }

      const updatedMessage = await this.messageRepository.updateTokenUsage(
        lastUserMessage.id,
        tokenCount,
        cost,
      );
      if (!updatedMessage) {
        logger.error(`Message with ID ${lastUserMessage.id} not found for update.`);
        throw new Error(`Message with ID ${lastUserMessage.id} not found for update.`);
      }

      const updatedMessages = await this.messageRepository.getMessagesByAgentConversationId(
        sqlConv.id,
      );
      const updatedConversation = PrismaConversationConverter.toDomainConversation(
        sqlConv,
        updatedMessages,
      );

      logger.info(
        `Updated token usage for the last user message in conversation for agent ${agentId}`,
      );
      return updatedConversation;
    } catch (error) {
      logger.error(
        `Failed to update token usage for the last user message in conversation for agent '${agentId}': ${String(error)}`,
      );
      throw error;
    }
  }

  private async buildHistoryResponse(result: {
    conversations: PrismaAgentConversation[];
    totalConversations: number;
    totalPages: number;
    currentPage: number;
  }): Promise<ConversationHistory> {
    const conversations: AgentConversation[] = [];
    for (const sqlConv of result.conversations) {
      const messages = await this.messageRepository.getMessagesByAgentConversationId(sqlConv.id);
      conversations.push(PrismaConversationConverter.toDomainConversation(sqlConv, messages));
    }

    return {
      conversations,
      totalConversations: result.totalConversations,
      totalPages: result.totalPages,
      currentPage: result.currentPage,
    };
  }
}
