import { describe, expect, it, vi } from "vitest";
import { AgentInputUserMessage } from "autobyteus-ts";
import { TeamCommandIngressError, TeamCommandIngressService } from "../../../src/distributed/ingress/team-command-ingress-service.js";

describe("TeamCommandIngressService", () => {
  it("dispatches user message through orchestrator using coordinator fallback", async () => {
    const dispatchUserMessage = vi.fn(async () => ({ accepted: true }));
    const service = new TeamCommandIngressService({
      teamRunLocator: {
        resolveOrCreateRun: vi.fn(async () => ({
          teamId: "team-1",
          teamRunId: "run-1",
          runVersion: 4,
          coordinatorMemberName: "coordinator",
          hostNodeId: "node-host",
          teamDefinitionId: "def-1",
        })),
      } as any,
      teamRunOrchestrator: {
        dispatchUserMessage,
      } as any,
    });

    const result = await service.dispatchUserMessage({
      teamId: "team-1",
      userMessage: AgentInputUserMessage.fromDict({ content: "hello", context_files: null }),
      targetMemberName: null,
    });

    expect(result).toMatchObject({
      teamId: "team-1",
      teamRunId: "run-1",
      runVersion: 4,
    });
    expect(dispatchUserMessage).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        targetAgentName: "coordinator",
      }),
    );
  });

  it("rejects tool approval when token runVersion is stale", async () => {
    const service = new TeamCommandIngressService({
      teamRunLocator: {
        resolveActiveRun: vi.fn(() => ({
          teamId: "team-1",
          teamRunId: "run-1",
          runVersion: 3,
          coordinatorMemberName: "coordinator",
          hostNodeId: "node-host",
          teamDefinitionId: "def-1",
        })),
      } as any,
      teamRunOrchestrator: {
        dispatchToolApproval: vi.fn(async () => ({ accepted: true })),
      } as any,
    });

    await expect(
      service.dispatchToolApproval({
        teamId: "team-1",
        token: {
          teamRunId: "run-1",
          runVersion: 2,
          invocationId: "inv-1",
          invocationVersion: 1,
          targetMemberName: "worker-a",
        },
        isApproved: true,
      }),
    ).rejects.toMatchObject({
      name: "TeamCommandIngressError",
      code: "STALE_APPROVAL_TOKEN",
    } satisfies Partial<TeamCommandIngressError>);
  });

  it("dispatches tool approval when token matches active run", async () => {
    const dispatchToolApproval = vi.fn(async () => ({ accepted: true }));
    const service = new TeamCommandIngressService({
      teamRunLocator: {
        resolveActiveRun: vi.fn(() => ({
          teamId: "team-1",
          teamRunId: "run-1",
          runVersion: 2,
          coordinatorMemberName: "coordinator",
          hostNodeId: "node-host",
          teamDefinitionId: "def-1",
        })),
      } as any,
      teamRunOrchestrator: {
        dispatchToolApproval,
      } as any,
    });

    const token = service.issueToolApprovalTokenFromActiveRun({
      teamId: "team-1",
      invocationId: "inv-1",
      targetMemberName: "worker-a",
      invocationVersion: 1,
    });
    expect(token).not.toBeNull();

    await service.dispatchToolApproval({
      teamId: "team-1",
      token: token!,
      isApproved: false,
      reason: "not allowed",
      agentName: "worker-a",
    });

    expect(dispatchToolApproval).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        agentName: "worker-a",
        toolInvocationId: "inv-1",
        isApproved: false,
      }),
    );
  });

  it("rejects tool approval when invocation version is stale", async () => {
    const service = new TeamCommandIngressService({
      teamRunLocator: {
        resolveActiveRun: vi.fn(() => ({
          teamId: "team-1",
          teamRunId: "run-1",
          runVersion: 2,
          coordinatorMemberName: "coordinator",
          hostNodeId: "node-host",
          teamDefinitionId: "def-1",
        })),
      } as any,
      teamRunOrchestrator: {
        dispatchToolApproval: vi.fn(async () => ({ accepted: true })),
      } as any,
    });

    const token = service.issueToolApprovalTokenFromActiveRun({
      teamId: "team-1",
      invocationId: "inv-1",
      targetMemberName: "worker-a",
      invocationVersion: 2,
    });
    expect(token).not.toBeNull();

    await expect(
      service.dispatchToolApproval({
        teamId: "team-1",
        token: {
          ...token!,
          invocationVersion: 1,
        },
        isApproved: true,
        agentName: "worker-a",
      }),
    ).rejects.toMatchObject({
      name: "TeamCommandIngressError",
      code: "STALE_APPROVAL_TOKEN",
    } satisfies Partial<TeamCommandIngressError>);
  });
});
