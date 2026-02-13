import { AgentDefinitionService } from "../../agent-definition/services/agent-definition-service.js";
import { AgentTeamDefinitionService } from "../../agent-team-definition/services/agent-team-definition-service.js";
import {
  NodeCatalogRemoteClient,
} from "./node-catalog-remote-client.js";
import type {
  FederatedAgentRef,
  FederatedCatalogNodeInput,
  FederatedNodeCatalog,
  FederatedTeamRef,
} from "./catalog-types.js";

type AgentDefinitionServiceLike = {
  getAllAgentDefinitions: AgentDefinitionService["getAllAgentDefinitions"];
};

type AgentTeamDefinitionServiceLike = {
  getAllDefinitions: AgentTeamDefinitionService["getAllDefinitions"];
};

const normalizeOptionalString = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const ensureHttpProtocol = (value: string): string => {
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  return `http://${value}`;
};

const normalizeBaseUrl = (baseUrl: string): string => {
  const parsed = new URL(ensureHttpProtocol(baseUrl.trim()));
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
};

const resolveNodeScopedAvatarUrl = (
  nodeBaseUrl: string,
  avatarUrl: string | null | undefined,
): string | null => {
  const normalizedAvatar = normalizeOptionalString(avatarUrl);
  if (!normalizedAvatar) {
    return null;
  }
  if (/^https?:\/\//i.test(normalizedAvatar)) {
    return normalizedAvatar;
  }

  try {
    const normalizedNodeBase = normalizeBaseUrl(nodeBaseUrl);
    return new URL(normalizedAvatar, `${normalizedNodeBase}/`).toString();
  } catch {
    return normalizedAvatar;
  }
};

const toTeamSummary = (nodes: unknown): { memberCount: number; nestedTeamCount: number } => {
  if (!Array.isArray(nodes)) {
    return { memberCount: 0, nestedTeamCount: 0 };
  }

  const nestedTeamCount = nodes.reduce((count, member) => {
    if (!member || typeof member !== "object") {
      return count;
    }
    return (member as { referenceType?: unknown }).referenceType === "AGENT_TEAM" ? count + 1 : count;
  }, 0);

  return {
    memberCount: nodes.length,
    nestedTeamCount,
  };
};

const normalizeNodeType = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
};

const isRemoteNode = (node: FederatedCatalogNodeInput): boolean =>
  normalizeNodeType(node.nodeType ?? null) === "remote";

export class FederatedCatalogService {
  private readonly agentDefinitionService: AgentDefinitionServiceLike;
  private readonly agentTeamDefinitionService: AgentTeamDefinitionServiceLike;
  private readonly nodeCatalogRemoteClient: NodeCatalogRemoteClient;

  constructor(options: {
    agentDefinitionService?: AgentDefinitionServiceLike;
    agentTeamDefinitionService?: AgentTeamDefinitionServiceLike;
    nodeCatalogRemoteClient?: NodeCatalogRemoteClient;
  } = {}) {
    this.agentDefinitionService = options.agentDefinitionService ?? AgentDefinitionService.getInstance();
    this.agentTeamDefinitionService =
      options.agentTeamDefinitionService ?? AgentTeamDefinitionService.getInstance();
    this.nodeCatalogRemoteClient = options.nodeCatalogRemoteClient ?? new NodeCatalogRemoteClient();
  }

  async listCatalogByNodes(input: { nodes: FederatedCatalogNodeInput[] }): Promise<FederatedNodeCatalog[]> {
    const uniqueNodes = this.uniqueNodes(input.nodes);

    const results = await Promise.all(
      uniqueNodes.map(async (node) => {
        if (isRemoteNode(node)) {
          return this.nodeCatalogRemoteClient.fetchNodeCatalog(node);
        }
        return this.listLocalCatalog(node);
      }),
    );

    return results;
  }

  private async listLocalCatalog(node: FederatedCatalogNodeInput): Promise<FederatedNodeCatalog> {
    try {
      const [agentDefinitions, teamDefinitions] = await Promise.all([
        this.agentDefinitionService.getAllAgentDefinitions(),
        this.agentTeamDefinitionService.getAllDefinitions(),
      ]);

      const agents: FederatedAgentRef[] = agentDefinitions.map((definition) => ({
        homeNodeId: node.nodeId,
        definitionId: String(definition.id ?? ""),
        name: definition.name,
        role: definition.role,
        description: definition.description,
        avatarUrl: resolveNodeScopedAvatarUrl(node.baseUrl, definition.avatarUrl),
        toolNames: definition.toolNames ?? [],
        skillNames: definition.skillNames ?? [],
      }));

      const teams: FederatedTeamRef[] = teamDefinitions.map((definition) => ({
        ...toTeamSummary(definition.nodes),
        homeNodeId: node.nodeId,
        definitionId: String(definition.id ?? ""),
        name: definition.name,
        description: definition.description,
        role: normalizeOptionalString(definition.role),
        avatarUrl: resolveNodeScopedAvatarUrl(node.baseUrl, definition.avatarUrl),
        coordinatorMemberName: definition.coordinatorMemberName,
      }));

      return {
        nodeId: node.nodeId,
        nodeName: node.nodeName,
        baseUrl: node.baseUrl,
        status: "ready",
        errorMessage: null,
        agents,
        teams,
      };
    } catch (error) {
      return {
        nodeId: node.nodeId,
        nodeName: node.nodeName,
        baseUrl: node.baseUrl,
        status: "degraded",
        errorMessage: error instanceof Error ? error.message : String(error),
        agents: [],
        teams: [],
      };
    }
  }

  private uniqueNodes(nodes: FederatedCatalogNodeInput[]): FederatedCatalogNodeInput[] {
    const byNodeId = new Map<string, FederatedCatalogNodeInput>();
    for (const node of nodes) {
      const nodeId = node.nodeId.trim();
      if (!nodeId) {
        continue;
      }
      byNodeId.set(nodeId, {
        ...node,
        nodeId,
        nodeName: node.nodeName.trim() || nodeId,
      });
    }
    return Array.from(byNodeId.values());
  }
}
