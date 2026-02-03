import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { SqlPersistenceProvider } from "../../../../src/agent-conversation/providers/sql-persistence-provider.js";
import { AgentConversation } from "../../../../src/agent-conversation/domain/models.js";

const cleanupConversation = async (provider: SqlPersistenceProvider, agentId: string) => {
  const sqlConv = await provider.conversationRepository.findByAgentId(agentId);
  if (sqlConv) {
    await provider.conversationRepository.delete({ where: { id: sqlConv.id } });
  }
};

describe("SqlPersistenceProvider", () => {
  it("creates conversations", async () => {
    const provider = new SqlPersistenceProvider();
    const agentId = randomUUID();
    const agentDefinitionId = "sql_test_def";
    const llmModel = "claude-3";

    const conversation = await provider.createConversation(
      agentId,
      agentDefinitionId,
      llmModel,
    );

    expect(conversation).toBeInstanceOf(AgentConversation);
    expect(conversation.agentId).toBe(agentId);
    expect(conversation.agentDefinitionId).toBe(agentDefinitionId);
    expect(conversation.llmModel).toBe(llmModel);
    expect(conversation.useXmlToolFormat).toBe(false);
    expect(conversation.createdAt).toBeInstanceOf(Date);
    expect(conversation.messages).toHaveLength(0);

    await cleanupConversation(provider, agentId);
  });

  it("creates conversations with XML tool format", async () => {
    const provider = new SqlPersistenceProvider();
    const agentId = randomUUID();
    const agentDefinitionId = "sql_test_def_xml";
    const llmModel = "claude-3-xml";

    const conversation = await provider.createConversation(
      agentId,
      agentDefinitionId,
      llmModel,
      true,
    );

    expect(conversation).toBeInstanceOf(AgentConversation);
    expect(conversation.useXmlToolFormat).toBe(true);

    const sqlConv = await provider.conversationRepository.findByAgentId(agentId);
    expect(sqlConv).not.toBeNull();
    expect(sqlConv?.useXmlToolFormat).toBe(true);

    await cleanupConversation(provider, agentId);
  });

  it("stores messages", async () => {
    const provider = new SqlPersistenceProvider();
    const agentId = randomUUID();
    const agentDefinitionId = "sql_sample_def";

    const conversation = await provider.createConversation(
      agentId,
      agentDefinitionId,
      "gpt-4",
      false,
    );

    const updated = await provider.storeMessage({
      agentId: conversation.agentId,
      role: "user",
      message: "Hello, SQL!",
      originalMessage: "Original user message",
      contextPaths: ["/path/to/context1"],
      tokenCount: 100,
      cost: 0.01,
    });

    expect(updated.messages).toHaveLength(1);
    const msg = updated.messages[0]!;
    expect(msg.role).toBe("user");
    expect(msg.message).toBe("Hello, SQL!");
    expect(msg.originalMessage).toBe("Original user message");
    expect(msg.contextPaths).toEqual(["/path/to/context1"]);
    expect(msg.tokenCount).toBe(100);
    expect(msg.cost).toBe(0.01);
    expect(msg.timestamp).toBeInstanceOf(Date);

    await cleanupConversation(provider, agentId);
  });

  it("gets conversation history", async () => {
    const provider = new SqlPersistenceProvider();
    const agentDefinitionId = "sql_pagination_def";
    const agentIds: string[] = [];

    for (let i = 0; i < 5; i += 1) {
      const agentId = randomUUID();
      agentIds.push(agentId);
      const conv = await provider.createConversation(agentId, agentDefinitionId);
      await provider.storeMessage({
        agentId: conv.agentId,
        role: "user",
        message: `Message ${i + 1}`,
      });
    }

    const history = await provider.getAgentConversationHistory({
      agentDefinitionId,
      page: 2,
      pageSize: 2,
    });

    expect(history.totalConversations).toBe(5);
    expect(history.totalPages).toBe(3);
    expect(history.currentPage).toBe(2);
    expect(history.conversations).toHaveLength(2);

    for (const agentId of agentIds) {
      await cleanupConversation(provider, agentId);
    }
  });

  it("updates last user message usage", async () => {
    const provider = new SqlPersistenceProvider();
    const agentId = randomUUID();
    const agentDefinitionId = "sql_sample_def";

    await provider.createConversation(agentId, agentDefinitionId);
    await provider.storeMessage({
      agentId,
      role: "user",
      message: "User message to update",
    });

    const updated = await provider.updateLastUserMessageUsage(agentId, 20, 0.02);
    expect(updated.messages).toHaveLength(1);
    expect(updated.messages[0]?.tokenCount).toBe(20);
    expect(updated.messages[0]?.cost).toBe(0.02);

    await cleanupConversation(provider, agentId);
  });
});
