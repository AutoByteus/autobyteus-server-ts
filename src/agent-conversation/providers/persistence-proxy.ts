import type { AgentConversation, ConversationHistory } from "../domain/models.js";
import type { PersistenceProvider } from "./persistence-provider.js";
import { PersistenceProviderRegistry } from "./persistence-provider-registry.js";

const logger = {
  error: (...args: unknown[]) => console.error(...args),
};

export class PersistenceProxy implements PersistenceProvider {
  private providerInstance: PersistenceProvider | null = null;
  private registry = PersistenceProviderRegistry.getInstance();

  private get provider(): PersistenceProvider {
    if (!this.providerInstance) {
      this.providerInstance = this.initializeProvider();
    }
    return this.providerInstance;
  }

  private initializeProvider(): PersistenceProvider {
    const providerType = (process.env.PERSISTENCE_PROVIDER ?? "sqlite").toLowerCase();
    const providerClass = this.registry.getProviderClass(providerType);
    if (!providerClass) {
      const available = this.registry.getAvailableProviders().join(", ");
      throw new Error(
        `Unsupported persistence provider: ${providerType}. Available providers: ${available}`,
      );
    }

    try {
      return new providerClass();
    } catch (error) {
      logger.error(`Failed to initialize ${providerType} provider: ${String(error)}`);
      throw error;
    }
  }

  registerProvider(name: string, providerClass: new () => PersistenceProvider): void {
    this.registry.registerProvider(name, providerClass);
    this.providerInstance = null;
  }

  async createConversation(
    agentId: string,
    agentDefinitionId: string,
    llmModel?: string | null,
    useXmlToolFormat?: boolean,
  ): Promise<AgentConversation> {
    return this.provider.createConversation(
      agentId,
      agentDefinitionId,
      llmModel,
      useXmlToolFormat,
    );
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
    if (options.tokenCount !== undefined && options.tokenCount !== null && options.tokenCount < 0) {
      throw new Error("token_count cannot be negative");
    }
    if (options.cost !== undefined && options.cost !== null && options.cost < 0) {
      throw new Error("cost cannot be negative");
    }
    return this.provider.storeMessage(options);
  }

  async getAgentConversationHistory(options: {
    agentDefinitionId: string;
    page?: number;
    pageSize?: number;
    searchQuery?: string | null;
  }): Promise<ConversationHistory> {
    return this.provider.getAgentConversationHistory(options);
  }

  async getRawConversationHistory(options: {
    page?: number;
    pageSize?: number;
    searchQuery?: string | null;
    agentDefinitionId?: string | null;
  }): Promise<ConversationHistory> {
    return this.provider.getRawConversationHistory(options);
  }

  async updateLastUserMessageUsage(
    agentId: string,
    tokenCount: number,
    cost: number,
  ): Promise<AgentConversation> {
    if (tokenCount < 0) {
      throw new Error("token_count cannot be negative");
    }
    if (cost < 0) {
      throw new Error("cost cannot be negative");
    }
    return this.provider.updateLastUserMessageUsage(agentId, tokenCount, cost);
  }
}

export const persistenceProxy = new PersistenceProxy();
