import {
  AgentInputUserMessage,
} from "autobyteus-ts";
import {
  type InterAgentMessageRequestEvent,
} from "autobyteus-ts/agent-team/events/agent-team-events.js";
import { AgentTeamDefinitionService } from "../../agent-team-definition/services/agent-team-definition-service.js";
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
import { RunVersionFencingPolicy } from "../policies/run-version-fencing-policy.js";
import { ToolApprovalConcurrencyPolicy } from "../policies/tool-approval-concurrency-policy.js";
import { TeamRoutingPortAdapter } from "../routing/team-routing-port-adapter.js";
import { TeamRoutingPortAdapterRegistry } from "../routing/team-routing-port-adapter-registry.js";
import {
  RunScopedTeamBindingRegistry,
  TeamRunNotBoundError,
} from "../runtime-binding/run-scoped-team-binding-registry.js";
import { InternalEnvelopeAuth, type TransportSecurityMode } from "../security/internal-envelope-auth.js";
import { TeamRunOrchestrator } from "../team-run-orchestrator/team-run-orchestrator.js";
import { HostDistributedCommandClient } from "../transport/internal-http/host-distributed-command-client.js";
import { WorkerEventUplinkClient } from "../transport/internal-http/worker-event-uplink-client.js";
import { RemoteMemberExecutionGateway } from "../worker-execution/remote-member-execution-gateway.js";

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
  runVersionFencingPolicy: RunVersionFencingPolicy;
  runScopedTeamBindingRegistry: RunScopedTeamBindingRegistry;
};

const normalizeOptionalString = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const normalizeRequiredString = (value: string, field: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return normalized;
};

const parseSecurityModeFromEnv = (): TransportSecurityMode => {
  const raw = normalizeOptionalString(process.env.AUTOBYTEUS_DISTRIBUTED_SECURITY_MODE);
  return raw === "trusted_lan" ? "trusted_lan" : "strict_signed";
};

const parseAllowedNodeIds = (hostNodeId: string): string[] | null => {
  const raw = normalizeOptionalString(process.env.AUTOBYTEUS_DISTRIBUTED_ALLOWED_NODE_IDS);
  if (!raw) {
    return null;
  }
  const values = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (!values.includes(hostNodeId)) {
    values.push(hostNodeId);
  }
  return values;
};

const resolveLocalBaseUrl = (): string => {
  const explicit = normalizeOptionalString(process.env.AUTOBYTEUS_DISTRIBUTED_LOCAL_BASE_URL);
  if (explicit) {
    return explicit;
  }
  const fromServerHost = normalizeOptionalString(process.env.AUTOBYTEUS_SERVER_HOST);
  if (fromServerHost) {
    return fromServerHost;
  }
  return "http://localhost:8000";
};

const buildHostOnlyNodeDirectoryEntries = (hostNodeId: string) => [
  {
    nodeId: hostNodeId,
    baseUrl: resolveLocalBaseUrl(),
    isHealthy: true,
    supportsAgentExecution: true,
  },
];

const buildResolveSecretByKeyId = (): ((keyId: string) => string | null) => {
  const byKeyId = new Map<string, string>();
  const configuredKeyId =
    normalizeOptionalString(process.env.AUTOBYTEUS_DISTRIBUTED_KEY_ID) ?? "default";
  const configuredSecret =
    normalizeOptionalString(process.env.AUTOBYTEUS_DISTRIBUTED_SHARED_SECRET) ??
    "autobyteus-dev-internal-secret";
  byKeyId.set(configuredKeyId, configuredSecret);

  const rawSecrets = normalizeOptionalString(process.env.AUTOBYTEUS_DISTRIBUTED_SHARED_SECRETS_JSON);
  if (rawSecrets) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawSecrets);
    } catch (error) {
      throw new Error(
        `AUTOBYTEUS_DISTRIBUTED_SHARED_SECRETS_JSON must be valid JSON object: ${String(error)}`,
      );
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string" && key.trim().length > 0 && value.trim().length > 0) {
          byKeyId.set(key.trim(), value.trim());
        }
      }
    }
  }

  return (keyId: string) => byKeyId.get(keyId) ?? null;
};

const normalizeUserMessageInput = (raw: unknown): AgentInputUserMessage => {
  if (raw instanceof AgentInputUserMessage) {
    return raw;
  }
  if (!raw || typeof raw !== "object") {
    throw new Error("Envelope userMessage payload must be an object.");
  }
  const payload = raw as Record<string, unknown>;
  const content = payload.content;
  if (typeof content !== "string") {
    throw new Error("Envelope userMessage.content must be a string.");
  }
  const contextFilesValue = payload.context_files ?? payload.contextFiles ?? null;
  const normalizedContextFiles = Array.isArray(contextFilesValue)
    ? contextFilesValue.map((entry) => {
        if (!entry || typeof entry !== "object") {
          return entry;
        }
        const context = entry as Record<string, unknown>;
        return {
          uri: context.uri,
          file_type: context.file_type ?? context.fileType ?? null,
          file_name: context.file_name ?? context.fileName ?? null,
          metadata: context.metadata ?? {},
        };
      })
    : null;

  return AgentInputUserMessage.fromDict({
    content,
    sender_type: payload.sender_type ?? payload.senderType ?? undefined,
    context_files: normalizedContextFiles,
    metadata: payload.metadata ?? {},
  });
};

const getPayloadRecord = (payload: unknown): Record<string, unknown> => {
  if (!payload || typeof payload !== "object") {
    throw new Error("Envelope payload must be an object.");
  }
  return payload as Record<string, unknown>;
};

const normalizeMemberConfigSnapshot = (
  raw: unknown,
  fieldPrefix: string,
): TeamMemberConfigInput => {
  if (!raw || typeof raw !== "object") {
    throw new Error(`${fieldPrefix} must be an object.`);
  }
  const payload = raw as Record<string, unknown>;
  const memberName = normalizeRequiredString(
    String(payload.memberName ?? ""),
    `${fieldPrefix}.memberName`,
  );
  const agentDefinitionId = normalizeRequiredString(
    String(payload.agentDefinitionId ?? ""),
    `${fieldPrefix}.agentDefinitionId`,
  );
  const llmModelIdentifier = normalizeRequiredString(
    String(payload.llmModelIdentifier ?? ""),
    `${fieldPrefix}.llmModelIdentifier`,
  );
  if (typeof payload.autoExecuteTools !== "boolean") {
    throw new Error(`${fieldPrefix}.autoExecuteTools must be a boolean.`);
  }

  const workspaceId =
    payload.workspaceId === null || payload.workspaceId === undefined
      ? null
      : normalizeRequiredString(String(payload.workspaceId), `${fieldPrefix}.workspaceId`);
  const llmConfig =
    payload.llmConfig && typeof payload.llmConfig === "object" && !Array.isArray(payload.llmConfig)
      ? (payload.llmConfig as Record<string, unknown>)
      : null;

  return {
    memberName,
    agentDefinitionId,
    llmModelIdentifier,
    autoExecuteTools: payload.autoExecuteTools,
    workspaceId,
    llmConfig,
  };
};

const normalizeMemberConfigSnapshotList = (raw: unknown): TeamMemberConfigInput[] => {
  if (!Array.isArray(raw)) {
    throw new Error("payload.memberConfigs must be an array.");
  }
  if (raw.length === 0) {
    throw new Error("payload.memberConfigs must include at least one member config.");
  }
  return raw.map((entry, index) => normalizeMemberConfigSnapshot(entry, `payload.memberConfigs[${index}]`));
};

const resolveTeamByDefinitionId = (
  teamDefinitionId: string,
  teamInstanceManager: AgentTeamInstanceManager,
): TeamLike => {
  const teamId = teamInstanceManager.getTeamIdByDefinitionId(teamDefinitionId);
  if (!teamId) {
    throw new TeamCommandIngressError(
      "TEAM_NOT_FOUND",
      `No active team instance found for definition '${teamDefinitionId}'.`,
    );
  }
  const team = teamInstanceManager.getTeamInstance(teamId) as TeamLike | null;
  if (!team) {
    throw new TeamCommandIngressError("TEAM_NOT_FOUND", `Team '${teamId}' not found.`);
  }
  return team;
};

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
      await hostDistributedCommandClient.sendCommand(targetNodeId, envelope);
    },
  });
  const runScopedTeamBindingRegistry = new RunScopedTeamBindingRegistry();

  const resolveBoundRuntimeTeam = (input: {
    teamRunId: string;
    expectedTeamDefinitionId?: string | null;
  }): {
    team: TeamLike;
    teamDefinitionId: string;
  } => {
    let binding;
    try {
      binding = runScopedTeamBindingRegistry.resolveRun(input.teamRunId);
    } catch (error) {
      if (error instanceof TeamRunNotBoundError) {
        throw new TeamCommandIngressError(
          "TEAM_RUN_NOT_BOUND",
          `Run '${input.teamRunId}' is not bound on this worker.`,
        );
      }
      throw error;
    }

    if (
      input.expectedTeamDefinitionId &&
      input.expectedTeamDefinitionId !== binding.teamDefinitionId
    ) {
      throw new TeamCommandIngressError(
        "TEAM_BINDING_MISMATCH",
        `Run '${input.teamRunId}' is bound to definition '${binding.teamDefinitionId}', but envelope targeted '${input.expectedTeamDefinitionId}'.`,
      );
    }

    return {
      team: resolveTeamById(binding.runtimeTeamId, teamInstanceManager),
      teamDefinitionId: binding.teamDefinitionId,
    };
  };

  const resolveBootstrapConfigSnapshot = (teamDefinitionId: string): TeamMemberConfigInput[] => {
    const memberConfigs = teamInstanceManager.getTeamMemberConfigsByDefinitionId(teamDefinitionId);
    if (memberConfigs.length === 0) {
      throw new TeamCommandIngressError(
        "TEAM_BOOTSTRAP_CONFIG_UNAVAILABLE",
        `No member config snapshot is available for team definition '${teamDefinitionId}'.`,
      );
    }
    return memberConfigs;
  };

  const dispatchRemoteBootstrapEnvelope = async (input: {
    targetNodeId: string;
    teamRunId: string;
    runVersion: string | number;
    teamDefinitionId: string;
  }): Promise<void> => {
    const memberConfigs = resolveBootstrapConfigSnapshot(input.teamDefinitionId);
    await hostNodeBridgeClient.sendCommand(
      input.targetNodeId,
      envelopeBuilder.buildEnvelope({
        teamRunId: input.teamRunId,
        runVersion: input.runVersion,
        kind: "RUN_BOOTSTRAP",
        payload: {
          teamDefinitionId: input.teamDefinitionId,
          memberConfigs,
        },
      }),
    );
  };

  const remoteMemberExecutionGateway = new RemoteMemberExecutionGateway({
    dispatchRunBootstrap: async (envelope) => {
      const payload = getPayloadRecord(envelope.payload);
      const teamDefinitionId = normalizeRequiredString(
        String(payload.teamDefinitionId ?? ""),
        "payload.teamDefinitionId",
      );
      const memberConfigs = normalizeMemberConfigSnapshotList(payload.memberConfigs);
      const existingBinding = runScopedTeamBindingRegistry.tryResolveRun(envelope.teamRunId);
      if (existingBinding) {
        const boundTeam = teamInstanceManager.getTeamInstance(existingBinding.runtimeTeamId);
        if (boundTeam) {
          return;
        }
        runScopedTeamBindingRegistry.unbindRun(envelope.teamRunId);
      }

      let runtimeTeamId = teamInstanceManager.getTeamIdByDefinitionId(teamDefinitionId);
      if (!runtimeTeamId) {
        runtimeTeamId = await teamInstanceManager.createTeamInstance(teamDefinitionId, memberConfigs);
      } else {
        const existingTeam = teamInstanceManager.getTeamInstance(runtimeTeamId);
        if (!existingTeam) {
          runtimeTeamId = await teamInstanceManager.createTeamInstance(teamDefinitionId, memberConfigs);
        }
      }

      runScopedTeamBindingRegistry.bindRun({
        teamRunId: envelope.teamRunId,
        runVersion: envelope.runVersion,
        teamDefinitionId,
        runtimeTeamId,
        memberConfigs,
      });
    },
    dispatchUserMessage: async (envelope) => {
      const payload = getPayloadRecord(envelope.payload);
      const teamDefinitionId = normalizeRequiredString(
        String(payload.teamDefinitionId ?? ""),
        "payload.teamDefinitionId",
      );
      const targetAgentName = normalizeRequiredString(
        String(payload.targetAgentName ?? ""),
        "payload.targetAgentName",
      );
      const bound = resolveBoundRuntimeTeam({
        teamRunId: envelope.teamRunId,
        expectedTeamDefinitionId: teamDefinitionId,
      });
      const team = bound.team;
      if (!team.postMessage) {
        throw new TeamCommandIngressError(
          "TEAM_DISPATCH_UNAVAILABLE",
          `Team definition '${bound.teamDefinitionId}' does not support postMessage dispatch.`,
        );
      }
      await team.postMessage(normalizeUserMessageInput(payload.userMessage), targetAgentName);
    },
    dispatchInterAgentMessage: async (envelope) => {
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
      const bound = resolveBoundRuntimeTeam({
        teamRunId: envelope.teamRunId,
        expectedTeamDefinitionId: teamDefinitionId,
      });
      const team = bound.team;
      const managerDispatch = team.runtime?.context?.teamManager?.dispatchInterAgentMessage;
      if (typeof managerDispatch === "function") {
        await managerDispatch({
          senderAgentId,
          recipientName,
          content,
          messageType,
        } as InterAgentMessageRequestEvent);
        return;
      }
      if (!team.postMessage) {
        throw new TeamCommandIngressError(
          "TEAM_DISPATCH_UNAVAILABLE",
          `Team definition '${bound.teamDefinitionId}' cannot route inter-agent messages.`,
        );
      }
      await team.postMessage(
        AgentInputUserMessage.fromDict({ content, context_files: null }),
        recipientName,
      );
    },
    dispatchToolApproval: async (envelope) => {
      const payload = getPayloadRecord(envelope.payload);
      const teamDefinitionId = normalizeRequiredString(
        String(payload.teamDefinitionId ?? ""),
        "payload.teamDefinitionId",
      );
      const agentName = normalizeRequiredString(String(payload.agentName ?? ""), "payload.agentName");
      const toolInvocationId = normalizeRequiredString(
        String(payload.toolInvocationId ?? ""),
        "payload.toolInvocationId",
      );
      const isApproved = Boolean(payload.isApproved);
      const reason = typeof payload.reason === "string" ? payload.reason : null;
      const bound = resolveBoundRuntimeTeam({
        teamRunId: envelope.teamRunId,
        expectedTeamDefinitionId: teamDefinitionId,
      });
      const team = bound.team;
      if (!team.postToolExecutionApproval) {
        throw new TeamCommandIngressError(
          "TEAM_DISPATCH_UNAVAILABLE",
          `Team definition '${bound.teamDefinitionId}' does not support tool approvals.`,
        );
      }
      await team.postToolExecutionApproval(agentName, toolInvocationId, isApproved, reason);
    },
    dispatchControlStop: async (envelope) => {
      const binding = runScopedTeamBindingRegistry.tryResolveRun(envelope.teamRunId);
      if (!binding) {
        return;
      }
      const team = teamInstanceManager.getTeamInstance(binding.runtimeTeamId) as TeamLike | null;
      if (team && typeof team.stop === "function") {
        await team.stop();
      }
      runScopedTeamBindingRegistry.unbindRun(envelope.teamRunId);
    },
    publishEventToHost: async (event) => {
      await workerEventUplinkClient.publishRemoteEvent(event);
    },
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
        teamDefinitionId,
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
          });
        },
        dispatchLocalUserMessage: async (event) => {
          const team = resolveTeamByDefinitionId(teamDefinitionId, teamInstanceManager);
          if (!team.postMessage) {
            throw new TeamCommandIngressError(
              "TEAM_DISPATCH_UNAVAILABLE",
              `Team definition '${teamDefinitionId}' does not support postMessage dispatch.`,
            );
          }
          await team.postMessage(event.userMessage, event.targetAgentName);
        },
        dispatchLocalInterAgentMessage: async (event) => {
          const team = resolveTeamByDefinitionId(teamDefinitionId, teamInstanceManager);
          const managerDispatch = team.runtime?.context?.teamManager?.dispatchInterAgentMessage;
          if (typeof managerDispatch === "function") {
            await managerDispatch(event);
            return;
          }
          if (!team.postMessage) {
            throw new TeamCommandIngressError(
              "TEAM_DISPATCH_UNAVAILABLE",
              `Team definition '${teamDefinitionId}' cannot route inter-agent messages.`,
            );
          }
          await team.postMessage(
            AgentInputUserMessage.fromDict({ content: event.content, context_files: null }),
            event.recipientName,
          );
        },
        dispatchLocalToolApproval: async (event) => {
          const team = resolveTeamByDefinitionId(teamDefinitionId, teamInstanceManager);
          if (!team.postToolExecutionApproval) {
            throw new TeamCommandIngressError(
              "TEAM_DISPATCH_UNAVAILABLE",
              `Team definition '${teamDefinitionId}' does not support tool approvals.`,
            );
          }
          await team.postToolExecutionApproval(
            event.agentName,
            event.toolInvocationId,
            event.isApproved,
            event.reason ?? null,
          );
        },
        dispatchLocalControlStop: async () => {
          const team = resolveTeamByDefinitionId(teamDefinitionId, teamInstanceManager);
          if (typeof team.stop === "function") {
            await team.stop();
          }
        },
      }),
  });

  const teamRunLocator = new TeamRunLocator({
    teamRunOrchestrator,
    teamDefinitionService,
    teamInstanceManager,
    hostNodeId,
    defaultNodeId: hostNodeId,
    nodeSnapshotProvider: () => nodeDirectoryService.listPlacementCandidates(),
  });

  const teamCommandIngressService = new TeamCommandIngressService({
    teamRunLocator,
    teamRunOrchestrator,
    toolApprovalConcurrencyPolicy: new ToolApprovalConcurrencyPolicy(),
  });

  const teamEventAggregator = new TeamEventAggregator();
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
    teamRunLocator,
    teamCommandIngressService,
    teamEventAggregator,
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
