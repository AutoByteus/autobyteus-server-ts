import type { AgentTeamInstanceManager } from "../../agent-team-execution/services/agent-team-instance-manager.js";
import type { TeamCommandIngressError } from "../ingress/team-command-ingress-service.js";
import { dispatchWithWorkerLocalRoutingPort } from "../routing/worker-local-dispatch.js";
import type { RunScopedTeamBindingRegistry } from "../runtime-binding/run-scoped-team-binding-registry.js";
import type { TeamEventAggregator } from "../event-aggregation/team-event-aggregator.js";
import type { TeamEnvelope } from "../envelope/envelope-builder.js";
import type { RemoteMemberExecutionGatewayDependencies } from "../worker-execution/remote-member-execution-gateway.js";
import { getPayloadRecord } from "./bootstrap-payload-normalization.js";
import { WorkerRunLifecycleCoordinator } from "./worker-run-lifecycle-coordinator.js";
import {
  normalizeRequiredString,
  type ResolveBoundRuntimeTeam,
  type TeamLike,
} from "./remote-envelope-command-handler-common.js";

type TeamInstanceManagerDependencies = Pick<AgentTeamInstanceManager, "getTeamInstance">;

type RunScopedBindingRegistryDependencies = Pick<
  RunScopedTeamBindingRegistry,
  "tryResolveRun" | "unbindRun"
>;

export type CreateRemoteEnvelopeControlCommandHandlersDependencies = {
  teamInstanceManager: TeamInstanceManagerDependencies;
  runScopedTeamBindingRegistry: RunScopedBindingRegistryDependencies;
  teamEventAggregator: Pick<TeamEventAggregator, "finalizeRun">;
  workerRunLifecycleCoordinator: WorkerRunLifecycleCoordinator;
  resolveBoundRuntimeTeam: ResolveBoundRuntimeTeam;
  onTeamDispatchUnavailable: (code: string, message: string) => TeamCommandIngressError;
};

export const createRemoteEnvelopeControlCommandHandlers = (
  deps: CreateRemoteEnvelopeControlCommandHandlersDependencies,
): Pick<
  RemoteMemberExecutionGatewayDependencies,
  "dispatchToolApproval" | "dispatchControlStop"
> => ({
  dispatchToolApproval: async (envelope: TeamEnvelope) => {
    const payload = getPayloadRecord(envelope.payload);
    const agentName = normalizeRequiredString(String(payload.agentName ?? ""), "payload.agentName");
    const toolInvocationId = normalizeRequiredString(
      String(payload.toolInvocationId ?? ""),
      "payload.toolInvocationId",
    );
    const isApproved = Boolean(payload.isApproved);
    const reason = typeof payload.reason === "string" ? payload.reason : null;
    const bound = deps.resolveBoundRuntimeTeam({
      teamRunId: envelope.teamRunId,
    });
    const team = bound.team;

    const handledByWorkerLocalIngress = await dispatchWithWorkerLocalRoutingPort({
      teamRunId: envelope.teamRunId,
      workerManagedRunIds: deps.workerRunLifecycleCoordinator.getWorkerManagedRunIds(),
      team,
      dispatch: async (localRoutingPort) =>
        localRoutingPort.dispatchToolApproval({
          agentName,
          toolInvocationId,
          isApproved,
          reason: reason ?? undefined,
        }),
    });
    if (handledByWorkerLocalIngress) {
      return;
    }
    if (!team.postToolExecutionApproval) {
      throw deps.onTeamDispatchUnavailable(
        "TEAM_DISPATCH_UNAVAILABLE",
        `Team definition '${bound.teamDefinitionId}' does not support tool approvals.`,
      );
    }
    await team.postToolExecutionApproval(agentName, toolInvocationId, isApproved, reason);
  },
  dispatchControlStop: async (envelope: TeamEnvelope) => {
    const binding = deps.runScopedTeamBindingRegistry.tryResolveRun(envelope.teamRunId);
    if (!binding) {
      await deps.workerRunLifecycleCoordinator.teardownRun(envelope.teamRunId);
      return;
    }

    const team = deps.teamInstanceManager.getTeamInstance(binding.runtimeTeamId) as TeamLike | null;
    if (team && typeof team.stop === "function") {
      await team.stop();
    }
    await deps.workerRunLifecycleCoordinator.teardownRun(envelope.teamRunId);
    deps.runScopedTeamBindingRegistry.unbindRun(envelope.teamRunId);
    deps.teamEventAggregator.finalizeRun(envelope.teamRunId);
  },
});
