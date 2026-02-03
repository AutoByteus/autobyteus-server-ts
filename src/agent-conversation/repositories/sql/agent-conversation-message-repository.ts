import {
  Prisma,
  type AgentConversationMessage as PrismaAgentConversationMessage,
} from "@prisma/client";
import { BaseRepository } from "repository_prisma";

const logger = {
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};

export class SqlAgentConversationMessageRepository extends BaseRepository.forModel(
  Prisma.ModelName.AgentConversationMessage,
) {
  async createMessage(
    data: Prisma.AgentConversationMessageCreateInput,
  ): Promise<PrismaAgentConversationMessage> {
    try {
      return await this.create({ data });
    } catch (error) {
      logger.error(`Error creating message: ${String(error)}`);
      throw error;
    }
  }

  async getMessagesByAgentConversationId(
    agentConversationId: number,
  ): Promise<PrismaAgentConversationMessage[]> {
    try {
      return await this.findMany({
        where: { agentConversationId },
        orderBy: { timestamp: "asc" },
      });
    } catch (error) {
      logger.error(
        `Error retrieving messages for agent conversation ${agentConversationId}: ${String(error)}`,
      );
      throw error;
    }
  }

  async updateMessage(
    messageId: number,
    newContent: string,
  ): Promise<PrismaAgentConversationMessage | null> {
    try {
      const existing = await this.findUnique({ where: { id: messageId } });
      if (!existing) {
        logger.warn(`Message with id ${messageId} not found`);
        return null;
      }
      return await this.update({
        where: { id: messageId },
        data: { message: newContent },
      });
    } catch (error) {
      logger.error(`Error updating message: ${String(error)}`);
      throw error;
    }
  }

  async deleteMessage(messageId: number): Promise<boolean> {
    try {
      const existing = await this.findUnique({ where: { id: messageId } });
      if (!existing) {
        logger.warn(`Message with id ${messageId} not found`);
        return false;
      }
      await this.delete({ where: { id: messageId } });
      return true;
    } catch (error) {
      logger.error(`Error deleting message: ${String(error)}`);
      throw error;
    }
  }

  async updateTokenUsage(
    messageId: number,
    tokenCount: number,
    cost: number,
  ): Promise<PrismaAgentConversationMessage | null> {
    try {
      const existing = await this.findUnique({ where: { id: messageId } });
      if (!existing) {
        logger.warn(`Message with id ${messageId} not found`);
        return null;
      }
      const updated = await this.update({
        where: { id: messageId },
        data: { tokenCount, cost },
      });
      logger.info(`Updated token usage for message ${messageId}`);
      return updated;
    } catch (error) {
      logger.error(`Error updating token usage for message ${messageId}: ${String(error)}`);
      throw error;
    }
  }
}
