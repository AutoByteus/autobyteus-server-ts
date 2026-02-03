import { describe, expect, it, vi } from "vitest";
import { AssistantResponsePersistenceProcessor } from "../../../../../src/agent-customization/processors/persistence/assistant-response-persistence-processor.js";
import { LLMCompleteResponseReceivedEvent } from "autobyteus-ts/agent/events/agent-events.js";
import { CompleteResponse } from "autobyteus-ts/llm/utils/response-types.js";
const mockPersistenceProxy = vi.hoisted(() => ({
    storeMessage: vi.fn(),
}));
vi.mock("../../../../../src/agent-conversation/providers/persistence-proxy.js", () => {
    class MockPersistenceProxy {
        storeMessage = mockPersistenceProxy.storeMessage;
    }
    return {
        PersistenceProxy: MockPersistenceProxy,
    };
});
describe("AssistantResponsePersistenceProcessor", () => {
    it("persists response with token usage", async () => {
        const processor = new AssistantResponsePersistenceProcessor();
        const context = { agentId: "agent_abc_123" };
        const tokenUsage = {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
            prompt_cost: 0.001,
            completion_cost: 0.002,
            total_cost: 0.003,
        };
        const completeResponse = new CompleteResponse({
            content: "Final assistant response.",
            usage: tokenUsage,
            reasoning: "The user asked for a summary.",
            image_urls: ["http://image.com/1.png"],
        });
        const triggeringEvent = new LLMCompleteResponseReceivedEvent(completeResponse);
        const result = await processor.processResponse(completeResponse, context, triggeringEvent);
        expect(result).toBe(false);
        expect(mockPersistenceProxy.storeMessage).toHaveBeenCalledWith({
            agentId: "agent_abc_123",
            role: "assistant",
            message: "Final assistant response.",
            tokenCount: 50,
            cost: 0.002,
            reasoning: "The user asked for a summary.",
            imageUrls: ["http://image.com/1.png"],
            audioUrls: [],
            videoUrls: [],
        });
    });
    it("persists response without token usage", async () => {
        const processor = new AssistantResponsePersistenceProcessor();
        const context = { agentId: "agent_abc_123" };
        const completeResponse = new CompleteResponse({
            content: "Another response.",
            usage: null,
        });
        const triggeringEvent = new LLMCompleteResponseReceivedEvent(completeResponse);
        const result = await processor.processResponse(completeResponse, context, triggeringEvent);
        expect(result).toBe(false);
        expect(mockPersistenceProxy.storeMessage).toHaveBeenCalledWith({
            agentId: "agent_abc_123",
            role: "assistant",
            message: "Another response.",
            tokenCount: null,
            cost: null,
            reasoning: null,
            imageUrls: [],
            audioUrls: [],
            videoUrls: [],
        });
    });
    it("logs when persistence fails", async () => {
        const processor = new AssistantResponsePersistenceProcessor();
        const context = { agentId: "test_agent" };
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
        mockPersistenceProxy.storeMessage.mockRejectedValueOnce(new Error("Database is down"));
        const completeResponse = new CompleteResponse({
            content: "A response.",
        });
        const triggeringEvent = new LLMCompleteResponseReceivedEvent(completeResponse);
        const result = await processor.processResponse(completeResponse, context, triggeringEvent);
        expect(result).toBe(false);
        expect(mockPersistenceProxy.storeMessage).toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to persist assistant response"));
        errorSpy.mockRestore();
    });
    it("exposes name", () => {
        expect(AssistantResponsePersistenceProcessor.getName()).toBe("AssistantResponsePersistenceProcessor");
    });
});
