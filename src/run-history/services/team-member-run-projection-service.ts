import type { RunProjection } from "./run-projection-service.js";
import { getRunProjectionService, RunProjectionService } from "./run-projection-service.js";
import {
  getTeamRunHistoryService,
  TeamRunHistoryService,
} from "./team-run-history-service.js";
import type { TeamRunMemberBinding } from "../domain/team-models.js";
import { normalizeMemberRouteKey } from "../utils/team-member-agent-id.js";
import { AgentTeamDefinitionService } from "../../agent-team-definition/services/agent-team-definition-service.js";
import { getDefaultDistributedRuntimeComposition } from "../../distributed/bootstrap/default-distributed-runtime-composition.js";

type FetchLike = typeof fetch;

type RemoteRunProjectionPayload = {
  agentId?: unknown;
  summary?: unknown;
  lastActivityAt?: unknown;
  conversation?: unknown;
};

type RemoteRunProjectionGraphqlData = {
  getRunProjection?: RemoteRunProjectionPayload;
};

type GraphqlResponse<TData> = {
  data?: TData;
  errors?: Array<{ message?: string }>;
};

const DEFAULT_TIMEOUT_MS = 5_000;

const REMOTE_RUN_PROJECTION_QUERY = `
query GetRunProjection($agentId: String!) {
  getRunProjection(agentId: $agentId) {
    agentId
    summary
    lastActivityAt
    conversation
  }
}
`;

const logger = {
  warn: (...args: unknown[]) => console.warn(...args),
};

const normalizeRequiredString = (value: string, fieldName: string): string => {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldName} is required.`);
  }
  return normalized;
};

const normalizeOptionalString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const normalizeBaseUrl = (baseUrl: string): string => {
  const parsed = new URL(baseUrl.trim());
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/+$/, "");
};

const toNormalizedMemberRouteKey = (value: string): string | null => {
  try {
    return normalizeMemberRouteKey(value);
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const resolveMemberBinding = (
  bindings: TeamRunMemberBinding[],
  memberRouteKey: string,
): TeamRunMemberBinding | null => {
  const normalizedRouteKey = toNormalizedMemberRouteKey(memberRouteKey) ?? memberRouteKey;
  for (const binding of bindings) {
    const bindingRouteKey =
      toNormalizedMemberRouteKey(binding.memberRouteKey) ?? binding.memberRouteKey.trim();
    if (bindingRouteKey === normalizedRouteKey) {
      return binding;
    }
  }
  return null;
};

export class TeamMemberRunProjectionService {
  private readonly teamRunHistoryService: TeamRunHistoryService;
  private readonly runProjectionService: RunProjectionService;
  private readonly teamDefinitionService: AgentTeamDefinitionService;
  private readonly fetchFn: FetchLike;
  private readonly timeoutMs: number;
  private readonly resolveNodeBaseUrlFn: (nodeId: string) => string | null;
  private readonly isLocalNodeIdFn: (nodeId: string) => boolean;

  constructor(options: {
    teamRunHistoryService?: TeamRunHistoryService;
    runProjectionService?: RunProjectionService;
    teamDefinitionService?: AgentTeamDefinitionService;
    fetchFn?: FetchLike;
    timeoutMs?: number;
    resolveNodeBaseUrl?: (nodeId: string) => string | null;
    isLocalNodeId?: (nodeId: string) => boolean;
  } = {}) {
    this.teamRunHistoryService = options.teamRunHistoryService ?? getTeamRunHistoryService();
    this.runProjectionService = options.runProjectionService ?? getRunProjectionService();
    this.teamDefinitionService = options.teamDefinitionService ?? AgentTeamDefinitionService.getInstance();
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.resolveNodeBaseUrlFn = options.resolveNodeBaseUrl ?? this.resolveNodeBaseUrlFromRuntime.bind(this);
    this.isLocalNodeIdFn = options.isLocalNodeId ?? this.isLocalNodeIdFromRuntime.bind(this);
  }

  async getProjection(teamId: string, memberRouteKey: string): Promise<RunProjection> {
    const normalizedTeamId = normalizeRequiredString(teamId, "teamId");
    const normalizedMemberRouteKey = normalizeRequiredString(memberRouteKey, "memberRouteKey");
    const resumeConfig = await this.teamRunHistoryService.getTeamRunResumeConfig(normalizedTeamId);
    const binding = resolveMemberBinding(resumeConfig.manifest.memberBindings, normalizedMemberRouteKey);
    if (!binding) {
      throw new Error(
        `Member route key '${normalizedMemberRouteKey}' not found for team '${normalizedTeamId}'.`,
      );
    }

    const localProjection = this.runProjectionService.getProjection(binding.memberAgentId);
    if (localProjection.conversation.length > 0) {
      return localProjection;
    }

    const remoteNodeId = await this.resolveRemoteNodeId({
      teamDefinitionId: resumeConfig.manifest.teamDefinitionId,
      memberBinding: binding,
    });
    if (!remoteNodeId) {
      return localProjection;
    }

    const remoteBaseUrl = this.resolveRemoteBaseUrl(remoteNodeId);
    if (!remoteBaseUrl) {
      return localProjection;
    }

    const remoteProjection = await this.fetchRemoteProjection({
      remoteBaseUrl,
      memberAgentId: binding.memberAgentId,
    });
    return remoteProjection ?? localProjection;
  }

  private async resolveRemoteNodeId(input: {
    teamDefinitionId: string;
    memberBinding: TeamRunMemberBinding;
  }): Promise<string | null> {
    const directNodeId = normalizeOptionalString(input.memberBinding.hostNodeId);
    if (directNodeId && !this.isLocalNodeIdFn(directNodeId)) {
      return directNodeId;
    }

    const definition = await this.teamDefinitionService.getDefinitionById(input.teamDefinitionId);
    if (!definition) {
      return null;
    }

    const normalizedRouteKey =
      toNormalizedMemberRouteKey(input.memberBinding.memberRouteKey) ??
      input.memberBinding.memberRouteKey.trim();
    const memberNode =
      definition.nodes.find((node) => node.memberName === input.memberBinding.memberName) ??
      definition.nodes.find((node) => {
        const normalized = toNormalizedMemberRouteKey(node.memberName);
        return normalized === normalizedRouteKey;
      });
    const resolvedNodeId = normalizeOptionalString(memberNode?.homeNodeId);
    if (!resolvedNodeId || this.isLocalNodeIdFn(resolvedNodeId)) {
      return null;
    }
    return resolvedNodeId;
  }

  private resolveRemoteBaseUrl(nodeId: string): string | null {
    return this.resolveNodeBaseUrlFn(nodeId);
  }

  private isLocalNodeIdFromRuntime(nodeId: string): boolean {
    const normalizedNodeId = normalizeOptionalString(nodeId);
    if (!normalizedNodeId) {
      return true;
    }
    if (normalizedNodeId === "embedded-local" || normalizedNodeId === "local") {
      return true;
    }
    const envNodeId = normalizeOptionalString(process.env.AUTOBYTEUS_NODE_ID);
    if (envNodeId && envNodeId === normalizedNodeId) {
      return true;
    }
    try {
      const runtimeNodeId = normalizeOptionalString(getDefaultDistributedRuntimeComposition().hostNodeId);
      return runtimeNodeId === normalizedNodeId;
    } catch {
      return false;
    }
  }

  private resolveNodeBaseUrlFromRuntime(nodeId: string): string | null {
    try {
      const runtime = getDefaultDistributedRuntimeComposition();
      const entry = runtime.nodeDirectoryService.getEntry(nodeId);
      if (!entry) {
        return null;
      }
      return normalizeBaseUrl(entry.baseUrl);
    } catch {
      return null;
    }
  }

  private async fetchRemoteProjection(input: {
    remoteBaseUrl: string;
    memberAgentId: string;
  }): Promise<RunProjection | null> {
    const endpoint = `${normalizeBaseUrl(input.remoteBaseUrl)}/graphql`;
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), this.timeoutMs);

    try {
      const response = await this.fetchFn(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query: REMOTE_RUN_PROJECTION_QUERY,
          variables: {
            agentId: input.memberAgentId,
          },
        }),
        signal: abortController.signal,
      });

      if (!response.ok) {
        logger.warn(
          `Failed to fetch remote run projection for '${input.memberAgentId}' (${response.status}).`,
        );
        return null;
      }

      const payload = (await response.json()) as GraphqlResponse<RemoteRunProjectionGraphqlData>;
      if (Array.isArray(payload.errors) && payload.errors.length > 0) {
        logger.warn(
          `Remote run projection query failed for '${input.memberAgentId}': ${payload.errors
            .map((error) => error.message ?? "unknown")
            .join(", ")}`,
        );
        return null;
      }

      const projectionPayload = isRecord(payload.data) ? payload.data.getRunProjection : null;
      if (!isRecord(projectionPayload) || !Array.isArray(projectionPayload.conversation)) {
        return null;
      }

      return {
        agentId: normalizeOptionalString(projectionPayload.agentId) ?? input.memberAgentId,
        summary: normalizeOptionalString(projectionPayload.summary),
        lastActivityAt: normalizeOptionalString(projectionPayload.lastActivityAt),
        conversation: projectionPayload.conversation as RunProjection["conversation"],
      };
    } catch (error) {
      logger.warn(
        `Remote run projection request failed for '${input.memberAgentId}': ${String(error)}`,
      );
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

let cachedTeamMemberRunProjectionService: TeamMemberRunProjectionService | null = null;

export const getTeamMemberRunProjectionService = (): TeamMemberRunProjectionService => {
  if (!cachedTeamMemberRunProjectionService) {
    cachedTeamMemberRunProjectionService = new TeamMemberRunProjectionService();
  }
  return cachedTeamMemberRunProjectionService;
};
