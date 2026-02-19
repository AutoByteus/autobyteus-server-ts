import { AgentInputUserMessage } from "autobyteus-ts";
import type { InterAgentMessageRequestEvent } from "autobyteus-ts/agent-team/events/agent-team-events.js";
import type { TeamCommandIngressError } from "../ingress/team-command-ingress-service.js";
import {
  dispatchInterAgentMessageViaTeamManager,
  dispatchWithWorkerLocalRoutingPort,
} from "../routing/worker-local-dispatch.js";
import type { TeamEnvelope } from "../envelope/envelope-builder.js";
import type { RemoteMemberExecutionGatewayDependencies } from "../worker-execution/remote-member-execution-gateway.js";
import {
  getPayloadRecord,
  normalizeUserMessageInput,
} from "./bootstrap-payload-normalization.js";
import { WorkerRunLifecycleCoordinator } from "./worker-run-lifecycle-coordinator.js";
import {
  normalizeRequiredString,
  type ResolveBoundRuntimeTeam,
} from "./remote-envelope-command-handler-common.js";

export type CreateRemoteEnvelopeMessageCommandHandlersDependencies = {
  workerRunLifecycleCoordinator: WorkerRunLifecycleCoordinator;
  resolveBoundRuntimeTeam: ResolveBoundRuntimeTeam;
  onTeamDispatchUnavailable: (code: string, message: string) => TeamCommandIngressError;
};

export const createRemoteEnvelopeMessageCommandHandlers = (
  deps: CreateRemoteEnvelopeMessageCommandHandlersDependencies,
): Pick<
  RemoteMemberExecutionGatewayDependencies,
  "dispatchUserMessage" | "dispatchInterAgentMessage"
> => ({
  dispatchUserMessage: async (envelope: TeamEnvelope) => {
    const payload = getPayloadRecord(envelope.payload);
    const teamDefinitionId = normalizeRequiredString(
      String(payload.teamDefinitionId ?? ""),
      "payload.teamDefinitionId",
    );
    const targetAgentName = normalizeRequiredString(
      String(payload.targetAgentName ?? ""),
      "payload.targetAgentName",
    );
    const bound = deps.resolveBoundRuntimeTeam({
      teamRunId: envelope.teamRunId,
      expectedTeamDefinitionId: teamDefinitionId,
    });
    const team = bound.team;
    const userMessage = normalizeUserMessageInput(payload.userMessage);

    const handledByWorkerLocalIngress = await dispatchWithWorkerLocalRoutingPort({
      teamRunId: envelope.teamRunId,
      workerManagedRunIds: deps.workerRunLifecycleCoordinator.getWorkerManagedRunIds(),
      team,
      dispatch: async (localRoutingPort) =>
        localRoutingPort.dispatchUserMessage({
          targetAgentName,
          userMessage,
        }),
    });
    if (handledByWorkerLocalIngress) {
      return;
    }
    if (!team.postMessage) {
      throw deps.onTeamDispatchUnavailable(
        "TEAM_DISPATCH_UNAVAILABLE",
        `Team definition '${bound.teamDefinitionId}' does not support postMessage dispatch.`,
      );
    }
    await team.postMessage(userMessage, targetAgentName);
  },
  dispatchInterAgentMessage: async (envelope: TeamEnvelope) => {
    const payload = getPayloadRecord(envelope.payload);
    const teamDefinitionId = normalizeRequiredString(
      String(payload.teamDefinitionId ?? ""),
      "payload.teamDefinitionId",
    );
    const recipientName = normalizeRequiredString(
      String(payload.recipientName ?? ""),
      "payload.recipientName",
    );
    const content = normalizeRequiredString(String(payload.content ?? ""), "payload.content");
    const messageType = normalizeRequiredString(
      String(payload.messageType ?? ""),
      "payload.messageType",
    );
    const senderAgentId = normalizeRequiredString(
      String(payload.senderAgentId ?? ""),
      "payload.senderAgentId",
    );
    const bound = deps.resolveBoundRuntimeTeam({
      teamRunId: envelope.teamRunId,
      expectedTeamDefinitionId: teamDefinitionId,
    });
    const team = bound.team;

    const handledByWorkerLocalIngress = await dispatchWithWorkerLocalRoutingPort({
      teamRunId: envelope.teamRunId,
      workerManagedRunIds: deps.workerRunLifecycleCoordinator.getWorkerManagedRunIds(),
      team,
      dispatch: async (localRoutingPort) =>
        localRoutingPort.dispatchInterAgentMessageRequest({
          senderAgentId,
          recipientName,
          content,
          messageType,
        }),
    });
    if (handledByWorkerLocalIngress) {
      return;
    }

    const handledByTeamManager = await dispatchInterAgentMessageViaTeamManager({
      team,
      event: {
        senderAgentId,
        recipientName,
        content,
        messageType,
      } as InterAgentMessageRequestEvent,
    });
    if (handledByTeamManager) {
      return;
    }
    if (!team.postMessage) {
      throw deps.onTeamDispatchUnavailable(
        "TEAM_DISPATCH_UNAVAILABLE",
        `Team definition '${bound.teamDefinitionId}' cannot route inter-agent messages.`,
      );
    }
    await team.postMessage(
      AgentInputUserMessage.fromDict({ content, context_files: null }),
      recipientName,
    );
  },
});
