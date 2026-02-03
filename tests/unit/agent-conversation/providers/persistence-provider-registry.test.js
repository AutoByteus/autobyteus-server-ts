import { describe, expect, it } from "vitest";
import { PersistenceProviderRegistry } from "../../../../src/agent-conversation/providers/persistence-provider-registry.js";
describe("PersistenceProviderRegistry", () => {
    it("registers default providers", () => {
        const registry = PersistenceProviderRegistry.getInstance();
        const providers = registry.getAvailableProviders();
        expect(providers).toContain("postgresql");
        expect(providers).toContain("sqlite");
    });
    it("registers new providers", () => {
        class DummyProvider {
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
        registry.registerProvider("dummy", DummyProvider);
        expect(registry.getAvailableProviders()).toContain("dummy");
        expect(registry.getProviderClass("dummy")).toBe(DummyProvider);
    });
    it("returns undefined for unknown providers", () => {
        const registry = PersistenceProviderRegistry.getInstance();
        expect(registry.getProviderClass("nonexistent")).toBeUndefined();
    });
});
