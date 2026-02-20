import { describe, expect, it, vi } from "vitest";
import { TeamRunContinuationService } from "../../../src/run-history/services/team-run-continuation-service.js";

describe("TeamRunContinuationService", () => {
  it("dispatches message to active team without restore", async () => {
    const teamInstanceManager = {
      getTeamInstance: vi.fn(() => ({ teamId: "team-1" })),
      createTeamInstanceWithId: vi.fn(),
      terminateTeamInstance: vi.fn(),
    };
    const teamCommandIngressService = {
      dispatchUserMessage: vi.fn().mockResolvedValue({
        teamId: "team-1",
        teamRunId: "run-1",
        runVersion: 1,
      }),
    };
    const teamRunHistoryService = {
      getTeamRunResumeConfig: vi.fn(),
      onTeamEvent: vi.fn().mockResolvedValue(undefined),
    };
    const workspaceManager = {
      ensureWorkspaceByRootPath: vi.fn(),
    };

    const service = new TeamRunContinuationService({
      teamInstanceManager: teamInstanceManager as any,
      teamCommandIngressService: teamCommandIngressService as any,
      teamRunHistoryService: teamRunHistoryService as any,
      workspaceManager: workspaceManager as any,
      memoryDir: "/tmp/memory",
    });

    const result = await service.continueTeamRun({
      teamId: "team-1",
      targetMemberRouteKey: "coordinator",
      userInput: { content: "hello team", contextFiles: null } as any,
    });

    expect(result).toEqual({
      teamId: "team-1",
      restored: false,
    });
    expect(teamInstanceManager.createTeamInstanceWithId).not.toHaveBeenCalled();
    expect(teamCommandIngressService.dispatchUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        teamId: "team-1",
        targetMemberName: "coordinator",
      }),
    );
  });

  it("restores inactive team from manifest before dispatching", async () => {
    const teamInstanceManager = {
      getTeamInstance: vi.fn(() => null),
      createTeamInstanceWithId: vi.fn().mockResolvedValue("team-1"),
      terminateTeamInstance: vi.fn(),
    };
    const teamCommandIngressService = {
      dispatchUserMessage: vi.fn().mockResolvedValue({
        teamId: "team-1",
        teamRunId: "run-1",
        runVersion: 1,
      }),
    };
    const teamRunHistoryService = {
      getTeamRunResumeConfig: vi.fn().mockResolvedValue({
        teamId: "team-1",
        isActive: false,
        manifest: {
          teamId: "team-1",
          teamDefinitionId: "def-1",
          teamDefinitionName: "Classroom Team",
          coordinatorMemberRouteKey: "coordinator",
          runVersion: 1,
          createdAt: "2026-02-15T00:00:00.000Z",
          updatedAt: "2026-02-15T00:00:00.000Z",
          memberBindings: [
            {
              memberRouteKey: "coordinator",
              memberName: "Coordinator",
              memberAgentId: "member-1",
              agentDefinitionId: "agent-def-1",
              llmModelIdentifier: "model-a",
              autoExecuteTools: true,
              llmConfig: { temperature: 0.2 },
              workspaceRootPath: "/tmp/workspace-a",
              hostNodeId: "node-a",
            },
          ],
        },
      }),
      onTeamEvent: vi.fn().mockResolvedValue(undefined),
    };
    const workspaceManager = {
      ensureWorkspaceByRootPath: vi.fn().mockResolvedValue({ workspaceId: "ws-1" }),
    };

    const service = new TeamRunContinuationService({
      teamInstanceManager: teamInstanceManager as any,
      teamCommandIngressService: teamCommandIngressService as any,
      teamRunHistoryService: teamRunHistoryService as any,
      workspaceManager: workspaceManager as any,
      memoryDir: "/tmp/memory",
    });

    const result = await service.continueTeamRun({
      teamId: "team-1",
      targetMemberRouteKey: "coordinator",
      userInput: { content: "restore and continue", contextFiles: null } as any,
    });

    expect(result).toEqual({
      teamId: "team-1",
      restored: true,
    });
    expect(teamRunHistoryService.getTeamRunResumeConfig).toHaveBeenCalledWith("team-1");
    expect(workspaceManager.ensureWorkspaceByRootPath).toHaveBeenCalledWith("/tmp/workspace-a");
    expect(teamInstanceManager.createTeamInstanceWithId).toHaveBeenCalledWith(
      "team-1",
      "def-1",
      [
        {
          memberName: "Coordinator",
          agentDefinitionId: "agent-def-1",
          llmModelIdentifier: "model-a",
          autoExecuteTools: true,
          workspaceId: "ws-1",
          llmConfig: { temperature: 0.2 },
          memberRouteKey: "coordinator",
          memberAgentId: "member-1",
          memoryDir: "/tmp/memory",
        },
      ],
    );
  });

  it("validates required input content", async () => {
    const service = new TeamRunContinuationService({
      teamInstanceManager: {
        getTeamInstance: vi.fn(() => null),
        createTeamInstanceWithId: vi.fn(),
        terminateTeamInstance: vi.fn(),
      } as any,
      teamCommandIngressService: {
        dispatchUserMessage: vi.fn(),
      } as any,
      teamRunHistoryService: {
        getTeamRunResumeConfig: vi.fn(),
        onTeamEvent: vi.fn(),
      } as any,
      workspaceManager: {
        ensureWorkspaceByRootPath: vi.fn(),
      } as any,
      memoryDir: "/tmp/memory",
    });

    await expect(
      service.continueTeamRun({
        teamId: "team-1",
        userInput: { content: "   ", contextFiles: null } as any,
      }),
    ).rejects.toThrow("userInput.content is required");
  });

  it("rolls back restored runtime when dispatch fails", async () => {
    const teamInstanceManager = {
      getTeamInstance: vi.fn(() => null),
      createTeamInstanceWithId: vi.fn().mockResolvedValue("team-rollback"),
      terminateTeamInstance: vi.fn().mockResolvedValue(true),
    };
    const teamCommandIngressService = {
      dispatchUserMessage: vi.fn().mockRejectedValue(new Error("dispatch failed")),
    };
    const teamRunHistoryService = {
      getTeamRunResumeConfig: vi.fn().mockResolvedValue({
        teamId: "team-rollback",
        isActive: false,
        manifest: {
          teamId: "team-rollback",
          teamDefinitionId: "def-rollback",
          teamDefinitionName: "Rollback Team",
          coordinatorMemberRouteKey: "coordinator",
          runVersion: 1,
          createdAt: "2026-02-15T00:00:00.000Z",
          updatedAt: "2026-02-15T00:00:00.000Z",
          memberBindings: [],
        },
      }),
      onTeamEvent: vi.fn(),
    };
    const workspaceManager = {
      ensureWorkspaceByRootPath: vi.fn(),
    };

    const service = new TeamRunContinuationService({
      teamInstanceManager: teamInstanceManager as any,
      teamCommandIngressService: teamCommandIngressService as any,
      teamRunHistoryService: teamRunHistoryService as any,
      workspaceManager: workspaceManager as any,
      memoryDir: "/tmp/memory",
    });

    await expect(
      service.continueTeamRun({
        teamId: "team-rollback",
        userInput: { content: "hello", contextFiles: null } as any,
      }),
    ).rejects.toThrow("dispatch failed");

    expect(teamInstanceManager.terminateTeamInstance).toHaveBeenCalledWith("team-rollback");
  });
});
