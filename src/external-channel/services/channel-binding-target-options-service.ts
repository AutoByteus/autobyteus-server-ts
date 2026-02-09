import { AgentInstanceManager } from "../../agent-execution/services/agent-instance-manager.js";
import { AgentTeamInstanceManager } from "../../agent-team-execution/services/agent-team-instance-manager.js";
import type {
  ChannelBindingTargetOption,
  ChannelBindingTargetType,
} from "../domain/models.js";

type AgentManagerLike = {
  listActiveInstances(): string[];
  getAgentInstance(agentId: string): unknown | null;
};

type TeamManagerLike = {
  listActiveInstances(): string[];
  getTeamInstance(teamId: string): unknown | null;
};

export type ChannelBindingTargetOptionsServiceDeps = {
  agentManager?: AgentManagerLike;
  teamManager?: TeamManagerLike;
};

export class ChannelBindingTargetOptionsService {
  private readonly agentManager: AgentManagerLike;
  private readonly teamManager: TeamManagerLike;

  constructor(deps: ChannelBindingTargetOptionsServiceDeps = {}) {
    this.agentManager = deps.agentManager ?? AgentInstanceManager.getInstance();
    this.teamManager = deps.teamManager ?? AgentTeamInstanceManager.getInstance();
  }

  async listActiveTargetOptions(): Promise<ChannelBindingTargetOption[]> {
    const options: ChannelBindingTargetOption[] = [
      ...this.collectAgentOptions(),
      ...this.collectTeamOptions(),
    ];

    return options.sort((left, right) => {
      if (left.targetType !== right.targetType) {
        return left.targetType === "AGENT" ? -1 : 1;
      }
      const byName = left.displayName.localeCompare(right.displayName);
      if (byName !== 0) {
        return byName;
      }
      return left.targetId.localeCompare(right.targetId);
    });
  }

  async isActiveTarget(
    targetType: ChannelBindingTargetType,
    targetId: string,
  ): Promise<boolean> {
    const normalizedTargetId = normalizeRequiredString(targetId, "targetId");
    if (targetType === "AGENT") {
      return this.isActiveAgent(normalizedTargetId);
    }
    return this.isActiveTeam(normalizedTargetId);
  }

  private collectAgentOptions(): ChannelBindingTargetOption[] {
    const options: ChannelBindingTargetOption[] = [];
    const activeAgentIds = this.agentManager.listActiveInstances();

    for (const agentId of activeAgentIds) {
      const instance = this.agentManager.getAgentInstance(agentId) as
        | {
            agentId?: unknown;
            currentStatus?: unknown;
            context?: { config?: { name?: unknown }; currentStatus?: unknown };
          }
        | null;
      if (!instance) {
        continue;
      }

      const resolvedAgentId = normalizeOptionalString(instance.agentId) ?? agentId;
      options.push({
        targetType: "AGENT",
        targetId: resolvedAgentId,
        displayName:
          normalizeOptionalString(instance.context?.config?.name) ?? resolvedAgentId,
        status: toStatusLabel(instance.currentStatus ?? instance.context?.currentStatus),
      });
    }

    return options;
  }

  private collectTeamOptions(): ChannelBindingTargetOption[] {
    const options: ChannelBindingTargetOption[] = [];
    const activeTeamIds = this.teamManager.listActiveInstances();

    for (const teamId of activeTeamIds) {
      const instance = this.teamManager.getTeamInstance(teamId) as
        | {
            teamId?: unknown;
            name?: unknown;
            currentStatus?: unknown;
          }
        | null;
      if (!instance) {
        continue;
      }

      const resolvedTeamId = normalizeOptionalString(instance.teamId) ?? teamId;
      options.push({
        targetType: "TEAM",
        targetId: resolvedTeamId,
        displayName: normalizeOptionalString(instance.name) ?? resolvedTeamId,
        status: toStatusLabel(instance.currentStatus),
      });
    }

    return options;
  }

  private isActiveAgent(agentId: string): boolean {
    const activeAgentIds = this.agentManager.listActiveInstances();
    if (!activeAgentIds.includes(agentId)) {
      return false;
    }
    return this.agentManager.getAgentInstance(agentId) !== null;
  }

  private isActiveTeam(teamId: string): boolean {
    const activeTeamIds = this.teamManager.listActiveInstances();
    if (!activeTeamIds.includes(teamId)) {
      return false;
    }
    return this.teamManager.getTeamInstance(teamId) !== null;
  }
}

const normalizeRequiredString = (value: string, field: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
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

const toStatusLabel = (value: unknown): string => {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : "unknown";
  }
  if (value === null || value === undefined) {
    return "unknown";
  }
  return String(value);
};
