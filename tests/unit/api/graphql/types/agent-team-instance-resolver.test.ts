import "reflect-metadata";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockManager = vi.hoisted(() => ({
  getTeamInstance: vi.fn(),
  listActiveInstances: vi.fn(),
  createTeamInstance: vi.fn(),
  terminateTeamInstance: vi.fn(),
}));

const mockIngressService = vi.hoisted(() => ({
  dispatchUserMessage: vi.fn(),
}));

vi.mock("../../../../../src/agent-team-execution/services/agent-team-instance-manager.js", () => ({
  AgentTeamInstanceManager: {
    getInstance: () => mockManager,
  },
}));

vi.mock("../../../../../src/distributed/bootstrap/default-distributed-runtime-composition.js", () => ({
  getDefaultTeamCommandIngressService: () => mockIngressService,
}));

import { AgentTeamInstanceResolver } from "../../../../../src/api/graphql/types/agent-team-instance.js";

describe("AgentTeamInstanceResolver sendMessageToTeam", () => {
  beforeEach(() => {
    mockManager.getTeamInstance.mockReset();
    mockManager.listActiveInstances.mockReset();
    mockManager.createTeamInstance.mockReset();
    mockManager.terminateTeamInstance.mockReset();
    mockIngressService.dispatchUserMessage.mockReset();
  });

  it("dispatches to ingress for existing team using targetMemberName", async () => {
    mockIngressService.dispatchUserMessage.mockResolvedValue({
      teamId: "team-1",
      teamRunId: "run-1",
      runVersion: 2,
    });

    const resolver = new AgentTeamInstanceResolver();
    const result = await resolver.sendMessageToTeam({
      teamId: "team-1",
      targetMemberName: "helper",
      userInput: {
        content: "hello team",
        contextFiles: null,
      },
    } as any);

    expect(result).toMatchObject({
      success: true,
      teamId: "team-1",
    });
    expect(mockIngressService.dispatchUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "team-1",
        targetMemberName: "helper",
      }),
    );
    const dispatchInput = mockIngressService.dispatchUserMessage.mock.calls[0]?.[0];
    expect(dispatchInput.userMessage.content).toBe("hello team");
    expect(mockManager.createTeamInstance).not.toHaveBeenCalled();
  });

  it("lazy-creates team then dispatches via ingress", async () => {
    mockManager.createTeamInstance.mockResolvedValue("team-new");
    mockIngressService.dispatchUserMessage.mockResolvedValue({
      teamId: "team-new",
      teamRunId: "run-9",
      runVersion: 1,
    });

    const resolver = new AgentTeamInstanceResolver();
    const result = await resolver.sendMessageToTeam({
      teamDefinitionId: "def-1",
      memberConfigs: [
        {
          memberName: "leader",
          agentDefinitionId: "agent-1",
          llmModelIdentifier: "model-a",
          autoExecuteTools: true,
        },
      ],
      userInput: {
        content: "start",
        contextFiles: null,
      },
    } as any);

    expect(result).toMatchObject({
      success: true,
      teamId: "team-new",
    });
    expect(mockManager.createTeamInstance).toHaveBeenCalledTimes(1);
    expect(mockIngressService.dispatchUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "team-new",
      }),
    );
  });
});
