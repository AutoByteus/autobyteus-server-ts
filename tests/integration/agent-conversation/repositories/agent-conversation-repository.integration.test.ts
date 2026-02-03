import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { SqlAgentConversationRepository } from "../../../../src/agent-conversation/repositories/sql/agent-conversation-repository.js";

describe("SqlAgentConversationRepository", () => {
  const repo = new SqlAgentConversationRepository();

  it("creates agent conversations", async () => {
    const agentId = randomUUID();
    const agentDefinitionId = "test_def_sql";
    const llmModel = "test_model_sql";

    const conversation = await repo.createAgentConversation({
      agentId,
      agentDefinitionId,
      llmModel,
    });

    expect(conversation).toBeTruthy();
    expect(conversation.id).toBeDefined();
    expect(conversation.agentId).toBe(agentId);
    expect(conversation.agentDefinitionId).toBe(agentDefinitionId);
    expect(conversation.llmModel).toBe(llmModel);
    expect(conversation.useXmlToolFormat).toBe(false);
    expect(conversation.createdAt).toBeInstanceOf(Date);

    const retrieved = await repo.findById(conversation.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.useXmlToolFormat).toBe(false);

    await repo.delete({ where: { id: conversation.id } });
  });

  it("creates agent conversations with XML tool format", async () => {
    const agentId = randomUUID();
    const agentDefinitionId = "test_def_sql_xml";
    const llmModel = "test_model_sql_xml";

    const conversation = await repo.createAgentConversation({
      agentId,
      agentDefinitionId,
      llmModel,
      useXmlToolFormat: true,
    });

    expect(conversation).toBeTruthy();
    expect(conversation.useXmlToolFormat).toBe(true);

    const retrieved = await repo.findById(conversation.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.useXmlToolFormat).toBe(true);

    await repo.delete({ where: { id: conversation.id } });
  });

  it("finds conversations by agentId", async () => {
    const agentId = randomUUID();
    const conversation = await repo.createAgentConversation({
      agentId,
      agentDefinitionId: "test_def",
    });

    const retrieved = await repo.findByAgentId(agentId);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(conversation.id);

    await repo.delete({ where: { id: conversation.id } });
  });

  it("finds conversations by id", async () => {
    const agentId = randomUUID();
    const conversation = await repo.createAgentConversation({
      agentId,
      agentDefinitionId: "test_def",
    });

    const retrieved = await repo.findById(conversation.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.agentId).toBe(agentId);

    await repo.delete({ where: { id: conversation.id } });
  });

  it("paginates conversations by agent definition id", async () => {
    const agentDefinitionId = "paginated_def_sql";
    const conversationIds: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      await repo.createAgentConversation({
        agentId: randomUUID(),
        agentDefinitionId,
      }).then((conv) => conversationIds.push(conv.id));
    }

    const result = await repo.getConversationsByAgentDefinitionId({
      agentDefinitionId,
      page: 2,
      pageSize: 2,
    });

    expect(result.totalConversations).toBe(5);
    expect(result.totalPages).toBe(3);
    expect(result.currentPage).toBe(2);
    expect(result.conversations).toHaveLength(2);

    for (const id of conversationIds) {
      await repo.delete({ where: { id } });
    }
  });
});
