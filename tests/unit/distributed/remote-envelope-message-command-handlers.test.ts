import { describe, expect, it, vi } from "vitest";
import type { TeamEnvelope } from "../../../src/distributed/envelope/envelope-builder.js";
import { TeamCommandIngressError } from "../../../src/distributed/ingress/team-command-ingress-service.js";
import { createRemoteEnvelopeMessageCommandHandlers } from "../../../src/distributed/bootstrap/remote-envelope-message-command-handlers.js";
import { WorkerRunLifecycleCoordinator } from "../../../src/distributed/bootstrap/worker-run-lifecycle-coordinator.js";

const createLifecycleCoordinator = (): WorkerRunLifecycleCoordinator =>
  new WorkerRunLifecycleCoordinator({
    sourceNodeId: "worker-1",
    projectRemoteExecutionEventsFromTeamEvent: () => [],
    publishRemoteExecutionEventToHost: async () => undefined,
  });

const createDependencies = () => {
  const workerRunLifecycleCoordinator = createLifecycleCoordinator();
  return {
    workerRunLifecycleCoordinator,
    deps: {
      workerRunLifecycleCoordinator,
      resolveBoundRuntimeTeam: vi.fn(),
      onTeamDispatchUnavailable: (code: string, message: string) =>
        new TeamCommandIngressError(code, message),
    },
  };
};

describe("remote envelope message command handlers", () => {
  it("falls back to team.postMessage for user messages when run is not worker-managed", async () => {
    const { deps } = createDependencies();
    const postMessage = vi.fn(async () => undefined);
    deps.resolveBoundRuntimeTeam = vi.fn(() => ({
      teamDefinitionId: "team-def-1",
      team: { postMessage },
    }));

    const handlers = createRemoteEnvelopeMessageCommandHandlers(deps);
    const envelope: TeamEnvelope = {
      envelopeId: "env-user",
      teamRunId: "run-1",
      runVersion: "v1",
      kind: "USER_MESSAGE",
      payload: {
        targetAgentName: "student",
        userMessage: { content: "hello" },
      },
    };

    await handlers.dispatchUserMessage?.(envelope);

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0]?.[1]).toBe("student");
    expect(deps.resolveBoundRuntimeTeam).toHaveBeenCalledWith({ teamRunId: "run-1" });
  });

  it("dispatches inter-agent messages via team manager when available", async () => {
    const { deps } = createDependencies();
    const dispatchInterAgentMessage = vi.fn(async () => undefined);
    deps.resolveBoundRuntimeTeam = vi.fn(() => ({
      teamDefinitionId: "team-def-1",
      team: {
        runtime: { context: { teamManager: { dispatchInterAgentMessage } } },
      },
    }));

    const handlers = createRemoteEnvelopeMessageCommandHandlers(deps);
    const envelope: TeamEnvelope = {
      envelopeId: "env-iam",
      teamRunId: "run-1",
      runVersion: "v1",
      kind: "INTER_AGENT_MESSAGE_REQUEST",
      payload: {
        senderAgentId: "agent-1",
        recipientName: "coordinator",
        content: "ping",
        messageType: "direct_message",
      },
    };

    await handlers.dispatchInterAgentMessage?.(envelope);

    expect(dispatchInterAgentMessage).toHaveBeenCalledTimes(1);
    expect(deps.resolveBoundRuntimeTeam).toHaveBeenCalledWith({ teamRunId: "run-1" });
  });
});
