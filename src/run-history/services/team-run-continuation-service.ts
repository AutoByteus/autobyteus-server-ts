import type { AgentInputUserMessage } from "autobyteus-ts";
import { AgentTeamInstanceManager } from "../../agent-team-execution/services/agent-team-instance-manager.js";
import { UserInputConverter } from "../../api/graphql/converters/user-input-converter.js";
import type { AgentUserInput } from "../../api/graphql/types/agent-user-input.js";
import { getWorkspaceManager, type WorkspaceManager } from "../../workspaces/workspace-manager.js";
import { normalizeMemberRouteKey } from "../utils/team-member-agent-id.js";
import {
  TeamRunHistoryService,
  getTeamRunHistoryService,
} from "./team-run-history-service.js";

type TeamLike = {
  teamId: string;
  postMessage: (message: AgentInputUserMessage, targetMemberName?: string | null) => Promise<void>;
};

type TeamInstanceManagerLike = Pick<
  AgentTeamInstanceManager,
  "getTeamInstance" | "createTeamInstanceWithId" | "terminateTeamInstance"
>;

export interface ContinueTeamRunInput {
  teamId: string;
  userInput: AgentUserInput;
  targetMemberRouteKey?: string | null;
}

export interface ContinueTeamRunResult {
  teamId: string;
  restored: boolean;
}

const normalizeRequiredString = (value: string, fieldName: string): string => {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldName} is required.`);
  }
  return normalized;
};

const normalizeOptionalString = (value: string | null | undefined): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const normalizeRouteKey = (value: string): string => {
  try {
    return normalizeMemberRouteKey(value);
  } catch {
    return value.trim();
  }
};

export class TeamRunContinuationService {
  private readonly teamInstanceManager: TeamInstanceManagerLike;
  private readonly teamRunHistoryService: TeamRunHistoryService;
  private readonly workspaceManager: WorkspaceManager;

  constructor(options: {
    teamInstanceManager?: TeamInstanceManagerLike;
    teamRunHistoryService?: TeamRunHistoryService;
    workspaceManager?: WorkspaceManager;
  } = {}) {
    this.teamInstanceManager = options.teamInstanceManager ?? AgentTeamInstanceManager.getInstance();
    this.teamRunHistoryService = options.teamRunHistoryService ?? getTeamRunHistoryService();
    this.workspaceManager = options.workspaceManager ?? getWorkspaceManager();
  }

  async continueTeamRun(input: ContinueTeamRunInput): Promise<ContinueTeamRunResult> {
    const teamId = normalizeRequiredString(input.teamId, "teamId");
    const content = normalizeRequiredString(input.userInput?.content ?? "", "userInput.content");
    const userMessage = UserInputConverter.toAgentInputUserMessage({
      ...input.userInput,
      content,
    });

    let restored = false;
    try {
      let team = this.teamInstanceManager.getTeamInstance(teamId) as TeamLike | null;
      if (!team) {
        await this.restoreTeamRuntime(teamId);
        restored = true;
        team = this.teamInstanceManager.getTeamInstance(teamId) as TeamLike | null;
      }
      if (!team) {
        throw new Error(`Team '${teamId}' restore failed.`);
      }

      const targetMemberName = await this.resolveTargetMemberName(
        teamId,
        input.targetMemberRouteKey ?? null,
      );
      await team.postMessage(userMessage, targetMemberName);
      await this.safeRecordActivity(teamId, content);
      return {
        teamId,
        restored,
      };
    } catch (error) {
      if (restored) {
        await this.safeTerminate(teamId);
      }
      throw error;
    }
  }

  private async restoreTeamRuntime(teamId: string): Promise<void> {
    const resumeConfig = await this.teamRunHistoryService.getTeamRunResumeConfig(teamId);
    const manifest = resumeConfig.manifest;

    const memberConfigs = await Promise.all(
      manifest.memberBindings.map(async (binding) => {
        let workspaceId: string | null = null;
        if (binding.workspaceRootPath) {
          const workspace = await this.workspaceManager.ensureWorkspaceByRootPath(
            binding.workspaceRootPath,
          );
          workspaceId = workspace.workspaceId;
        }
        return {
          memberName: binding.memberName,
          agentDefinitionId: binding.agentDefinitionId,
          llmModelIdentifier: binding.llmModelIdentifier,
          autoExecuteTools: binding.autoExecuteTools,
          workspaceId,
          llmConfig: binding.llmConfig ?? null,
          memberRouteKey: binding.memberRouteKey,
          memberAgentId: binding.memberAgentId,
        };
      }),
    );

    await this.teamInstanceManager.createTeamInstanceWithId(
      teamId,
      manifest.teamDefinitionId,
      memberConfigs,
    );
  }

  private async resolveTargetMemberName(
    teamId: string,
    targetMemberRouteKey: string | null,
  ): Promise<string | null> {
    const normalizedTarget = normalizeOptionalString(targetMemberRouteKey);
    if (!normalizedTarget) {
      return null;
    }

    try {
      const resumeConfig = await this.teamRunHistoryService.getTeamRunResumeConfig(teamId);
      const normalizedRoute = normalizeRouteKey(normalizedTarget);
      const member = resumeConfig.manifest.memberBindings.find(
        (binding) =>
          normalizeRouteKey(binding.memberRouteKey) === normalizedRoute ||
          binding.memberName.trim() === normalizedTarget,
      );
      return member?.memberName ?? normalizedTarget;
    } catch {
      return normalizedTarget;
    }
  }

  private async safeRecordActivity(teamId: string, summary: string): Promise<void> {
    try {
      await this.teamRunHistoryService.onTeamEvent(teamId, {
        status: "ACTIVE",
        summary,
      });
    } catch (error) {
      console.warn(`Failed to update team run history for '${teamId}': ${String(error)}`);
    }
  }

  private async safeTerminate(teamId: string): Promise<void> {
    try {
      await this.teamInstanceManager.terminateTeamInstance(teamId);
    } catch (error) {
      console.warn(`Rollback failed while terminating restored team '${teamId}': ${String(error)}`);
    }
  }
}

let cachedTeamRunContinuationService: TeamRunContinuationService | null = null;

export const getTeamRunContinuationService = (): TeamRunContinuationService => {
  if (!cachedTeamRunContinuationService) {
    cachedTeamRunContinuationService = new TeamRunContinuationService();
  }
  return cachedTeamRunContinuationService;
};
