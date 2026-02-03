import { describe, expect, it, vi } from "vitest";
import { UserInputPersistenceProcessor } from "../../../../../src/agent-customization/processors/persistence/user-input-persistence-processor.js";
import { AgentInputUserMessage } from "autobyteus-ts/agent/message/agent-input-user-message.js";
import { ContextFile } from "autobyteus-ts/agent/message/context-file.js";
import { UserMessageReceivedEvent } from "autobyteus-ts/agent/events/agent-events.js";
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
describe("UserInputPersistenceProcessor", () => {
    it("persists user input with context files", async () => {
        const processor = new UserInputPersistenceProcessor();
        const context = { agentId: "agent_abc_789" };
        const inputToProcess = new AgentInputUserMessage("This might be a modified message.");
        const originalInput = new AgentInputUserMessage("This is the original user requirement.", undefined, [new ContextFile("src/main.py"), new ContextFile("/tmp/data.csv")]);
        const triggeringEvent = new UserMessageReceivedEvent(originalInput);
        const result = await processor.process(inputToProcess, context, triggeringEvent);
        expect(result).toBe(inputToProcess);
        expect(mockPersistenceProxy.storeMessage).toHaveBeenCalledWith({
            agentId: "agent_abc_789",
            role: "user",
            message: inputToProcess.content,
            originalMessage: originalInput.content,
            contextPaths: ["src/main.py", "/tmp/data.csv"],
            reasoning: null,
            imageUrls: null,
            audioUrls: null,
            videoUrls: null,
        });
    });
    it("persists user input without context files", async () => {
        const processor = new UserInputPersistenceProcessor();
        const context = { agentId: "agent_abc_789" };
        const inputToProcess = new AgentInputUserMessage("A simple message.");
        const originalInput = new AgentInputUserMessage("A simple message.");
        const triggeringEvent = new UserMessageReceivedEvent(originalInput);
        await processor.process(inputToProcess, context, triggeringEvent);
        expect(mockPersistenceProxy.storeMessage).toHaveBeenCalledWith({
            agentId: "agent_abc_789",
            role: "user",
            message: inputToProcess.content,
            originalMessage: originalInput.content,
            contextPaths: [],
            reasoning: null,
            imageUrls: null,
            audioUrls: null,
            videoUrls: null,
        });
    });
    it("logs when persistence fails", async () => {
        const processor = new UserInputPersistenceProcessor();
        const context = { agentId: "agent_abc_789" };
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });
        mockPersistenceProxy.storeMessage.mockRejectedValueOnce(new Error("DB write failed"));
        const inputToProcess = new AgentInputUserMessage("A message.");
        const triggeringEvent = new UserMessageReceivedEvent(inputToProcess);
        const result = await processor.process(inputToProcess, context, triggeringEvent);
        expect(result).toBe(inputToProcess);
        expect(mockPersistenceProxy.storeMessage).toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to persist 'user' message"));
        errorSpy.mockRestore();
    });
    it("exposes name", () => {
        expect(UserInputPersistenceProcessor.getName()).toBe("UserInputPersistenceProcessor");
    });
});
