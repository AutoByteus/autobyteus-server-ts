import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRunHistoryService = vi.hoisted(() => ({
  listRunHistory: vi.fn(),
  getRunResumeConfig: vi.fn(),
}));

const mockRunProjectionService = vi.hoisted(() => ({
  getProjection: vi.fn(),
}));

const mockRunContinuationService = vi.hoisted(() => ({
  continueRun: vi.fn(),
}));

vi.mock("../../../../../src/run-history/services/run-history-service.js", () => ({
  getRunHistoryService: () => mockRunHistoryService,
}));

vi.mock("../../../../../src/run-history/services/run-projection-service.js", () => ({
  getRunProjectionService: () => mockRunProjectionService,
}));

vi.mock("../../../../../src/run-history/services/run-continuation-service.js", () => ({
  getRunContinuationService: () => mockRunContinuationService,
}));

import { RunHistoryResolver } from "../../../../../src/api/graphql/types/run-history.js";

describe("RunHistoryResolver", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates listRunHistory query to service", async () => {
    mockRunHistoryService.listRunHistory.mockResolvedValue([
      {
        workspaceRootPath: "/tmp/ws",
        workspaceName: "ws",
        agents: [],
      },
    ]);

    const resolver = new RunHistoryResolver();
    const result = await resolver.listRunHistory(5);

    expect(mockRunHistoryService.listRunHistory).toHaveBeenCalledWith(5);
    expect(result).toHaveLength(1);
  });

  it("delegates getRunProjection and getRunResumeConfig queries", async () => {
    mockRunProjectionService.getProjection.mockReturnValue({
      runId: "run-1",
      conversation: [],
      summary: null,
      lastActivityAt: null,
    });
    mockRunHistoryService.getRunResumeConfig.mockResolvedValue({
      runId: "run-1",
      isActive: false,
      manifestConfig: {
        agentDefinitionId: "agent-def-1",
        workspaceRootPath: "/tmp/ws",
        llmModelIdentifier: "model-x",
        llmConfig: null,
        autoExecuteTools: false,
        skillAccessMode: null,
      },
      editableFields: {
        llmModelIdentifier: true,
        llmConfig: true,
        autoExecuteTools: true,
        skillAccessMode: true,
        workspaceRootPath: false,
      },
    });

    const resolver = new RunHistoryResolver();
    const projection = await resolver.getRunProjection("run-1");
    const resume = await resolver.getRunResumeConfig("run-1");

    expect(projection.runId).toBe("run-1");
    expect(resume.runId).toBe("run-1");
  });

  it("returns success payload for continueRun mutation", async () => {
    mockRunContinuationService.continueRun.mockResolvedValue({
      runId: "run-1",
      ignoredConfigFields: ["llmModelIdentifier"],
    });

    const resolver = new RunHistoryResolver();
    const result = await resolver.continueRun({
      runId: "run-1",
      userInput: { content: "hello", contextFiles: null },
    } as any);

    expect(result).toMatchObject({
      success: true,
      runId: "run-1",
      ignoredConfigFields: ["llmModelIdentifier"],
    });
  });

  it("returns failure payload for continueRun mutation errors", async () => {
    mockRunContinuationService.continueRun.mockRejectedValue(new Error("restore failed"));

    const resolver = new RunHistoryResolver();
    const result = await resolver.continueRun({
      runId: "run-1",
      userInput: { content: "hello", contextFiles: null },
    } as any);

    expect(result.success).toBe(false);
    expect(result.runId).toBe("run-1");
    expect(result.message).toContain("restore failed");
  });
});
