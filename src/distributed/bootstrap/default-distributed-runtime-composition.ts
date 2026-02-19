import {
  AgentInputUserMessage,
} from "autobyteus-ts";
import {
  type InterAgentMessageRequestEvent,
} from "autobyteus-ts/agent-team/events/agent-team-events.js";
import { AgentTeamDefinitionService } from "../../agent-team-definition/services/agent-team-definition-service.js";
import {
  AgentTeamDefinition as DomainAgentTeamDefinition,
  TeamMember as DomainTeamMember,
} from "../../agent-team-definition/domain/models.js";
import {
  AgentTeamInstanceManager,
  type TeamMemberConfigInput,
} from "../../agent-team-execution/services/agent-team-instance-manager.js";
import { DependencyHydrationService } from "../dependency-hydration/dependency-hydration-service.js";
import { EnvelopeBuilder } from "../envelope/envelope-builder.js";
import { TeamEventAggregator } from "../event-aggregation/team-event-aggregator.js";
import {
  TeamCommandIngressService,
  TeamCommandIngressError,
} from "../ingress/team-command-ingress-service.js";
import { TeamRunLocator } from "../ingress/team-run-locator.js";
import { NodeDirectoryService } from "../node-directory/node-directory-service.js";
import { HostNodeBridgeClient } from "../node-bridge/host-node-bridge-client.js";
import { WorkerNodeBridgeServer } from "../node-bridge/worker-node-bridge-server.js";
import { RunDegradationPolicy } from "../policies/run-degradation-policy.js";
import { RemoteEventIdempotencyPolicy } from "../policies/remote-event-idempotency-policy.js";
import { RunVersionFencingPolicy } from "../policies/run-version-fencing-policy.js";
import { ToolApprovalConcurrencyPolicy } from "../policies/tool-approval-concurrency-policy.js";
import { TeamRoutingPortAdapter } from "../routing/team-routing-port-adapter.js";
import { TeamRoutingPortAdapterRegistry } from "../routing/team-routing-port-adapter-registry.js";
import {
  dispatchInterAgentMessageViaTeamManager as dispatchInterAgentMessageViaTeamManagerFromRouting,
  dispatchWithTeamLocalRoutingPort as dispatchWithTeamLocalRoutingPortFromRouting,
  dispatchWithWorkerLocalRoutingPort as dispatchWithWorkerLocalRoutingPortFromRouting,
} from "../routing/worker-local-dispatch.js";
import {
  RunScopedTeamBindingRegistry,
  TeamRunNotBoundError,
} from "../runtime-binding/run-scoped-team-binding-registry.js";
import { InternalEnvelopeAuth, type TransportSecurityMode } from "../security/internal-envelope-auth.js";
import { TeamRunOrchestrator } from "../team-run-orchestrator/team-run-orchestrator.js";
import { HostDistributedCommandClient } from "../transport/internal-http/host-distributed-command-client.js";
import { WorkerEventUplinkClient } from "../transport/internal-http/worker-event-uplink-client.js";
import {
  RemoteMemberExecutionGateway,
  type RemoteExecutionEvent,
} from "../worker-execution/remote-member-execution-gateway.js";
import {
  projectRemoteExecutionEventsFromTeamEvent as projectRemoteExecutionEventsFromTeamEventFromAggregation,
} from "../event-aggregation/remote-event-projection.js";
import {
  buildHostOnlyNodeDirectoryEntries,
  buildResolveSecretByKeyId,
  emitAddressResolutionLog,
  normalizeOptionalString,
  parseAllowedNodeIds,
  parseSecurityModeFromEnv,
} from "./runtime-composition-helpers.js";
import {
  serializeTeamDefinitionSnapshot,
  teamDefinitionMatchesSnapshot,
  toTeamDefinitionUpdate,
} from "./bootstrap-payload-normalization.js";
import { createRemoteEnvelopeCommandHandlers } from "./remote-envelope-command-handlers.js";
import { WorkerRunLifecycleCoordinator } from "./worker-run-lifecycle-coordinator.js";
import {
  normalizeDistributedBaseUrl as normalizeDistributedBaseUrlFromPolicy,
  resolveRemoteTargetForCommandDispatch,
  resolveRemoteTargetForEventUplink,
} from "../addressing/transport-address-policy.js";

type TeamLike = {
  postMessage?: (
    message: AgentInputUserMessage,
    targetMemberName?: string | null,
  ) => Promise<void>;
  postToolExecutionApproval?: (
    agentName: string,
    toolInvocationId: string,
    isApproved: boolean,
    reason?: string | null,
  ) => Promise<void>;
  stop?: (timeout?: number) => Promise<void>;
  runtime?: {
    context?: {
      teamManager?: {
        dispatchInterAgentMessage?: (event: InterAgentMessageRequestEvent) => Promise<void>;
        setTeamRoutingPort?: (port: unknown) => void;
        ensureNodeIsReady?: (nameOrAgentId: string) => Promise<any>;
      };
    };
  };
};

export type DefaultDistributedRuntimeComposition = {
  hostNodeId: string;
  transportSecurityMode: TransportSecurityMode;
  nodeDirectoryService: NodeDirectoryService;
  internalEnvelopeAuth: InternalEnvelopeAuth;
  hostDistributedCommandClient: HostDistributedCommandClient;
  workerEventUplinkClient: WorkerEventUplinkClient;
  hostNodeBridgeClient: HostNodeBridgeClient;
  workerNodeBridgeServer: WorkerNodeBridgeServer;
  teamRunOrchestrator: TeamRunOrchestrator;
  teamRunLocator: TeamRunLocator;
  teamCommandIngressService: TeamCommandIngressService;
  teamEventAggregator: TeamEventAggregator;
  remoteEventIdempotencyPolicy: RemoteEventIdempotencyPolicy;
  runVersionFencingPolicy: RunVersionFencingPolicy;
  runScopedTeamBindingRegistry: RunScopedTeamBindingRegistry;
};

const normalizeRequiredString = (value: string, field: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return normalized;
};

export const normalizeDistributedBaseUrl = normalizeDistributedBaseUrlFromPolicy;

export const ensureNodeDirectoryEntryForHostUplink = (input: {
  localNodeId: string;
  targetHostNodeId: string;
  nodeDirectoryService: NodeDirectoryService;
  distributedUplinkBaseUrl?: string | null;
  discoveryRegistryUrl?: string | null;
}): boolean => {
  const outcome = resolveRemoteTargetForEventUplink({
    localNodeId: input.localNodeId,
    targetNodeId: input.targetHostNodeId,
    nodeDirectoryService: input.nodeDirectoryService,
    distributedUplinkBaseUrl: input.distributedUplinkBaseUrl,
    discoveryRegistryUrl: input.discoveryRegistryUrl,
  });
  return outcome.resolved;
};

export const dispatchWithWorkerLocalRoutingPort = dispatchWithWorkerLocalRoutingPortFromRouting;
export const dispatchInterAgentMessageViaTeamManager = dispatchInterAgentMessageViaTeamManagerFromRouting;
const dispatchWithTeamLocalRoutingPort = dispatchWithTeamLocalRoutingPortFromRouting;

const resolveTeamById = (
  teamId: string,
  teamInstanceManager: AgentTeamInstanceManager,
): TeamLike => {
  const team = teamInstanceManager.getTeamInstance(teamId) as TeamLike | null;
  if (!team) {
    throw new TeamCommandIngressError("TEAM_NOT_FOUND", `Team '${teamId}' not found.`);
  }
  return team;
};

export const resolveBoundRuntimeTeamFromRegistries = (input: {
  teamRunId: string;
  runScopedTeamBindingRegistry: Pick<RunScopedTeamBindingRegistry, "resolveRun">;
  teamRunOrchestrator: Pick<TeamRunOrchestrator, "getRunRecord">;
  resolveTeamById: (teamId: string) => TeamLike;
  resolveTeamByRunId: (teamRunId: string) => TeamLike;
}): {
  team: TeamLike;
  teamDefinitionId: string;
} => {
  const normalizedTeamRunId = normalizeRequiredString(input.teamRunId, "teamRunId");

  try {
    const binding = input.runScopedTeamBindingRegistry.resolveRun(normalizedTeamRunId);
    return {
      team: input.resolveTeamById(binding.runtimeTeamId),
      teamDefinitionId: binding.teamDefinitionId,
    };
  } catch (error) {
    if (!(error instanceof TeamRunNotBoundError)) {
      throw error;
    }
  }

  const hostRunRecord = input.teamRunOrchestrator.getRunRecord(normalizedTeamRunId);
  if (!hostRunRecord || hostRunRecord.status === "stopped") {
    throw new TeamCommandIngressError(
      "TEAM_RUN_NOT_BOUND",
      `Run '${normalizedTeamRunId}' is not bound on this worker.`,
    );
  }

  return {
    team: input.resolveTeamByRunId(normalizedTeamRunId),
    teamDefinitionId: hostRunRecord.teamDefinitionId,
  };
};

export const projectRemoteExecutionEventsFromTeamEvent =
  projectRemoteExecutionEventsFromTeamEventFromAggregation;

let cachedDefaultDistributedRuntimeComposition: DefaultDistributedRuntimeComposition | null = null;

export const createDefaultDistributedRuntimeComposition = (): DefaultDistributedRuntimeComposition => {
  const teamInstanceManager = AgentTeamInstanceManager.getInstance();
  const teamDefinitionService = AgentTeamDefinitionService.getInstance();
  const envelopeBuilder = new EnvelopeBuilder();

  const hostNodeId = normalizeOptionalString(process.env.AUTOBYTEUS_NODE_ID) ?? "node-local";
  const transportSecurityMode = parseSecurityModeFromEnv();

  const nodeDirectoryService = new NodeDirectoryService(buildHostOnlyNodeDirectoryEntries(hostNodeId), {
    protectedNodeIds: [hostNodeId],
  });
  const internalEnvelopeAuth = new InternalEnvelopeAuth({
    localNodeId: hostNodeId,
    defaultKeyId: normalizeOptionalString(process.env.AUTOBYTEUS_DISTRIBUTED_KEY_ID) ?? "default",
    resolveSecretByKeyId: buildResolveSecretByKeyId(),
    allowedNodeIds: parseAllowedNodeIds(hostNodeId),
  });

  const hostDistributedCommandClient = new HostDistributedCommandClient({
    nodeDirectoryService,
    internalEnvelopeAuth,
    defaultSecurityMode: transportSecurityMode,
  });
  const workerEventUplinkClient = new WorkerEventUplinkClient({
    hostNodeId,
    nodeDirectoryService,
    internalEnvelopeAuth,
    defaultSecurityMode: transportSecurityMode,
  });

  const hostNodeBridgeClient = new HostNodeBridgeClient({
    sendEnvelopeToWorker: async (targetNodeId, envelope) => {
      const outcome = resolveRemoteTargetForCommandDispatch({
        targetNodeId,
        nodeDirectoryService,
      });
      emitAddressResolutionLog({
        operation: "command_dispatch",
        outcome,
      });
      await hostDistributedCommandClient.sendCommand(targetNodeId, envelope);
    },
  });
  const runScopedTeamBindingRegistry = new RunScopedTeamBindingRegistry();
  const teamEventAggregator = new TeamEventAggregator();
  const workerTeamDefinitionIdByHostTeamDefinitionId = new Map<string, string>();
  let teamRunLocator: TeamRunLocator | null = null;

  const ensureHostNodeDirectoryEntryForWorkerRun = (targetHostNodeId: string): void => {
    const outcome = resolveRemoteTargetForEventUplink({
      localNodeId: hostNodeId,
      targetNodeId: targetHostNodeId,
      nodeDirectoryService,
      distributedUplinkBaseUrl: process.env.AUTOBYTEUS_DISTRIBUTED_UPLINK_BASE_URL ?? "",
      discoveryRegistryUrl: process.env.AUTOBYTEUS_NODE_DISCOVERY_REGISTRY_URL ?? "",
    });
    emitAddressResolutionLog({
      operation: "event_uplink",
      outcome,
    });
  };

  const resolveHostRuntimeTeamByRunId = (teamRunId: string): TeamLike => {
    if (!teamRunLocator) {
      throw new TeamCommandIngressError(
        "TEAM_RUN_NOT_BOUND",
        `Run '${teamRunId}' is not bound on this host.`,
      );
    }
    const locatorRecord = teamRunLocator.resolveByTeamRunId(teamRunId);
    if (!locatorRecord) {
      throw new TeamCommandIngressError(
        "TEAM_RUN_NOT_BOUND",
        `Run '${teamRunId}' is not bound on this host.`,
      );
    }
    return resolveTeamById(locatorRecord.teamId, teamInstanceManager);
  };

  const resolveBoundRuntimeTeam = (input: {
    teamRunId: string;
  }): {
    team: TeamLike;
    teamDefinitionId: string;
  } =>
    resolveBoundRuntimeTeamFromRegistries({
      teamRunId: input.teamRunId,
      runScopedTeamBindingRegistry,
      teamRunOrchestrator,
      resolveTeamById: (teamId) => resolveTeamById(teamId, teamInstanceManager),
      resolveTeamByRunId: (teamRunId) => resolveHostRuntimeTeamByRunId(teamRunId),
    });

  const resolveBootstrapBindingSnapshot = (
    teamRunId: string,
    teamDefinitionId: string,
  ): TeamMemberConfigInput[] => {
    if (!teamRunLocator) {
      throw new TeamCommandIngressError(
        "TEAM_BOOTSTRAP_CONFIG_UNAVAILABLE",
        `No run locator is available for bootstrap run '${teamRunId}'.`,
      );
    }
    const locatorRecord = teamRunLocator.resolveByTeamRunId(teamRunId);
    if (!locatorRecord) {
      throw new TeamCommandIngressError(
        "TEAM_BOOTSTRAP_CONFIG_UNAVAILABLE",
        `No active run locator record exists for bootstrap run '${teamRunId}'.`,
      );
    }
    const memberBindings = teamInstanceManager.getTeamMemberConfigs(locatorRecord.teamId);
    if (memberBindings.length === 0) {
      throw new TeamCommandIngressError(
        "TEAM_BOOTSTRAP_CONFIG_UNAVAILABLE",
        `No member config snapshot is available for team '${locatorRecord.teamId}' (definition '${teamDefinitionId}').`,
      );
    }
    return memberBindings;
  };

  const resolveBootstrapTeamDefinitionSnapshot = async (
    teamDefinitionId: string,
  ): Promise<Record<string, unknown>> => {
    const definition = await teamDefinitionService.getDefinitionById(teamDefinitionId);
    if (!definition) {
      throw new TeamCommandIngressError(
        "TEAM_BOOTSTRAP_DEFINITION_UNAVAILABLE",
        `No team definition snapshot is available for '${teamDefinitionId}'.`,
      );
    }
    return serializeTeamDefinitionSnapshot(definition);
  };

  const resolveWorkerTeamDefinitionId = async (input: {
    hostTeamDefinitionId: string;
    snapshot: DomainAgentTeamDefinition | null;
  }): Promise<string> => {
    const mapped = workerTeamDefinitionIdByHostTeamDefinitionId.get(input.hostTeamDefinitionId) ?? null;
    if (mapped) {
      const existingMapped = await teamDefinitionService.getDefinitionById(mapped);
      if (existingMapped) {
        return mapped;
      }
      workerTeamDefinitionIdByHostTeamDefinitionId.delete(input.hostTeamDefinitionId);
    }

    const direct = await teamDefinitionService.getDefinitionById(input.hostTeamDefinitionId);
    if (direct?.id) {
      if (input.snapshot && !teamDefinitionMatchesSnapshot(direct, input.snapshot)) {
        await teamDefinitionService.updateDefinition(direct.id, toTeamDefinitionUpdate(input.snapshot));
      }
      workerTeamDefinitionIdByHostTeamDefinitionId.set(input.hostTeamDefinitionId, direct.id);
      return direct.id;
    }

    if (!input.snapshot) {
      throw new TeamCommandIngressError(
        "TEAM_BOOTSTRAP_DEFINITION_UNAVAILABLE",
        `Team definition '${input.hostTeamDefinitionId}' is unavailable on worker and no snapshot was provided.`,
      );
    }

    const allDefinitions = await teamDefinitionService.getAllDefinitions();
    const byName = allDefinitions.find(
      (definition) =>
        definition.name === input.snapshot?.name &&
        definition.coordinatorMemberName === input.snapshot?.coordinatorMemberName,
    );
    if (byName?.id) {
      if (!teamDefinitionMatchesSnapshot(byName, input.snapshot)) {
        await teamDefinitionService.updateDefinition(byName.id, toTeamDefinitionUpdate(input.snapshot));
      }
      workerTeamDefinitionIdByHostTeamDefinitionId.set(input.hostTeamDefinitionId, byName.id);
      return byName.id;
    }

    const created = await teamDefinitionService.createDefinition(
      new DomainAgentTeamDefinition({
        name: input.snapshot.name,
        description: input.snapshot.description,
        coordinatorMemberName: input.snapshot.coordinatorMemberName,
        role: input.snapshot.role ?? null,
        avatarUrl: input.snapshot.avatarUrl ?? null,
        nodes: input.snapshot.nodes.map(
          (node) =>
            new DomainTeamMember({
              memberName: node.memberName,
              referenceId: node.referenceId,
              referenceType: node.referenceType,
              homeNodeId: node.homeNodeId ?? "embedded-local",
            }),
        ),
      }),
    );
    if (!created.id) {
      throw new TeamCommandIngressError(
        "TEAM_BOOTSTRAP_DEFINITION_UNAVAILABLE",
        `Failed to create worker-local team definition for host definition '${input.hostTeamDefinitionId}'.`,
      );
    }
    workerTeamDefinitionIdByHostTeamDefinitionId.set(input.hostTeamDefinitionId, created.id);
    return created.id;
  };

  const dispatchRemoteBootstrapEnvelope = async (input: {
    targetNodeId: string;
    teamRunId: string;
    runVersion: string | number;
    teamDefinitionId: string;
    hostNodeId: string;
  }): Promise<void> => {
    const memberBindings = resolveBootstrapBindingSnapshot(input.teamRunId, input.teamDefinitionId);
    const teamDefinitionSnapshot = await resolveBootstrapTeamDefinitionSnapshot(input.teamDefinitionId);
    await hostNodeBridgeClient.sendCommand(
      input.targetNodeId,
      envelopeBuilder.buildEnvelope({
        teamRunId: input.teamRunId,
        runVersion: input.runVersion,
        kind: "RUN_BOOTSTRAP",
        payload: {
          teamDefinitionId: input.teamDefinitionId,
          teamDefinitionSnapshot,
          memberBindings,
          hostNodeId: input.hostNodeId,
        },
      }),
    );
  };

  let workerRunLifecycleCoordinator: WorkerRunLifecycleCoordinator;

  const publishRemoteExecutionEventToHost = async (event: RemoteExecutionEvent): Promise<void> => {
    const targetHostNodeId = workerRunLifecycleCoordinator.resolveHostNodeId(
      event.teamRunId,
      hostNodeId,
    );
    const ensured = ensureNodeDirectoryEntryForHostUplink({
      localNodeId: hostNodeId,
      targetHostNodeId,
      nodeDirectoryService,
      distributedUplinkBaseUrl: process.env.AUTOBYTEUS_DISTRIBUTED_UPLINK_BASE_URL ?? "",
      discoveryRegistryUrl: process.env.AUTOBYTEUS_NODE_DISCOVERY_REGISTRY_URL ?? "",
    });
    if (!ensured) {
      throw new Error(
        `Address resolution failed for worker event uplink target '${targetHostNodeId}'.`,
      );
    }
    await workerEventUplinkClient.publishRemoteEvent(event, targetHostNodeId);
  };

  workerRunLifecycleCoordinator = new WorkerRunLifecycleCoordinator({
    sourceNodeId: hostNodeId,
    projectRemoteExecutionEventsFromTeamEvent,
    publishRemoteExecutionEventToHost,
  });

  const remoteEnvelopeCommandHandlers = createRemoteEnvelopeCommandHandlers({
    hostNodeId,
    teamInstanceManager,
    runScopedTeamBindingRegistry,
    teamEventAggregator,
    hostNodeBridgeClient,
    workerRunLifecycleCoordinator,
    resolveWorkerTeamDefinitionId,
    resolveBoundRuntimeTeam,
    ensureHostNodeDirectoryEntryForWorkerRun,
    onTeamDispatchUnavailable: (code, message) => new TeamCommandIngressError(code, message),
  });

  const remoteMemberExecutionGateway = new RemoteMemberExecutionGateway({
    ...remoteEnvelopeCommandHandlers,
    publishEventToHost: publishRemoteExecutionEventToHost,
  });

  const workerNodeBridgeServer = new WorkerNodeBridgeServer(async (envelope) => {
    await remoteMemberExecutionGateway.dispatchEnvelope(envelope);
  });

  const teamRunOrchestrator = new TeamRunOrchestrator({
    dependencyHydrationService: new DependencyHydrationService(),
    routingRegistry: new TeamRoutingPortAdapterRegistry(),
    runDegradationPolicy: new RunDegradationPolicy(),
    createRoutingAdapter: ({
      teamRunId,
      teamDefinitionId,
      runVersion,
      hostNodeId: runHostNodeId,
      placementByMember,
    }) =>
      new TeamRoutingPortAdapter({
        teamRunId,
        runVersion,
        localNodeId: runHostNodeId,
        placementByMember,
        dispatchRemoteEnvelope: async (targetNodeId, envelope) => {
          await hostNodeBridgeClient.sendCommand(targetNodeId, envelope);
        },
        ensureRemoteNodeReady: async (targetNodeId) => {
          await dispatchRemoteBootstrapEnvelope({
            targetNodeId,
            teamRunId,
            runVersion,
            teamDefinitionId,
            hostNodeId: runHostNodeId,
          });
        },
        dispatchLocalUserMessage: async (event) => {
          const team = resolveHostRuntimeTeamByRunId(teamRunId);
          await dispatchWithTeamLocalRoutingPort({
            team,
            contextLabel: `Run '${teamRunId}'`,
            dispatch: async (localRoutingPort) => localRoutingPort.dispatchUserMessage(event),
          });
        },
        dispatchLocalInterAgentMessage: async (event) => {
          const team = resolveHostRuntimeTeamByRunId(teamRunId);
          await dispatchWithTeamLocalRoutingPort({
            team,
            contextLabel: `Run '${teamRunId}'`,
            dispatch: async (localRoutingPort) =>
              localRoutingPort.dispatchInterAgentMessageRequest(event),
          });
        },
        dispatchLocalToolApproval: async (event) => {
          const team = resolveHostRuntimeTeamByRunId(teamRunId);
          await dispatchWithTeamLocalRoutingPort({
            team,
            contextLabel: `Run '${teamRunId}'`,
            dispatch: async (localRoutingPort) => localRoutingPort.dispatchToolApproval(event),
          });
        },
        dispatchLocalControlStop: async () => {
          const team = resolveHostRuntimeTeamByRunId(teamRunId);
          if (typeof team.stop === "function") {
            await team.stop();
          }
        },
      }),
  });

  const bindHostRuntimeRoutingPortForRun = (teamRunId: string): void => {
    const runRecord = teamRunOrchestrator.getRunRecord(teamRunId);
    if (!runRecord || runRecord.status === "stopped") {
      return;
    }

    const routingPort = teamRunOrchestrator.resolveRoutingPort(teamRunId);
    if (!routingPort) {
      return;
    }

    let team: TeamLike;
    try {
      team = resolveHostRuntimeTeamByRunId(teamRunId);
    } catch {
      return;
    }

    const teamManager = team.runtime?.context?.teamManager;
    if (teamManager && typeof teamManager.setTeamRoutingPort === "function") {
      teamManager.setTeamRoutingPort(routingPort);
    }
  };

  const defaultTeamRunLocator = new TeamRunLocator({
    teamRunOrchestrator,
    teamDefinitionService,
    teamInstanceManager,
    hostNodeId,
    defaultNodeId: hostNodeId,
    nodeSnapshotProvider: () => nodeDirectoryService.listPlacementCandidates(),
    onRunResolved: (record) => {
      bindHostRuntimeRoutingPortForRun(record.teamRunId);
    },
  });
  teamRunLocator = defaultTeamRunLocator;

  const teamCommandIngressService = new TeamCommandIngressService({
    teamRunLocator: defaultTeamRunLocator,
    teamRunOrchestrator,
    toolApprovalConcurrencyPolicy: new ToolApprovalConcurrencyPolicy(),
  });

  const remoteEventIdempotencyPolicy = new RemoteEventIdempotencyPolicy();
  const runVersionFencingPolicy = new RunVersionFencingPolicy(async (teamRunId) =>
    teamRunOrchestrator.resolveCurrentRunVersion(teamRunId),
  );

  return {
    hostNodeId,
    transportSecurityMode,
    nodeDirectoryService,
    internalEnvelopeAuth,
    hostDistributedCommandClient,
    workerEventUplinkClient,
    hostNodeBridgeClient,
    workerNodeBridgeServer,
    teamRunOrchestrator,
    teamRunLocator: defaultTeamRunLocator,
    teamCommandIngressService,
    teamEventAggregator,
    remoteEventIdempotencyPolicy,
    runVersionFencingPolicy,
    runScopedTeamBindingRegistry,
  };
};

export const getDefaultDistributedRuntimeComposition = (): DefaultDistributedRuntimeComposition => {
  if (!cachedDefaultDistributedRuntimeComposition) {
    cachedDefaultDistributedRuntimeComposition = createDefaultDistributedRuntimeComposition();
  }
  return cachedDefaultDistributedRuntimeComposition;
};

export const getDefaultTeamCommandIngressService = (): TeamCommandIngressService =>
  getDefaultDistributedRuntimeComposition().teamCommandIngressService;

export const getDefaultTeamEventAggregator = (): TeamEventAggregator =>
  getDefaultDistributedRuntimeComposition().teamEventAggregator;

export const resetDefaultDistributedRuntimeCompositionForTests = (): void => {
  cachedDefaultDistributedRuntimeComposition = null;
};
