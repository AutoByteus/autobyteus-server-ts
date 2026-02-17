import type { TeamMemberConfigInput } from "../../agent-team-execution/services/agent-team-instance-manager.js";
import type { RunVersion } from "../envelope/envelope-builder.js";

export type RunScopedTeamBinding = {
  teamRunId: string;
  runVersion: RunVersion;
  teamDefinitionId: string;
  runtimeTeamId: string;
  memberBindings: TeamMemberConfigInput[];
  boundAtIso: string;
};

type BindRunInput = {
  teamRunId: string;
  runVersion: RunVersion;
  teamDefinitionId: string;
  runtimeTeamId: string;
  memberBindings: TeamMemberConfigInput[];
};

const normalizeRequiredString = (value: string, field: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return normalized;
};

const cloneMemberConfigInput = (config: TeamMemberConfigInput): TeamMemberConfigInput => ({
  memberName: config.memberName,
  agentDefinitionId: config.agentDefinitionId,
  llmModelIdentifier: config.llmModelIdentifier,
  autoExecuteTools: config.autoExecuteTools,
  workspaceId: config.workspaceId ?? null,
  llmConfig: config.llmConfig ? { ...config.llmConfig } : null,
  memberRouteKey: config.memberRouteKey ?? null,
  memberAgentId: config.memberAgentId ?? null,
  memoryDir: config.memoryDir ?? null,
});

const cloneBinding = (binding: RunScopedTeamBinding): RunScopedTeamBinding => ({
  teamRunId: binding.teamRunId,
  runVersion: binding.runVersion,
  teamDefinitionId: binding.teamDefinitionId,
  runtimeTeamId: binding.runtimeTeamId,
  memberBindings: binding.memberBindings.map((item) => cloneMemberConfigInput(item)),
  boundAtIso: binding.boundAtIso,
});

export class TeamRunNotBoundError extends Error {
  readonly teamRunId: string;

  constructor(teamRunId: string) {
    super(`No run-scoped team binding exists for teamRunId '${teamRunId}'.`);
    this.name = "TeamRunNotBoundError";
    this.teamRunId = teamRunId;
  }
}

export class RunScopedTeamBindingRegistry {
  private readonly bindingByTeamRunId = new Map<string, RunScopedTeamBinding>();

  bindRun(input: BindRunInput): RunScopedTeamBinding {
    const teamRunId = normalizeRequiredString(input.teamRunId, "teamRunId");
    const teamDefinitionId = normalizeRequiredString(input.teamDefinitionId, "teamDefinitionId");
    const runtimeTeamId = normalizeRequiredString(input.runtimeTeamId, "runtimeTeamId");

    const binding: RunScopedTeamBinding = {
      teamRunId,
      runVersion: input.runVersion,
      teamDefinitionId,
      runtimeTeamId,
      memberBindings: input.memberBindings.map((item) => cloneMemberConfigInput(item)),
      boundAtIso: new Date().toISOString(),
    };

    this.bindingByTeamRunId.set(teamRunId, binding);
    return cloneBinding(binding);
  }

  resolveRun(teamRunId: string): RunScopedTeamBinding {
    const normalizedTeamRunId = normalizeRequiredString(teamRunId, "teamRunId");
    const binding = this.bindingByTeamRunId.get(normalizedTeamRunId);
    if (!binding) {
      throw new TeamRunNotBoundError(normalizedTeamRunId);
    }
    return cloneBinding(binding);
  }

  tryResolveRun(teamRunId: string): RunScopedTeamBinding | null {
    const normalizedTeamRunId = normalizeRequiredString(teamRunId, "teamRunId");
    const binding = this.bindingByTeamRunId.get(normalizedTeamRunId);
    if (!binding) {
      return null;
    }
    return cloneBinding(binding);
  }

  unbindRun(teamRunId: string): boolean {
    const normalizedTeamRunId = normalizeRequiredString(teamRunId, "teamRunId");
    return this.bindingByTeamRunId.delete(normalizedTeamRunId);
  }

  clear(): void {
    this.bindingByTeamRunId.clear();
  }
}
