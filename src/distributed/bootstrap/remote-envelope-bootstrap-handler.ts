import type { AgentTeamDefinition as DomainAgentTeamDefinition } from "../../agent-team-definition/domain/models.js";
import type { AgentTeamInstanceManager } from "../../agent-team-execution/services/agent-team-instance-manager.js";
import type { HostNodeBridgeClient } from "../node-bridge/host-node-bridge-client.js";
import { WorkerUplinkRoutingAdapter } from "../routing/worker-uplink-routing-adapter.js";
import type { RunScopedTeamBindingRegistry } from "../runtime-binding/run-scoped-team-binding-registry.js";
import type { TeamEventAggregator } from "../event-aggregation/team-event-aggregator.js";
import type { TeamEnvelope } from "../envelope/envelope-builder.js";
import { normalizeRouteSegment } from "../event-aggregation/remote-event-projection.js";
import {
  getPayloadRecord,
  memberBindingsMatch,
  normalizeBootstrapMemberBindingSnapshotList,
  normalizeBootstrapTeamDefinitionSnapshot,
} from "./bootstrap-payload-normalization.js";
import { WorkerRunLifecycleCoordinator } from "./worker-run-lifecycle-coordinator.js";

type TeamLike = {
  runtime?: {
    context?: {
      teamManager?: {
        setTeamRoutingPort?: (port: unknown) => void;
      };
    };
  };
};

const normalizeRequiredString = (value: string, field: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return normalized;
};

type TeamInstanceManagerDependencies = Pick<
  AgentTeamInstanceManager,
  | "getTeamInstance"
  | "getTeamIdByDefinitionId"
  | "createTeamInstance"
  | "terminateTeamInstance"
  | "getTeamMemberConfigsByDefinitionId"
  | "getTeamEventStream"
>;

type RunScopedBindingRegistryDependencies = Pick<
  RunScopedTeamBindingRegistry,
  "tryResolveRun" | "bindRun" | "unbindRun"
>;

export type CreateDispatchRunBootstrapHandlerDependencies = {
  hostNodeId: string;
  teamInstanceManager: TeamInstanceManagerDependencies;
  runScopedTeamBindingRegistry: RunScopedBindingRegistryDependencies;
  teamEventAggregator: Pick<TeamEventAggregator, "finalizeRun">;
  hostNodeBridgeClient: Pick<HostNodeBridgeClient, "sendCommand">;
  workerRunLifecycleCoordinator: WorkerRunLifecycleCoordinator;
  resolveWorkerTeamDefinitionId: (input: {
    hostTeamDefinitionId: string;
    snapshot: DomainAgentTeamDefinition | null;
  }) => Promise<string>;
  ensureHostNodeDirectoryEntryForWorkerRun: (targetHostNodeId: string) => void;
};

export const createDispatchRunBootstrapHandler = (
  deps: CreateDispatchRunBootstrapHandlerDependencies,
): ((envelope: TeamEnvelope) => Promise<void>) => {
  return async (envelope: TeamEnvelope): Promise<void> => {
    const payload = getPayloadRecord(envelope.payload);
    const hostTeamDefinitionId = normalizeRequiredString(
      String(payload.teamDefinitionId ?? ""),
      "payload.teamDefinitionId",
    );
    const teamDefinitionSnapshot = normalizeBootstrapTeamDefinitionSnapshot(
      payload.teamDefinitionSnapshot,
    );
    const workerTeamDefinitionId = await deps.resolveWorkerTeamDefinitionId({
      hostTeamDefinitionId,
      snapshot: teamDefinitionSnapshot,
    });
    const memberBindings = normalizeBootstrapMemberBindingSnapshotList(payload);
    const bootstrapHostNodeId = normalizeRouteSegment(payload.hostNodeId) ?? deps.hostNodeId;
    deps.ensureHostNodeDirectoryEntryForWorkerRun(bootstrapHostNodeId);

    const existingBinding = deps.runScopedTeamBindingRegistry.tryResolveRun(envelope.teamRunId);
    if (existingBinding) {
      const boundTeam = deps.teamInstanceManager.getTeamInstance(existingBinding.runtimeTeamId);
      if (boundTeam) {
        deps.workerRunLifecycleCoordinator.markWorkerManagedRun(
          envelope.teamRunId,
          bootstrapHostNodeId,
        );
        return;
      }
      await deps.workerRunLifecycleCoordinator.teardownRun(envelope.teamRunId);
      deps.runScopedTeamBindingRegistry.unbindRun(envelope.teamRunId);
      deps.teamEventAggregator.finalizeRun(envelope.teamRunId);
    }

    let runtimeTeamId = deps.teamInstanceManager.getTeamIdByDefinitionId(workerTeamDefinitionId);
    if (!runtimeTeamId) {
      runtimeTeamId = await deps.teamInstanceManager.createTeamInstance(
        workerTeamDefinitionId,
        memberBindings,
      );
    } else {
      const existingTeam = deps.teamInstanceManager.getTeamInstance(runtimeTeamId);
      if (!existingTeam) {
        runtimeTeamId = await deps.teamInstanceManager.createTeamInstance(
          workerTeamDefinitionId,
          memberBindings,
        );
      } else {
        const existingBindings = deps.teamInstanceManager.getTeamMemberConfigsByDefinitionId(
          workerTeamDefinitionId,
        );
        if (!memberBindingsMatch(existingBindings, memberBindings)) {
          await deps.teamInstanceManager.terminateTeamInstance(runtimeTeamId);
          runtimeTeamId = await deps.teamInstanceManager.createTeamInstance(
            workerTeamDefinitionId,
            memberBindings,
          );
        }
      }
    }

    deps.runScopedTeamBindingRegistry.bindRun({
      teamRunId: envelope.teamRunId,
      runVersion: envelope.runVersion,
      teamDefinitionId: hostTeamDefinitionId,
      runtimeTeamId,
      memberBindings,
    });
    deps.workerRunLifecycleCoordinator.markWorkerManagedRun(
      envelope.teamRunId,
      bootstrapHostNodeId,
    );

    const runtimeTeam = deps.teamInstanceManager.getTeamInstance(runtimeTeamId) as TeamLike | null;
    const teamManager = runtimeTeam?.runtime?.context?.teamManager;
    if (teamManager?.setTeamRoutingPort) {
      teamManager.setTeamRoutingPort(
        new WorkerUplinkRoutingAdapter({
          teamRunId: envelope.teamRunId,
          runVersion: envelope.runVersion,
          forwardToHost: async (forwardEnvelope) => {
            await deps.hostNodeBridgeClient.sendCommand(bootstrapHostNodeId, forwardEnvelope);
          },
        }),
      );
    }

    await deps.workerRunLifecycleCoordinator.replaceEventForwarder({
      teamRunId: envelope.teamRunId,
      runVersion: envelope.runVersion,
      runtimeTeamId,
      eventStream: deps.teamInstanceManager.getTeamEventStream(runtimeTeamId),
    });
  };
};
