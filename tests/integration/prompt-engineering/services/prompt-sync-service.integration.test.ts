import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "crypto";
import { PromptSyncService } from "../../../../src/prompt-engineering/services/prompt-sync-service.js";
import { PromptService } from "../../../../src/prompt-engineering/services/prompt-service.js";

const makeName = (prefix: string) => `${prefix}-${randomUUID()}`;

const setEnv = (key: string, value: string | undefined) => {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
};

describe("PromptSyncService helpers", () => {
  it("parses suitable_for_models into a set", () => {
    const service = new PromptSyncService();
    expect(service.parseSuitableForModels(null)).toEqual(new Set());
    expect(service.parseSuitableForModels("")).toEqual(new Set());
    expect(service.parseSuitableForModels("Claude 3.7")).toEqual(new Set(["Claude 3.7"]));
    expect(service.parseSuitableForModels("Claude 3.7, ChatGPT-4001, 01-mini")).toEqual(
      new Set(["Claude 3.7", "ChatGPT-4001", "01-mini"]),
    );
    expect(service.parseSuitableForModels(" Claude 3.7 , ChatGPT-4001 ")).toEqual(
      new Set(["Claude 3.7", "ChatGPT-4001"]),
    );
    expect(service.parseSuitableForModels("Claude 3.7,,ChatGPT-4001")).toEqual(
      new Set(["Claude 3.7", "ChatGPT-4001"]),
    );
  });

  it("detects intersections between model lists", () => {
    const service = new PromptSyncService();
    expect(service.modelsIntersect(null, "Claude 3.7")).toBe(false);
    expect(service.modelsIntersect("Claude 3.7", null)).toBe(false);
    expect(service.modelsIntersect("", "Claude 3.7")).toBe(false);
    expect(service.modelsIntersect("Claude 3.7", "")).toBe(false);
    expect(service.modelsIntersect("Claude 3.7", "ChatGPT-4001")).toBe(false);
    expect(service.modelsIntersect("Claude 3.7, Claude 3.5", "ChatGPT-4001, 01-mini")).toBe(false);
    expect(service.modelsIntersect("Claude 3.7", "Claude 3.7")).toBe(true);
    expect(service.modelsIntersect("Claude 3.7, ChatGPT-4001", "ChatGPT-4001, 01-mini")).toBe(true);
    expect(service.modelsIntersect("Claude 3.7, ChatGPT-4001", "Claude 3.7, 01-mini")).toBe(true);
    expect(service.modelsIntersect("Claude 3.7", " Claude 3.7 ")).toBe(true);
    expect(service.modelsIntersect("CLAUDE 3.7", "claude 3.7")).toBe(false);
  });
});

describe("PromptSyncService sync logic (DB + mocked fetch)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("updates existing prompt when models intersect", async () => {
    const promptService = new PromptService();
    const promptSyncService = new PromptSyncService(promptService);
    const name = makeName("Test Prompt");

    setEnv("AUTOBYTEUS_MARKETPLACE_HOST", "http://fake-market.com");

    const marketplacePrompt = {
      name,
      category: "Test Category",
      prompt_content: "New content from marketplace.",
      suitable_for_models: "claude-3, gpt-4o",
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ prompts: [marketplacePrompt] }),
      }),
    );

    const existing = await promptService.createPrompt({
      name,
      category: "Test Category",
      promptContent: "Old local content.",
      suitableForModels: "claude-3, gemini-pro",
    });

    const result = await promptSyncService.syncPrompts();
    expect(result).toBe(true);

    const allPrompts = await promptService.findAllByNameAndCategory(name, "Test Category");
    expect(allPrompts.length).toBe(1);

    const updated = await promptService.getPromptById(existing.id ?? "");
    expect(updated.promptContent).toBe("New content from marketplace.");
    expect(updated.suitableForModels).toBe("claude-3, gpt-4o");
  });

  it("creates a new prompt when models do not intersect", async () => {
    const promptService = new PromptService();
    const promptSyncService = new PromptSyncService(promptService);
    const name = makeName("Test Prompt");

    setEnv("AUTOBYTEUS_MARKETPLACE_HOST", "http://fake-market.com");

    const marketplacePrompt = {
      name,
      category: "Test Category",
      prompt_content: "New content for new model.",
      suitable_for_models: "gpt-4o, gpt-5",
      description: "A test description",
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ prompts: [marketplacePrompt] }),
      }),
    );

    const existing = await promptService.createPrompt({
      name,
      category: "Test Category",
      promptContent: "Existing content.",
      suitableForModels: "claude-3, gemini-pro",
    });

    const result = await promptSyncService.syncPrompts();
    expect(result).toBe(true);

    const allPrompts = await promptService.findAllByNameAndCategory(name, "Test Category");
    expect(allPrompts.length).toBe(2);

    const original = await promptService.getPromptById(existing.id ?? "");
    expect(original.promptContent).toBe("Existing content.");
    expect(original.suitableForModels).toBe("claude-3, gemini-pro");

    const newPrompt = allPrompts.find((prompt) => prompt.id !== existing.id);
    expect(newPrompt?.promptContent).toBe("New content for new model.");
    expect(newPrompt?.suitableForModels).toBe("gpt-4o, gpt-5");
    expect(newPrompt?.version).toBe(1);
  });

  it("creates a new prompt when model lists are empty", async () => {
    const promptService = new PromptService();
    const promptSyncService = new PromptSyncService(promptService);
    const name = makeName("Test Prompt");

    setEnv("AUTOBYTEUS_MARKETPLACE_HOST", "http://fake-market.com");

    const marketplacePrompt = {
      name,
      category: "Test Category",
      prompt_content: "Content from marketplace with empty models.",
      suitable_for_models: "",
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ prompts: [marketplacePrompt] }),
      }),
    );

    await promptService.createPrompt({
      name,
      category: "Test Category",
      promptContent: "Local content with no models.",
      suitableForModels: null,
    });

    const initialPrompts = await promptService.findAllByNameAndCategory(
      name,
      "Test Category",
    );
    expect(initialPrompts.length).toBe(1);

    const result = await promptSyncService.syncPrompts();
    expect(result).toBe(true);

    const allPrompts = await promptService.findAllByNameAndCategory(name, "Test Category");
    expect(allPrompts.length).toBe(2);
  });
});

describe("PromptSyncService end-to-end", () => {
  const shouldRun =
    process.env.AUTOBYTEUS_MARKETPLACE_HOST === "http://localhost:8020" &&
    process.env.AUTOBYTEUS_PROMPT_SYNC_LANGUAGE;

  const testFn = shouldRun ? it : it.skip;

  testFn("syncs prompts from live marketplace when configured", async () => {
    const service = new PromptSyncService();
    const result = await service.syncPrompts();
    expect(result).toBe(true);
  });
});
