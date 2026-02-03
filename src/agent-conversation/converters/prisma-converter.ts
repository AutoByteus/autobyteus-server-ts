import type {
  AgentConversation as PrismaAgentConversation,
  AgentConversationMessage as PrismaAgentConversationMessage,
  Prisma,
} from "@prisma/client";
import { AgentConversation, Message } from "../domain/models.js";

const parseJsonList = (value: string | null | undefined): string[] => {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

const toJsonString = (value: string[] | null | undefined): string | null => {
  if (!value || value.length === 0) {
    return null;
  }
  return JSON.stringify(value);
};

export class PrismaConversationConverter {
  static toDomainMessage(sqlMessage: PrismaAgentConversationMessage): Message {
    return new Message({
      role: sqlMessage.role,
      message: sqlMessage.message,
      timestamp: sqlMessage.timestamp,
      messageId: String(sqlMessage.id),
      originalMessage: sqlMessage.originalMessage ?? null,
      contextPaths: parseJsonList(sqlMessage.contextPaths),
      tokenCount: sqlMessage.tokenCount ?? null,
      cost: sqlMessage.cost ?? null,
      reasoning: sqlMessage.reasoning ?? null,
      imageUrls: parseJsonList(sqlMessage.imageUrls),
      audioUrls: parseJsonList(sqlMessage.audioUrls),
      videoUrls: parseJsonList(sqlMessage.videoUrls),
    });
  }

  static toDomainConversation(
    sqlConversation: PrismaAgentConversation,
    messages: PrismaAgentConversationMessage[],
  ): AgentConversation {
    const domainMessages = messages.map((message) => this.toDomainMessage(message));
    return new AgentConversation({
      agentId: sqlConversation.agentId,
      agentDefinitionId: sqlConversation.agentDefinitionId,
      createdAt: sqlConversation.createdAt,
      messages: domainMessages,
      llmModel: sqlConversation.llmModel ?? null,
      useXmlToolFormat: sqlConversation.useXmlToolFormat,
    });
  }

  static toConversationCreateInput(options: {
    agentId: string;
    agentDefinitionId: string;
    llmModel?: string | null;
    useXmlToolFormat?: boolean;
  }): Prisma.AgentConversationCreateInput {
    return {
      agentId: options.agentId,
      agentDefinitionId: options.agentDefinitionId,
      llmModel: options.llmModel ?? undefined,
      useXmlToolFormat: options.useXmlToolFormat ?? false,
    };
  }

  static toMessageCreateInput(options: {
    agentConversationId: number;
    role: string;
    message: string;
    originalMessage?: string | null;
    contextPaths?: string[] | null;
    tokenCount?: number | null;
    cost?: number | null;
    reasoning?: string | null;
    imageUrls?: string[] | null;
    audioUrls?: string[] | null;
    videoUrls?: string[] | null;
  }): Prisma.AgentConversationMessageCreateInput {
    return {
      conversation: { connect: { id: options.agentConversationId } },
      role: options.role,
      message: options.message,
      originalMessage: options.originalMessage ?? undefined,
      contextPaths: toJsonString(options.contextPaths),
      tokenCount: options.tokenCount ?? undefined,
      cost: options.cost ?? undefined,
      reasoning: options.reasoning ?? undefined,
      imageUrls: toJsonString(options.imageUrls),
      audioUrls: toJsonString(options.audioUrls),
      videoUrls: toJsonString(options.videoUrls),
    };
  }
}
