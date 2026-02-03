import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersistenceProxy } from "../../../../src/agent-conversation/providers/persistence-proxy.js";
import { SqlPersistenceProvider } from "../../../../src/agent-conversation/providers/sql-persistence-provider.js";
import { PersistenceProviderRegistry } from "../../../../src/agent-conversation/providers/persistence-provider-registry.js";
describe("PersistenceProxy", () => {
    const originalProvider = process.env.PERSISTENCE_PROVIDER;
    beforeEach(() => {
        delete process.env.PERSISTENCE_PROVIDER;
    });
    afterEach(() => {
        if (originalProvider === undefined) {
            delete process.env.PERSISTENCE_PROVIDER;
        }
        else {
            process.env.PERSISTENCE_PROVIDER = originalProvider;
        }
    });
    it("uses SqlPersistenceProvider by default", () => {
        const proxy = new PersistenceProxy();
        const provider = proxy.provider;
        expect(provider).toBeInstanceOf(SqlPersistenceProvider);
    });
    it("uses SqlPersistenceProvider for sqlite/postgresql", () => {
        process.env.PERSISTENCE_PROVIDER = "postgresql";
        let proxy = new PersistenceProxy();
        let provider = proxy.provider;
        expect(provider).toBeInstanceOf(SqlPersistenceProvider);
        process.env.PERSISTENCE_PROVIDER = "sqlite";
        proxy = new PersistenceProxy();
        provider = proxy.provider;
        expect(provider).toBeInstanceOf(SqlPersistenceProvider);
    });
    it("throws for unsupported provider", () => {
        process.env.PERSISTENCE_PROVIDER = "unsupported";
        const proxy = new PersistenceProxy();
        expect(() => proxy.provider).toThrow(/Unsupported persistence provider/i);
    });
    it("throws when provider initialization fails", () => {
        class BadProvider {
            constructor() {
                throw new Error("Initialization Failed");
            }
            async createConversation() {
                return {};
            }
            async storeMessage() {
                return {};
            }
            async getAgentConversationHistory() {
                return { conversations: [], totalConversations: 0, totalPages: 0, currentPage: 1 };
            }
            async getRawConversationHistory() {
                return { conversations: [], totalConversations: 0, totalPages: 0, currentPage: 1 };
            }
            async updateLastUserMessageUsage() {
                return {};
            }
        }
        const registry = PersistenceProviderRegistry.getInstance();
        registry.registerProvider("bad", BadProvider);
        process.env.PERSISTENCE_PROVIDER = "bad";
        const proxy = new PersistenceProxy();
        expect(() => proxy.provider).toThrow(/Initialization Failed/);
    });
    it("delegates createConversation", async () => {
        const proxy = new PersistenceProxy();
        const provider = proxy.provider;
        const spy = vi
            .spyOn(provider, "createConversation")
            .mockResolvedValue({});
        const result = await proxy.createConversation("agent", "def", "model", true);
        expect(spy).toHaveBeenCalledWith("agent", "def", "model", true);
        expect(result).toEqual({});
    });
    it("delegates storeMessage", async () => {
        const proxy = new PersistenceProxy();
        const provider = proxy.provider;
        const spy = vi
            .spyOn(provider, "storeMessage")
            .mockResolvedValue({});
        const result = await proxy.storeMessage({
            agentId: "agent",
            role: "user",
            message: "Hello",
            tokenCount: 10,
            cost: 0.05,
            originalMessage: "Hello there",
            contextPaths: ["/path/to/file"],
        });
        expect(spy).toHaveBeenCalledWith({
            agentId: "agent",
            role: "user",
            message: "Hello",
            tokenCount: 10,
            cost: 0.05,
            originalMessage: "Hello there",
            contextPaths: ["/path/to/file"],
        });
        expect(result).toEqual({});
    });
    it("delegates history retrieval", async () => {
        const proxy = new PersistenceProxy();
        const provider = proxy.provider;
        const mockHistory = {
            conversations: [],
            totalConversations: 0,
            totalPages: 0,
            currentPage: 1,
        };
        const spy = vi
            .spyOn(provider, "getAgentConversationHistory")
            .mockResolvedValue(mockHistory);
        const result = await proxy.getAgentConversationHistory({
            agentDefinitionId: "def",
            page: 1,
            pageSize: 10,
        });
        expect(spy).toHaveBeenCalled();
        expect(result).toEqual(mockHistory);
    });
    it("delegates updateLastUserMessageUsage", async () => {
        const proxy = new PersistenceProxy();
        const provider = proxy.provider;
        const spy = vi
            .spyOn(provider, "updateLastUserMessageUsage")
            .mockResolvedValue({});
        const result = await proxy.updateLastUserMessageUsage("agent", 25, 0.025);
        expect(spy).toHaveBeenCalledWith("agent", 25, 0.025);
        expect(result).toEqual({});
    });
});
