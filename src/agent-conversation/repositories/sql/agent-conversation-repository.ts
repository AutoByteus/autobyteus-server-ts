import { Prisma, type AgentConversation as PrismaAgentConversation } from "@prisma/client";
import { BaseRepository } from "repository_prisma";

const logger = {
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};

export class SqlAgentConversationRepository extends BaseRepository.forModel(
  Prisma.ModelName.AgentConversation,
) {
  async createAgentConversation(options: {
    agentId: string;
    agentDefinitionId: string;
    llmModel?: string | null;
    useXmlToolFormat?: boolean;
  }): Promise<PrismaAgentConversation> {
    try {
      const created = await this.create({
        data: {
          agentId: options.agentId,
          agentDefinitionId: options.agentDefinitionId,
          llmModel: options.llmModel ?? undefined,
          useXmlToolFormat: options.useXmlToolFormat ?? false,
        },
      });
      logger.info(`Successfully created agent conversation with ID: ${created.id}`);
      return created;
    } catch (error) {
      logger.error(`Error creating agent conversation: ${String(error)}`);
      throw error;
    }
  }

  async findById(id: number): Promise<PrismaAgentConversation | null> {
    try {
      return await this.findUnique({ where: { id } });
    } catch (error) {
      logger.error(`Error retrieving agent conversation by id: ${String(error)}`);
      throw error;
    }
  }

  async findByAgentId(agentId: string): Promise<PrismaAgentConversation | null> {
    try {
      return await this.findUnique({ where: { agentId } });
    } catch (error) {
      logger.error(`Error retrieving agent conversation by agentId: ${String(error)}`);
      throw error;
    }
  }

  async getConversationsByAgentDefinitionId(options: {
    agentDefinitionId: string;
    page: number;
    pageSize: number;
    searchQuery?: string | null;
  }): Promise<{
    conversations: PrismaAgentConversation[];
    totalConversations: number;
    totalPages: number;
    currentPage: number;
  }> {
    const where = this.buildWhere({
      agentDefinitionId: options.agentDefinitionId,
      searchQuery: options.searchQuery ?? null,
    });
    return this.getPaginatedResult(where, options.page, options.pageSize);
  }

  async getRawConversations(options: {
    page: number;
    pageSize: number;
    searchQuery?: string | null;
    agentDefinitionId?: string | null;
  }): Promise<{
    conversations: PrismaAgentConversation[];
    totalConversations: number;
    totalPages: number;
    currentPage: number;
  }> {
    const where = this.buildWhere({
      agentDefinitionId: options.agentDefinitionId ?? null,
      searchQuery: options.searchQuery ?? null,
    });
    return this.getPaginatedResult(where, options.page, options.pageSize);
  }

  private buildWhere(options: {
    agentDefinitionId?: string | null;
    searchQuery?: string | null;
  }): Prisma.AgentConversationWhereInput {
    const where: Prisma.AgentConversationWhereInput = {};
    if (options.agentDefinitionId) {
      where.agentDefinitionId = options.agentDefinitionId;
    }
    if (options.searchQuery) {
      where.messages = {
        some: {
          message: {
            contains: options.searchQuery,
          },
        },
      };
    }
    return where;
  }

  private async getPaginatedResult(
    where: Prisma.AgentConversationWhereInput,
    page: number,
    pageSize: number,
  ): Promise<{
    conversations: PrismaAgentConversation[];
    totalConversations: number;
    totalPages: number;
    currentPage: number;
  }> {
    const skip = (page - 1) * pageSize;

    try {
      const totalConversations = await this.count({ where });
      const conversations = await this.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: pageSize,
      });
      const totalPages =
        pageSize > 0 ? Math.ceil(totalConversations / pageSize) : 0;
      return {
        conversations,
        totalConversations,
        totalPages,
        currentPage: page,
      };
    } catch (error) {
      logger.error(`Error retrieving agent conversations: ${String(error)}`);
      throw error;
    }
  }
}
