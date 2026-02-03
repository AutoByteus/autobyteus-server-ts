import { beforeEach, describe, expect, it, vi } from "vitest";
import { CreateAgentConversationRecordProcessor } from "../../../../src/agent-customization/lifecycle/create-agent-conversation-record-processor.js";
import { AgentConfig, AgentContext, AgentRuntimeState, LifecycleEvent } from "autobyteus-ts";
import { BaseLLM } from "autobyteus-ts/llm/base.js";
import { LLMModel } from "autobyteus-ts/llm/models.js";
import { LLMProvider } from "autobyteus-ts/llm/providers.js";
import { LLMConfig } from "autobyteus-ts/llm/utils/llm-config.js";
import { CompleteResponse, ChunkResponse } from "autobyteus-ts/llm/utils/response-types.js";
import { LLMUserMessage } from "autobyteus-ts/llm/user-message.js";

const mockPersistenceProxy = vi.hoisted(() => ({
  createConversation: vi.fn(),
}));

vi.mock("../../../../src/agent-conversation/providers/persistence-proxy.js", () => {
  class MockPersistenceProxy {
    createConversation = mockPersistenceProxy.createConversation;
  }

  return {
    PersistenceProxy: MockPersistenceProxy,
  };
});

class MockLLM extends BaseLLM {
  constructor(modelName: string) {
    const llmModel = new LLMModel({
      name: modelName,
      value: modelName,
      canonicalName: modelName,
      provider: LLMProvider.OPENAI,
      defaultConfig: new LLMConfig(),
    });

    super(llmModel, new LLMConfig({ systemMessage: "You are a test agent." }));
  }

  protected async _sendUserMessageToLLM(
    _userMessage: LLMUserMessage,
    _kwargs: Record<string, unknown>,
  ): Promise<CompleteResponse> {
    return new CompleteResponse({ content: "mock response" });
  }

  protected async *_streamUserMessageToLLM(
    _userMessage: LLMUserMessage,
    _kwargs: Record<string, unknown>,
  ): AsyncGenerator<ChunkResponse, void, unknown> {
    yield new ChunkResponse({ content: "mock stream response", is_complete: true });
  }
}

const buildAgentContext = (): AgentContext => {
  const initialData = { agent_definition_id: "test_definition_123" };

  const config = new AgentConfig(
    "test_agent",
    "tester",
    "A test agent",
    new MockLLM("test-llm-v1"),
    "You are a test agent.",
    [],
    true,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    initialData,
  );

  const state = new AgentRuntimeState("agent_xyz_789", null, { ...initialData });
  state.llmInstance = config.llmInstance;

  return new AgentContext("agent_xyz_789", config, state);
};

describe("CreateAgentConversationRecordProcessor", () => {
  beforeEach(() => {
    mockPersistenceProxy.createConversation.mockReset();
  });

  it("processes successfully and creates conversation record", async () => {
    const processor = new CreateAgentConversationRecordProcessor();
    const context = buildAgentContext();

    await processor.process(context, {});

    expect(mockPersistenceProxy.createConversation).toHaveBeenCalledWith(
      "agent_xyz_789",
      "test_definition_123",
      "test-llm-v1",
      false,
    );
  });

  it("logs errors when persistence fails", async () => {
    const processor = new CreateAgentConversationRecordProcessor();
    const context = buildAgentContext();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockPersistenceProxy.createConversation.mockRejectedValue(new Error("DB is on fire"));

    await processor.process(context, {});

    expect(mockPersistenceProxy.createConversation).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("CRITICAL - Failed to create persistence record"),
    );
    errorSpy.mockRestore();
  });

  it("exposes AGENT_READY event", () => {
    const processor = new CreateAgentConversationRecordProcessor();
    expect(processor.event).toBe(LifecycleEvent.AGENT_READY);
  });
});
