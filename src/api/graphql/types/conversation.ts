import { Arg, Field, Float, Int, ObjectType, Query, Resolver } from "type-graphql";
import type { ConversationHistory as DomainConversationHistory } from "../../../agent-conversation/domain/models.js";
import { persistenceProxy } from "../../../agent-conversation/providers/persistence-proxy.js";
import { ConversationHistoryConverter } from "../converters/conversation-converter.js";

@ObjectType()
export class Message {
  @Field(() => String, { nullable: true })
  messageId?: string | null;

  @Field(() => String)
  role!: string;

  @Field(() => String)
  message!: string;

  @Field(() => String)
  timestamp!: string;

  @Field(() => [String], { nullable: true })
  contextPaths?: string[] | null;

  @Field(() => String, { nullable: true })
  originalMessage?: string | null;

  @Field(() => Int, { nullable: true })
  tokenCount?: number | null;

  @Field(() => Float, { nullable: true })
  cost?: number | null;

  @Field(() => String, { nullable: true })
  reasoning?: string | null;

  @Field(() => [String], { nullable: true })
  imageUrls?: string[] | null;

  @Field(() => [String], { nullable: true })
  audioUrls?: string[] | null;

  @Field(() => [String], { nullable: true })
  videoUrls?: string[] | null;
}

@ObjectType()
export class AgentConversation {
  @Field(() => String)
  agentId!: string;

  @Field(() => String)
  agentDefinitionId!: string;

  @Field(() => String)
  createdAt!: string;

  @Field(() => [Message])
  messages!: Message[];

  @Field(() => String, { nullable: true })
  llmModel?: string | null;

  @Field(() => Boolean)
  useXmlToolFormat!: boolean;

  @Field(() => String, { nullable: true })
  agentName?: string | null;
}

@ObjectType()
export class ConversationHistory {
  @Field(() => [AgentConversation])
  conversations!: AgentConversation[];

  @Field(() => Int)
  totalConversations!: number;

  @Field(() => Int)
  totalPages!: number;

  @Field(() => Int)
  currentPage!: number;
}

@Resolver()
export class ConversationResolver {
  @Query(() => ConversationHistory)
  async getAgentConversationHistory(
    @Arg("agentDefinitionId", () => String) agentDefinitionId: string,
    @Arg("page", () => Int, { defaultValue: 1 }) page = 1,
    @Arg("pageSize", () => Int, { defaultValue: 10 }) pageSize = 10,
    @Arg("searchQuery", () => String, { nullable: true }) searchQuery?: string | null,
  ): Promise<ConversationHistory> {
    if (page < 1) {
      throw new Error("Page number must be at least 1.");
    }
    if (pageSize < 1 || pageSize > 100) {
      throw new Error("Page size must be between 1 and 100.");
    }

    const domainHistory: DomainConversationHistory =
      await persistenceProxy.getAgentConversationHistory({
        agentDefinitionId,
        page,
        pageSize,
        searchQuery: searchQuery ?? null,
      });
    return await ConversationHistoryConverter.toGraphql(domainHistory);
  }

  @Query(() => ConversationHistory)
  async getRawConversationHistory(
    @Arg("page", () => Int, { defaultValue: 1 }) page = 1,
    @Arg("pageSize", () => Int, { defaultValue: 10 }) pageSize = 10,
    @Arg("searchQuery", () => String, { nullable: true }) searchQuery?: string | null,
    @Arg("agentDefinitionId", () => String, { nullable: true })
    agentDefinitionId?: string | null,
  ): Promise<ConversationHistory> {
    if (page < 1) {
      throw new Error("Page number must be at least 1.");
    }
    if (pageSize < 1 || pageSize > 100) {
      throw new Error("Page size must be between 1 and 100.");
    }

    const domainHistory: DomainConversationHistory =
      await persistenceProxy.getRawConversationHistory({
        page,
        pageSize,
        searchQuery: searchQuery ?? null,
        agentDefinitionId: agentDefinitionId ?? null,
      });
    return await ConversationHistoryConverter.toGraphql(domainHistory);
  }
}
