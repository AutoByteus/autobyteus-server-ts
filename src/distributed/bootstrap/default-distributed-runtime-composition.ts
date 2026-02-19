import {
  AgentInputUserMessage,
  AgentEventRebroadcastPayload,
  AgentTeamEventStream,
  AgentTeamStreamEvent,
  SubTeamEventRebroadcastPayload,
} from "autobyteus-ts";
import {
  type InterAgentMessageRequestEvent,
} from "autobyteus-ts/agent-team/events/agent-team-events.js";
import { createLocalTeamRoutingPortAdapter } from "autobyteus-ts/agent-team/routing/local-team-routing-port-adapter.js";
import { NodeType } from "../../agent-team-definition/domain/enums.js";
import { AgentTeamDefinitionService } from "../../agent-team-definition/services/agent-team-definition-service.js";
import {
  AgentTeamDefinition as DomainAgentTeamDefinition,
  AgentTeamDefinitionUpdate,
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
import { WorkerUplinkRoutingAdapter } from "../routing/worker-uplink-routing-adapter.js";
import {
  RunScopedTeamBindingRegistry,
  TeamRunNotBoundError,
} from "../runtime-binding/run-scoped-team-binding-registry.js";
import { InternalEnvelopeAuth, type TransportSecurityMode } from "../security/internal-envelope-auth.js";
import { TeamRunOrchestrator } from "../team-run-orchestrator/team-run-orchestrator.js";
import { HostDistributedCommandClient } from "../transport/internal-http/host-distributed-command-client.js";
import { WorkerEventUplinkClient } from "../transport/internal-http/worker-event-uplink-client.js";
import { RemoteMemberExecutionGateway } from "../worker-execution/remote-member-execution-gateway.js";
import { serializePayload } from "../../services/agent-streaming/payload-serialization.js";
import {
  normalizeDistributedBaseUrl as normalizeDistributedBaseUrlFromPolicy,
  resolveRemoteTargetForCommandDispatch,
  resolveRemoteTargetForEventUplink,
  type AddressResolutionOutcome,
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

const emitAddressResolutionLog = (input: {
  operation: "command_dispatch" | "event_uplink";
  outcome: AddressResolutionOutcome;
}): void => {
  if (input.outcome.source === "directory") {
    return;
  }
  const payload = {
    operation: input.operation,
    targetNodeId: input.outcome.targetNodeId,
    source: input.outcome.source,
    rewritten: input.outcome.rewritten,
    reason: input.outcome.reason,
    baseUrl: input.outcome.baseUrl,
  };
  console.info(`[DistributedAddressResolution] ${JSON.stringify(payload)}`);
};

const normalizeOptionalString = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const EMBEDDED_LOCAL_NODE_ID = "embedded-local";

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

export const dispatchWithWorkerLocalRoutingPort = async (input: {
  teamRunId: string;
  workerManagedRunIds: ReadonlySet<string>;
  team: TeamLike;
  dispatch: (localRoutingPort: ReturnType<typeof createLocalTeamRoutingPortAdapter>) => Promise<{
    accepted: boolean;
    errorCode?: string;
    errorMessage?: string;
  }>;
}): Promise<boolean> => {
  if (!input.workerManagedRunIds.has(input.teamRunId)) {
    return false;
  }

  await dispatchWithTeamLocalRoutingPort({
    team: input.team,
    contextLabel: `Run '${input.teamRunId}'`,
    dispatch: input.dispatch,
  });
  return true;
};

export const dispatchInterAgentMessageViaTeamManager = async (input: {
  team: TeamLike;
  event: InterAgentMessageRequestEvent;
}): Promise<boolean> => {
  const teamManager = input.team.runtime?.context?.teamManager;
  if (!teamManager || typeof teamManager.dispatchInterAgentMessage !== "function") {
    return false;
  }
  await teamManager.dispatchInterAgentMessage(input.event);
  return true;
};

const dispatchWithTeamLocalRoutingPort = async (input: {
  team: TeamLike;
  contextLabel: string;
  dispatch: (localRoutingPort: ReturnType<typeof createLocalTeamRoutingPortAdapter>) => Promise<{
    accepted: boolean;
    errorCode?: string;
    errorMessage?: string;
  }>;
}): Promise<void> => {
  const teamManager = input.team.runtime?.context?.teamManager;
  const ensureNodeIsReady = teamManager?.ensureNodeIsReady;
  if (typeof ensureNodeIsReady !== "function") {
    throw new TeamCommandIngressError(
      "TEAM_DISPATCH_UNAVAILABLE",
      `${input.contextLabel} cannot dispatch locally because TeamManager.ensureNodeIsReady is unavailable.`,
    );
  }

  const localRoutingPort = createLocalTeamRoutingPortAdapter({
    ensureNodeIsReady: ensureNodeIsReady.bind(teamManager),
  });
  const result = await input.dispatch(localRoutingPort);
  if (!result.accepted) {
    throw new TeamCommandIngressError(
      "TEAM_DISPATCH_UNAVAILABLE",
      result.errorMessage ?? result.errorCode ?? "Worker-local dispatch was rejected.",
    );
  }
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

const normalizeOptionalBootstrapBindingField = (
  value: unknown,
  field: string,
): string | null | undefined => {
  if (value === null) {
    return null;
  }
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string when provided.`);
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const normalizeBootstrapMemberBindingSnapshot = (
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
  const workspaceRootPath = normalizeOptionalBootstrapBindingField(
    payload.workspaceRootPath,
    `${fieldPrefix}.workspaceRootPath`,
  );
  const llmConfig =
    payload.llmConfig && typeof payload.llmConfig === "object" && !Array.isArray(payload.llmConfig)
      ? (payload.llmConfig as Record<string, unknown>)
      : null;
  const memberRouteKey = normalizeOptionalBootstrapBindingField(
    payload.memberRouteKey,
    `${fieldPrefix}.memberRouteKey`,
  );
  const memberAgentId = normalizeOptionalBootstrapBindingField(
    payload.memberAgentId,
    `${fieldPrefix}.memberAgentId`,
  );
  const memoryDir = normalizeOptionalBootstrapBindingField(
    payload.memoryDir,
    `${fieldPrefix}.memoryDir`,
  );

  return {
    memberName,
    agentDefinitionId,
    llmModelIdentifier,
    autoExecuteTools: payload.autoExecuteTools,
    workspaceId,
    workspaceRootPath,
    llmConfig,
    memberRouteKey,
    memberAgentId,
    memoryDir,
  };
};

const normalizeBootstrapNodeType = (value: unknown, field: string): NodeType => {
  if (value === NodeType.AGENT || value === NodeType.AGENT_TEAM) {
    return value;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a valid node type string.`);
  }
  const normalized = value.trim().toUpperCase();
  if (normalized === NodeType.AGENT) {
    return NodeType.AGENT;
  }
  if (normalized === NodeType.AGENT_TEAM) {
    return NodeType.AGENT_TEAM;
  }
  throw new Error(`${field} must be either '${NodeType.AGENT}' or '${NodeType.AGENT_TEAM}'.`);
};

const normalizeBootstrapTeamDefinitionSnapshot = (
  raw: unknown,
): DomainAgentTeamDefinition | null => {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (!raw || typeof raw !== "object") {
    throw new Error("payload.teamDefinitionSnapshot must be an object when provided.");
  }
  const payload = raw as Record<string, unknown>;
  const name = normalizeRequiredString(String(payload.name ?? ""), "payload.teamDefinitionSnapshot.name");
  const description = normalizeRequiredString(
    String(payload.description ?? ""),
    "payload.teamDefinitionSnapshot.description",
  );
  const coordinatorMemberName = normalizeRequiredString(
    String(payload.coordinatorMemberName ?? ""),
    "payload.teamDefinitionSnapshot.coordinatorMemberName",
  );
  if (!Array.isArray(payload.nodes) || payload.nodes.length === 0) {
    throw new Error("payload.teamDefinitionSnapshot.nodes must be a non-empty array.");
  }

  const nodes = payload.nodes.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`payload.teamDefinitionSnapshot.nodes[${index}] must be an object.`);
    }
    const node = entry as Record<string, unknown>;
    const memberName = normalizeRequiredString(
      String(node.memberName ?? ""),
      `payload.teamDefinitionSnapshot.nodes[${index}].memberName`,
    );
    const referenceId = normalizeRequiredString(
      String(node.referenceId ?? ""),
      `payload.teamDefinitionSnapshot.nodes[${index}].referenceId`,
    );
    const referenceType = normalizeBootstrapNodeType(
      node.referenceType,
      `payload.teamDefinitionSnapshot.nodes[${index}].referenceType`,
    );
    const homeNodeId =
      normalizeOptionalString(
        typeof node.homeNodeId === "string" ? node.homeNodeId : null,
      ) ?? "embedded-local";
    return new DomainTeamMember({
      memberName,
      referenceId,
      referenceType,
      homeNodeId,
    });
  });

  return new DomainAgentTeamDefinition({
    name,
    description,
    coordinatorMemberName,
    nodes,
    role: normalizeOptionalString(typeof payload.role === "string" ? payload.role : null),
    avatarUrl: normalizeOptionalString(typeof payload.avatarUrl === "string" ? payload.avatarUrl : null),
  });
};

const serializeTeamDefinitionSnapshot = (definition: DomainAgentTeamDefinition): Record<string, unknown> => ({
  name: definition.name,
  description: definition.description,
  coordinatorMemberName: definition.coordinatorMemberName,
  role: definition.role ?? null,
  avatarUrl: definition.avatarUrl ?? null,
  nodes: definition.nodes.map((node) => ({
    memberName: node.memberName,
    referenceId: node.referenceId,
    referenceType: node.referenceType,
    homeNodeId: node.homeNodeId ?? "embedded-local",
  })),
});

const normalizeHomeNodeId = (value: string | null | undefined): string => {
  const normalized = normalizeOptionalString(value);
  return normalized ?? EMBEDDED_LOCAL_NODE_ID;
};

const buildTeamDefinitionNodeSignature = (definition: DomainAgentTeamDefinition): string[] =>
  definition.nodes
    .map((node) =>
      [
        normalizeRequiredString(node.memberName, "teamDefinition.nodes[].memberName"),
        normalizeRequiredString(node.referenceId, "teamDefinition.nodes[].referenceId"),
        normalizeBootstrapNodeType(node.referenceType, "teamDefinition.nodes[].referenceType"),
        normalizeHomeNodeId(node.homeNodeId),
      ].join("|"),
    )
    .sort();

const teamDefinitionMatchesSnapshot = (
  existing: DomainAgentTeamDefinition,
  snapshot: DomainAgentTeamDefinition,
): boolean => {
  if (existing.coordinatorMemberName !== snapshot.coordinatorMemberName) {
    return false;
  }
  const existingNodeSignature = buildTeamDefinitionNodeSignature(existing);
  const snapshotNodeSignature = buildTeamDefinitionNodeSignature(snapshot);
  if (existingNodeSignature.length !== snapshotNodeSignature.length) {
    return false;
  }
  for (let index = 0; index < existingNodeSignature.length; index += 1) {
    if (existingNodeSignature[index] !== snapshotNodeSignature[index]) {
      return false;
    }
  }
  return true;
};

const toTeamDefinitionUpdate = (
  snapshot: DomainAgentTeamDefinition,
): AgentTeamDefinitionUpdate =>
  new AgentTeamDefinitionUpdate({
    name: snapshot.name,
    description: snapshot.description,
    coordinatorMemberName: snapshot.coordinatorMemberName,
    role: snapshot.role ?? null,
    avatarUrl: snapshot.avatarUrl ?? null,
    nodes: snapshot.nodes.map(
      (node) =>
        new DomainTeamMember({
          memberName: node.memberName,
          referenceId: node.referenceId,
          referenceType: node.referenceType,
          homeNodeId: normalizeHomeNodeId(node.homeNodeId),
        }),
    ),
  });

const normalizeMemberBindingForComparison = (binding: TeamMemberConfigInput) => ({
  memberName: normalizeRequiredString(binding.memberName, "memberBinding.memberName"),
  memberRouteKey: normalizeOptionalString(binding.memberRouteKey ?? null),
  memberAgentId: normalizeOptionalString(binding.memberAgentId ?? null),
  agentDefinitionId: normalizeRequiredString(
    binding.agentDefinitionId,
    "memberBinding.agentDefinitionId",
  ),
  llmModelIdentifier: normalizeRequiredString(
    binding.llmModelIdentifier,
    "memberBinding.llmModelIdentifier",
  ),
  autoExecuteTools: binding.autoExecuteTools,
  workspaceId: normalizeOptionalString(binding.workspaceId ?? null),
  workspaceRootPath: normalizeOptionalString(binding.workspaceRootPath ?? null),
  llmConfig: binding.llmConfig ?? null,
  memoryDir: normalizeOptionalString(binding.memoryDir ?? null),
});

const memberBindingsMatch = (
  existing: TeamMemberConfigInput[],
  requested: TeamMemberConfigInput[],
): boolean => {
  if (existing.length !== requested.length) {
    return false;
  }
  const sortKey = (binding: ReturnType<typeof normalizeMemberBindingForComparison>): string =>
    [binding.memberRouteKey ?? binding.memberName, binding.memberAgentId ?? ""].join("|");
  const existingNormalized = existing
    .map(normalizeMemberBindingForComparison)
    .sort((left, right) => sortKey(left).localeCompare(sortKey(right)));
  const requestedNormalized = requested
    .map(normalizeMemberBindingForComparison)
    .sort((left, right) => sortKey(left).localeCompare(sortKey(right)));
  return JSON.stringify(existingNormalized) === JSON.stringify(requestedNormalized);
};

const normalizeBootstrapMemberBindingSnapshotList = (
  payload: Record<string, unknown>,
): TeamMemberConfigInput[] => {
  const list = Array.isArray(payload.memberBindings)
    ? payload.memberBindings
    : Array.isArray(payload.memberConfigs)
      ? payload.memberConfigs
      : null;
  if (!Array.isArray(list)) {
    throw new Error("payload.memberBindings must be an array.");
  }
  if (list.length === 0) {
    throw new Error("payload.memberBindings must include at least one member binding.");
  }
  return list.map((entry, index) =>
    normalizeBootstrapMemberBindingSnapshot(entry, `payload.memberBindings[${index}]`),
  );
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

export const resolveBoundRuntimeTeamFromRegistries = (input: {
  teamRunId: string;
  expectedTeamDefinitionId?: string | null;
  runScopedTeamBindingRegistry: Pick<RunScopedTeamBindingRegistry, "resolveRun">;
  teamRunOrchestrator: Pick<TeamRunOrchestrator, "getRunRecord">;
  resolveTeamById: (teamId: string) => TeamLike;
  resolveTeamByDefinitionId: (teamDefinitionId: string) => TeamLike;
}): {
  team: TeamLike;
  teamDefinitionId: string;
} => {
  const normalizedTeamRunId = normalizeRequiredString(input.teamRunId, "teamRunId");

  try {
    const binding = input.runScopedTeamBindingRegistry.resolveRun(normalizedTeamRunId);
    if (
      input.expectedTeamDefinitionId &&
      input.expectedTeamDefinitionId !== binding.teamDefinitionId
    ) {
      throw new TeamCommandIngressError(
        "TEAM_BINDING_MISMATCH",
        `Run '${normalizedTeamRunId}' is bound to definition '${binding.teamDefinitionId}', but envelope targeted '${input.expectedTeamDefinitionId}'.`,
      );
    }

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
  if (
    input.expectedTeamDefinitionId &&
    input.expectedTeamDefinitionId !== hostRunRecord.teamDefinitionId
  ) {
    throw new TeamCommandIngressError(
      "TEAM_BINDING_MISMATCH",
      `Run '${normalizedTeamRunId}' is bound to definition '${hostRunRecord.teamDefinitionId}', but envelope targeted '${input.expectedTeamDefinitionId}'.`,
    );
  }

  return {
    team: input.resolveTeamByDefinitionId(hostRunRecord.teamDefinitionId),
    teamDefinitionId: hostRunRecord.teamDefinitionId,
  };
};

const normalizeRouteSegment = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const combineMemberRoutePrefix = (
  routePrefix: string | null,
  segment: string | null,
): string | null => {
  if (!segment) {
    return routePrefix;
  }
  if (!routePrefix) {
    return segment;
  }
  return `${routePrefix}/${segment}`;
};

const resolveSourceEventId = (
  teamEvent: AgentTeamStreamEvent,
  routeKey: string,
  runtimeEventType: string,
): string => {
  const teamEventId = normalizeRouteSegment(teamEvent.event_id);
  if (teamEventId) {
    return `${teamEventId}:${routeKey}:${runtimeEventType}`;
  }
  return `${routeKey}:${runtimeEventType}:${Date.now()}`;
};

export const projectRemoteExecutionEventsFromTeamEvent = (input: {
  teamEvent: AgentTeamStreamEvent;
  routePrefix?: string | null;
}): Array<{
  sourceEventId: string;
  memberName: string;
  agentId: string | null;
  eventType: string;
  payload: Record<string, unknown>;
}> => {
  const routePrefix = input.routePrefix ?? null;
  const sourceType = input.teamEvent.event_source_type;

  if (
    sourceType === "AGENT" &&
    input.teamEvent.data instanceof AgentEventRebroadcastPayload
  ) {
    const runtimeAgentName = normalizeRouteSegment(input.teamEvent.data.agent_name);
    const runtimeEventType = normalizeRouteSegment(
      String(input.teamEvent.data.agent_event.event_type ?? ""),
    );
    if (!runtimeAgentName || !runtimeEventType) {
      return [];
    }
    const memberRouteKey = combineMemberRoutePrefix(routePrefix, runtimeAgentName);
    if (!memberRouteKey) {
      return [];
    }
    const payload = serializePayload(input.teamEvent.data.agent_event.data);
    payload.agent_name = runtimeAgentName;
    payload.member_route_key = memberRouteKey;
    payload.event_scope = "member_scoped";
    return [
      {
        sourceEventId: resolveSourceEventId(input.teamEvent, memberRouteKey, runtimeEventType),
        memberName: memberRouteKey,
        agentId: normalizeRouteSegment(input.teamEvent.data.agent_event.agent_id),
        eventType: runtimeEventType,
        payload,
      },
    ];
  }

  if (
    sourceType === "SUB_TEAM" &&
    input.teamEvent.data instanceof SubTeamEventRebroadcastPayload &&
    input.teamEvent.data.sub_team_event instanceof AgentTeamStreamEvent
  ) {
    const subTeamNodeName = normalizeRouteSegment(input.teamEvent.data.sub_team_node_name);
    const nextPrefix = combineMemberRoutePrefix(routePrefix, subTeamNodeName);
    return projectRemoteExecutionEventsFromTeamEvent({
      teamEvent: input.teamEvent.data.sub_team_event,
      routePrefix: nextPrefix,
    });
  }

  return [];
};

type TeamEventForwarder = {
  close: () => Promise<void>;
  task: Promise<void>;
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
  const hostNodeIdByRunId = new Map<string, string>();
  const workerManagedRunIds = new Set<string>();
  const workerTeamDefinitionIdByHostTeamDefinitionId = new Map<string, string>();
  const eventForwarderByRunId = new Map<string, TeamEventForwarder>();

  const stopEventForwarder = async (teamRunId: string): Promise<void> => {
    const forwarder = eventForwarderByRunId.get(teamRunId);
    if (!forwarder) {
      return;
    }
    eventForwarderByRunId.delete(teamRunId);
    await forwarder.close();
  };

  const clearRunTracking = (teamRunId: string): void => {
    hostNodeIdByRunId.delete(teamRunId);
    workerManagedRunIds.delete(teamRunId);
  };

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

  const startEventForwarder = (input: {
    teamRunId: string;
    runVersion: string | number;
    runtimeTeamId: string;
    sourceNodeId: string;
    eventStream: AgentTeamEventStream;
  }): TeamEventForwarder => {
    const task = (async () => {
      try {
        for await (const teamEvent of input.eventStream.allEvents()) {
          const projectedEvents = projectRemoteExecutionEventsFromTeamEvent({
            teamEvent,
          });
          for (const projectedEvent of projectedEvents) {
            try {
              await remoteMemberExecutionGateway.emitMemberEvent({
                teamRunId: input.teamRunId,
                runVersion: input.runVersion,
                sourceNodeId: input.sourceNodeId,
                sourceEventId: projectedEvent.sourceEventId,
                memberName: projectedEvent.memberName,
                agentId: projectedEvent.agentId,
                eventType: projectedEvent.eventType,
                payload: projectedEvent.payload,
              });
            } catch (error) {
              console.error(
                `Failed to uplink remote member event for run '${input.teamRunId}' on worker team '${input.runtimeTeamId}': ${String(error)}`,
              );
            }
          }
        }
      } catch (error) {
        console.error(
          `Worker team event forwarding loop failed for run '${input.teamRunId}' and team '${input.runtimeTeamId}': ${String(error)}`,
        );
      }
    })();

    return {
      task,
      close: async () => {
        await input.eventStream.close();
        try {
          await task;
        } catch {
          // ignore
        }
      },
    };
  };

  const resolveBoundRuntimeTeam = (input: {
    teamRunId: string;
    expectedTeamDefinitionId?: string | null;
  }): {
    team: TeamLike;
    teamDefinitionId: string;
  } =>
    resolveBoundRuntimeTeamFromRegistries({
      teamRunId: input.teamRunId,
      expectedTeamDefinitionId: input.expectedTeamDefinitionId,
      runScopedTeamBindingRegistry,
      teamRunOrchestrator,
      resolveTeamById: (teamId) => resolveTeamById(teamId, teamInstanceManager),
      resolveTeamByDefinitionId: (teamDefinitionId) =>
        resolveTeamByDefinitionId(teamDefinitionId, teamInstanceManager),
    });

  const resolveBootstrapBindingSnapshot = (teamDefinitionId: string): TeamMemberConfigInput[] => {
    const memberBindings = teamInstanceManager.getTeamMemberConfigsByDefinitionId(teamDefinitionId);
    if (memberBindings.length === 0) {
      throw new TeamCommandIngressError(
        "TEAM_BOOTSTRAP_CONFIG_UNAVAILABLE",
        `No member config snapshot is available for team definition '${teamDefinitionId}'.`,
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
    const memberBindings = resolveBootstrapBindingSnapshot(input.teamDefinitionId);
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

  const remoteMemberExecutionGateway = new RemoteMemberExecutionGateway({
    dispatchRunBootstrap: async (envelope) => {
      const payload = getPayloadRecord(envelope.payload);
      const hostTeamDefinitionId = normalizeRequiredString(
        String(payload.teamDefinitionId ?? ""),
        "payload.teamDefinitionId",
      );
      const teamDefinitionSnapshot = normalizeBootstrapTeamDefinitionSnapshot(
        payload.teamDefinitionSnapshot,
      );
      const workerTeamDefinitionId = await resolveWorkerTeamDefinitionId({
        hostTeamDefinitionId,
        snapshot: teamDefinitionSnapshot,
      });
      const memberBindings = normalizeBootstrapMemberBindingSnapshotList(payload);
      const bootstrapHostNodeId =
        normalizeRouteSegment(payload.hostNodeId) ?? hostNodeId;
      ensureHostNodeDirectoryEntryForWorkerRun(bootstrapHostNodeId);
      const existingBinding = runScopedTeamBindingRegistry.tryResolveRun(envelope.teamRunId);
      if (existingBinding) {
        const boundTeam = teamInstanceManager.getTeamInstance(existingBinding.runtimeTeamId);
        if (boundTeam) {
          hostNodeIdByRunId.set(envelope.teamRunId, bootstrapHostNodeId);
          workerManagedRunIds.add(envelope.teamRunId);
          return;
        }
        await stopEventForwarder(envelope.teamRunId);
        clearRunTracking(envelope.teamRunId);
        runScopedTeamBindingRegistry.unbindRun(envelope.teamRunId);
        teamEventAggregator.finalizeRun(envelope.teamRunId);
      }

      let runtimeTeamId = teamInstanceManager.getTeamIdByDefinitionId(workerTeamDefinitionId);
      if (!runtimeTeamId) {
        runtimeTeamId = await teamInstanceManager.createTeamInstance(workerTeamDefinitionId, memberBindings);
      } else {
        const existingTeam = teamInstanceManager.getTeamInstance(runtimeTeamId);
        if (!existingTeam) {
          runtimeTeamId = await teamInstanceManager.createTeamInstance(workerTeamDefinitionId, memberBindings);
        } else {
          const existingBindings = teamInstanceManager.getTeamMemberConfigsByDefinitionId(
            workerTeamDefinitionId,
          );
          if (!memberBindingsMatch(existingBindings, memberBindings)) {
            await teamInstanceManager.terminateTeamInstance(runtimeTeamId);
            runtimeTeamId = await teamInstanceManager.createTeamInstance(
              workerTeamDefinitionId,
              memberBindings,
            );
          }
        }
      }

      runScopedTeamBindingRegistry.bindRun({
        teamRunId: envelope.teamRunId,
        runVersion: envelope.runVersion,
        teamDefinitionId: hostTeamDefinitionId,
        runtimeTeamId,
        memberBindings,
      });
      hostNodeIdByRunId.set(envelope.teamRunId, bootstrapHostNodeId);
      workerManagedRunIds.add(envelope.teamRunId);

      const runtimeTeam = teamInstanceManager.getTeamInstance(runtimeTeamId) as TeamLike | null;
      const teamManager = runtimeTeam?.runtime?.context?.teamManager;
      if (teamManager?.setTeamRoutingPort) {
        teamManager.setTeamRoutingPort(
          new WorkerUplinkRoutingAdapter({
            teamRunId: envelope.teamRunId,
            teamDefinitionId: hostTeamDefinitionId,
            runVersion: envelope.runVersion,
            forwardToHost: async (forwardEnvelope) => {
              await hostNodeBridgeClient.sendCommand(bootstrapHostNodeId, forwardEnvelope);
            },
          }),
        );
      }

      await stopEventForwarder(envelope.teamRunId);
      const eventStream = teamInstanceManager.getTeamEventStream(runtimeTeamId);
      if (eventStream) {
        eventForwarderByRunId.set(
          envelope.teamRunId,
          startEventForwarder({
            teamRunId: envelope.teamRunId,
            runVersion: envelope.runVersion,
            runtimeTeamId,
            sourceNodeId: hostNodeId,
            eventStream,
          }),
        );
      }
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
      const userMessage = normalizeUserMessageInput(payload.userMessage);
      const handledByWorkerLocalIngress = await dispatchWithWorkerLocalRoutingPort({
        teamRunId: envelope.teamRunId,
        workerManagedRunIds,
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
        throw new TeamCommandIngressError(
          "TEAM_DISPATCH_UNAVAILABLE",
          `Team definition '${bound.teamDefinitionId}' does not support postMessage dispatch.`,
        );
      }
      await team.postMessage(userMessage, targetAgentName);
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
      const handledByWorkerLocalIngress = await dispatchWithWorkerLocalRoutingPort({
        teamRunId: envelope.teamRunId,
        workerManagedRunIds,
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
      const handledByWorkerLocalIngress = await dispatchWithWorkerLocalRoutingPort({
        teamRunId: envelope.teamRunId,
        workerManagedRunIds,
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
        await stopEventForwarder(envelope.teamRunId);
        clearRunTracking(envelope.teamRunId);
        return;
      }
      const team = teamInstanceManager.getTeamInstance(binding.runtimeTeamId) as TeamLike | null;
      if (team && typeof team.stop === "function") {
        await team.stop();
      }
      await stopEventForwarder(envelope.teamRunId);
      clearRunTracking(envelope.teamRunId);
      runScopedTeamBindingRegistry.unbindRun(envelope.teamRunId);
      teamEventAggregator.finalizeRun(envelope.teamRunId);
    },
    publishEventToHost: async (event) => {
      const targetHostNodeId = hostNodeIdByRunId.get(event.teamRunId) ?? hostNodeId;
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
            hostNodeId: runHostNodeId,
          });
        },
        dispatchLocalUserMessage: async (event) => {
          const team = resolveTeamByDefinitionId(teamDefinitionId, teamInstanceManager);
          await dispatchWithTeamLocalRoutingPort({
            team,
            contextLabel: `Team definition '${teamDefinitionId}'`,
            dispatch: async (localRoutingPort) => localRoutingPort.dispatchUserMessage(event),
          });
        },
        dispatchLocalInterAgentMessage: async (event) => {
          const team = resolveTeamByDefinitionId(teamDefinitionId, teamInstanceManager);
          await dispatchWithTeamLocalRoutingPort({
            team,
            contextLabel: `Team definition '${teamDefinitionId}'`,
            dispatch: async (localRoutingPort) =>
              localRoutingPort.dispatchInterAgentMessageRequest(event),
          });
        },
        dispatchLocalToolApproval: async (event) => {
          const team = resolveTeamByDefinitionId(teamDefinitionId, teamInstanceManager);
          await dispatchWithTeamLocalRoutingPort({
            team,
            contextLabel: `Team definition '${teamDefinitionId}'`,
            dispatch: async (localRoutingPort) => localRoutingPort.dispatchToolApproval(event),
          });
        },
        dispatchLocalControlStop: async () => {
          const team = resolveTeamByDefinitionId(teamDefinitionId, teamInstanceManager);
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
      team = resolveTeamByDefinitionId(runRecord.teamDefinitionId, teamInstanceManager);
    } catch {
      return;
    }

    const teamManager = team.runtime?.context?.teamManager;
    if (teamManager && typeof teamManager.setTeamRoutingPort === "function") {
      teamManager.setTeamRoutingPort(routingPort);
    }
  };

  const teamRunLocator = new TeamRunLocator({
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

  const teamCommandIngressService = new TeamCommandIngressService({
    teamRunLocator,
    teamRunOrchestrator,
    toolApprovalConcurrencyPolicy: new ToolApprovalConcurrencyPolicy(),
  });

  const teamEventAggregator = new TeamEventAggregator();
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
    teamRunLocator,
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
