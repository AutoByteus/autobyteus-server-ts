import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { SqlAgentConversationRepository } from "../../../../src/agent-conversation/repositories/sql/agent-conversation-repository.js";
import { SqlAgentConversationMessageRepository } from "../../../../src/agent-conversation/repositories/sql/agent-conversation-message-repository.js";
import { PrismaConversationConverter } from "../../../../src/agent-conversation/converters/prisma-converter.js";

describe("SqlAgentConversationMessageRepository", () => {
  const conversationRepo = new SqlAgentConversationRepository();
  const messageRepo = new SqlAgentConversationMessageRepository();

  const createConversation = async () => {
    return conversationRepo.createAgentConversation({
      agentId: randomUUID(),
      agentDefinitionId: "sample_def_for_messages",
    });
  };

  it("creates messages", async () => {
    const conversation = await createConversation();
    const messageData = {
      agentConversationId: conversation.id,
      role: "user",
      message: "Sample message",
      tokenCount: 100,
      cost: 0.05,
      originalMessage: "OG",
      contextPaths: ["/path/1"],
    };

    const result = await messageRepo.createMessage(
      PrismaConversationConverter.toMessageCreateInput(messageData),
    );

    expect(result).toBeTruthy();
    expect(result.id).toBeDefined();
    expect(result.agentConversationId).toBe(messageData.agentConversationId);
    expect(result.role).toBe(messageData.role);
    expect(result.tokenCount).toBe(messageData.tokenCount);
    expect(result.cost).toBe(messageData.cost);
    expect(result.originalMessage).toBe(messageData.originalMessage);
    expect(JSON.parse(result.contextPaths ?? "[]")).toEqual(messageData.contextPaths);
    expect(result.timestamp).toBeInstanceOf(Date);
  });

  it("gets messages by conversation id", async () => {
    const conversation = await createConversation();
    await messageRepo.createMessage(
      PrismaConversationConverter.toMessageCreateInput({
        agentConversationId: conversation.id,
        role: "user",
        message: "msg1",
      }),
    );
    await messageRepo.createMessage(
      PrismaConversationConverter.toMessageCreateInput({
        agentConversationId: conversation.id,
        role: "assistant",
        message: "msg2",
      }),
    );

    const messages = await messageRepo.getMessagesByAgentConversationId(conversation.id);
    expect(messages).toHaveLength(2);
    expect(messages[0]?.message).toBe("msg1");
    expect(messages[1]?.message).toBe("msg2");
  });

  it("updates token usage", async () => {
    const conversation = await createConversation();
    const msg = await messageRepo.createMessage(
      PrismaConversationConverter.toMessageCreateInput({
        agentConversationId: conversation.id,
        role: "user",
        message: "msg",
      }),
    );

    const updated = await messageRepo.updateTokenUsage(msg.id, 50, 0.5);
    expect(updated).not.toBeNull();
    expect(updated?.id).toBe(msg.id);
    expect(updated?.tokenCount).toBe(50);
    expect(updated?.cost).toBe(0.5);
  });
});
