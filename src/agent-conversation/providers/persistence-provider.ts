import type { AgentConversation, ConversationHistory } from "../domain/models.js";

export interface PersistenceProvider {
  createConversation(
    agentId: string,
    agentDefinitionId: string,
    llmModel?: string | null,
    useXmlToolFormat?: boolean,
  ): Promise<AgentConversation>;

  storeMessage(options: {
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
  }): Promise<AgentConversation>;

  getAgentConversationHistory(options: {
    agentDefinitionId: string;
    page?: number;
    pageSize?: number;
    searchQuery?: string | null;
  }): Promise<ConversationHistory>;

  getRawConversationHistory(options: {
    page?: number;
    pageSize?: number;
    searchQuery?: string | null;
    agentDefinitionId?: string | null;
  }): Promise<ConversationHistory>;

  updateLastUserMessageUsage(
    agentId: string,
    tokenCount: number,
    cost: number,
  ): Promise<AgentConversation>;
}
