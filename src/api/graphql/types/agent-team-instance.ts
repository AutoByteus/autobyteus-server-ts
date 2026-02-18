import {
  Arg,
  Field,
  InputType,
  Mutation,
  ObjectType,
  Query,
  Resolver,
  registerEnumType,
} from "type-graphql";
import { randomUUID } from "node:crypto";
import { GraphQLJSON } from "graphql-scalars";
import { TaskNotificationMode } from "autobyteus-ts/agent-team/task-notification/task-notification-mode.js";
import { AgentTeamInstanceManager } from "../../../agent-team-execution/services/agent-team-instance-manager.js";
import { AgentTeamDefinitionService } from "../../../agent-team-definition/services/agent-team-definition-service.js";
import { getDefaultTeamCommandIngressService } from "../../../distributed/bootstrap/default-distributed-runtime-composition.js";
import { TeamRunManifest } from "../../../run-history/domain/team-models.js";
import { getTeamRunContinuationService } from "../../../run-history/services/team-run-continuation-service.js";
import { getTeamRunHistoryService } from "../../../run-history/services/team-run-history-service.js";
import { getWorkspaceManager } from "../../../workspaces/workspace-manager.js";
import {
  buildTeamMemberAgentId,
  normalizeMemberRouteKey,
} from "../../../run-history/utils/team-member-agent-id.js";
import { UserInputConverter } from "../converters/user-input-converter.js";
import { AgentTeamInstanceConverter } from "../converters/agent-team-instance-converter.js";
import { AgentUserInput } from "./agent-user-input.js";

registerEnumType(TaskNotificationMode, {
  name: "TaskNotificationModeEnum",
});

const logger = {
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};

@ObjectType()
export class AgentTeamInstance {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  name!: string;

  @Field(() => String)
  currentStatus!: string;

  @Field(() => String, { nullable: true })
  role?: string | null;
}

@ObjectType()
export class CreateAgentTeamInstanceResult {
  @Field(() => Boolean)
  success!: boolean;

  @Field(() => String)
  message!: string;

  @Field(() => String, { nullable: true })
  teamId?: string | null;
}

@ObjectType()
export class TerminateAgentTeamInstanceResult {
  @Field(() => Boolean)
  success!: boolean;

  @Field(() => String)
  message!: string;
}

@InputType()
export class TeamMemberConfigInput {
  @Field(() => String)
  memberName!: string;

  @Field(() => String)
  agentDefinitionId!: string;

  @Field(() => String)
  llmModelIdentifier!: string;

  @Field(() => Boolean)
  autoExecuteTools!: boolean;

  @Field(() => String, { nullable: true })
  workspaceId?: string | null;

  @Field(() => String, { nullable: true })
  workspaceRootPath?: string | null;

  @Field(() => GraphQLJSON, { nullable: true })
  llmConfig?: Record<string, unknown> | null;

  @Field(() => String, { nullable: true })
  memberRouteKey?: string | null;

  @Field(() => String, { nullable: true })
  memberAgentId?: string | null;

  @Field(() => String, { nullable: true })
  memoryDir?: string | null;
}

@InputType()
export class CreateAgentTeamInstanceInput {
  @Field(() => String)
  teamDefinitionId!: string;

  @Field(() => [TeamMemberConfigInput])
  memberConfigs!: TeamMemberConfigInput[];

  @Field(() => TaskNotificationMode, { nullable: true })
  taskNotificationMode?: TaskNotificationMode | null;

  @Field(() => Boolean, { nullable: true })
  useXmlToolFormat?: boolean | null;
}

@InputType()
export class SendMessageToTeamInput {
  @Field(() => AgentUserInput)
  userInput!: AgentUserInput;

  @Field(() => String, { nullable: true })
  teamId?: string | null;

  @Field(() => String, { nullable: true })
  targetMemberName?: string | null;

  @Field(() => String, { nullable: true })
  teamDefinitionId?: string | null;

  @Field(() => [TeamMemberConfigInput], { nullable: true })
  memberConfigs?: TeamMemberConfigInput[] | null;

  @Field(() => TaskNotificationMode, { nullable: true })
  taskNotificationMode?: TaskNotificationMode | null;

  @Field(() => Boolean, { nullable: true })
  useXmlToolFormat?: boolean | null;
}

@ObjectType()
export class SendMessageToTeamResult {
  @Field(() => Boolean)
  success!: boolean;

  @Field(() => String)
  message!: string;

  @Field(() => String, { nullable: true })
  teamId?: string | null;
}

@Resolver()
export class AgentTeamInstanceResolver {
  private readonly teamRunHistoryService = getTeamRunHistoryService();
  private readonly teamRunContinuationService = getTeamRunContinuationService();
  private readonly teamDefinitionService = AgentTeamDefinitionService.getInstance();
  private readonly workspaceManager = getWorkspaceManager();

  private get agentTeamInstanceManager(): AgentTeamInstanceManager {
    return AgentTeamInstanceManager.getInstance();
  }

  private generateTeamId(): string {
    return `team_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  }

  private resolveRuntimeMemberConfigs(
    teamId: string,
    memberConfigs: TeamMemberConfigInput[],
  ): TeamMemberConfigInput[] {
    return memberConfigs.map((config) => {
      const memberName = config.memberName.trim();
      const memberRouteKey = normalizeMemberRouteKey(config.memberRouteKey ?? memberName);
      const memberAgentId =
        typeof config.memberAgentId === "string" && config.memberAgentId.trim().length > 0
          ? config.memberAgentId.trim()
          : buildTeamMemberAgentId(teamId, memberRouteKey);
      return {
        memberName,
        agentDefinitionId: config.agentDefinitionId.trim(),
        llmModelIdentifier: config.llmModelIdentifier.trim(),
        autoExecuteTools: Boolean(config.autoExecuteTools),
        workspaceId: config.workspaceId ?? null,
        workspaceRootPath:
          typeof config.workspaceRootPath === "string" && config.workspaceRootPath.trim().length > 0
            ? config.workspaceRootPath.trim()
            : null,
        llmConfig: config.llmConfig ?? null,
        memberRouteKey,
        memberAgentId,
      };
    });
  }

  private resolveWorkspaceRootPath(config: TeamMemberConfigInput): string | null {
    if (typeof config.workspaceRootPath === "string" && config.workspaceRootPath.trim().length > 0) {
      return config.workspaceRootPath.trim();
    }
    if (typeof config.workspaceId !== "string" || config.workspaceId.trim().length === 0) {
      return null;
    }
    const workspace = this.workspaceManager.getWorkspaceById(config.workspaceId.trim());
    if (!workspace) {
      return null;
    }
    const rootPath =
      typeof (workspace as { rootPath?: unknown }).rootPath === "string"
        ? ((workspace as { rootPath: string }).rootPath ?? null)
        : typeof workspace.getBasePath === "function"
          ? workspace.getBasePath()
          : null;
    if (typeof rootPath !== "string") {
      return null;
    }
    const normalized = rootPath.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private buildTeamRunManifest(options: {
    teamId: string;
    teamDefinitionId: string;
    teamDefinitionName: string;
    coordinatorMemberName?: string | null;
    memberConfigs: TeamMemberConfigInput[];
  }): TeamRunManifest {
    const now = new Date().toISOString();
    const memberBindings = options.memberConfigs.map((config) => {
      const memberName = config.memberName.trim();
      const routeKey = normalizeMemberRouteKey(config.memberRouteKey ?? memberName);
      const memberAgentId =
        typeof config.memberAgentId === "string" && config.memberAgentId.trim().length > 0
          ? config.memberAgentId.trim()
          : buildTeamMemberAgentId(options.teamId, routeKey);
      return {
        memberRouteKey: routeKey,
        memberName,
        memberAgentId,
        agentDefinitionId: config.agentDefinitionId.trim(),
        llmModelIdentifier: config.llmModelIdentifier.trim(),
        autoExecuteTools: Boolean(config.autoExecuteTools),
        llmConfig: config.llmConfig ?? null,
        workspaceRootPath: this.resolveWorkspaceRootPath(config),
        hostNodeId: null,
      };
    });
    const normalizedCoordinatorName =
      typeof options.coordinatorMemberName === "string" &&
      options.coordinatorMemberName.trim().length > 0
        ? options.coordinatorMemberName.trim()
        : null;
    const coordinatorMemberRouteKey =
      (normalizedCoordinatorName
        ? memberBindings.find((binding) => binding.memberName === normalizedCoordinatorName)
            ?.memberRouteKey ??
          memberBindings.find(
            (binding) => binding.memberRouteKey === normalizeMemberRouteKey(normalizedCoordinatorName),
          )?.memberRouteKey
        : null) ??
      memberBindings[0]?.memberRouteKey ??
      "coordinator";
    return {
      teamId: options.teamId,
      teamDefinitionId: options.teamDefinitionId.trim(),
      teamDefinitionName: options.teamDefinitionName.trim() || options.teamDefinitionId.trim(),
      coordinatorMemberRouteKey,
      runVersion: 1,
      createdAt: now,
      updatedAt: now,
      memberBindings,
    };
  }

  private async resolveTeamDefinitionMetadata(teamDefinitionId: string): Promise<{
    teamDefinitionName: string;
    coordinatorMemberName: string | null;
  }> {
    const normalizedId = teamDefinitionId.trim();
    if (!normalizedId) {
      return {
        teamDefinitionName: "",
        coordinatorMemberName: null,
      };
    }

    try {
      const definition = await this.teamDefinitionService.getDefinitionById(normalizedId);
      return {
        teamDefinitionName:
          (typeof definition?.name === "string" && definition.name.trim().length > 0
            ? definition.name.trim()
            : normalizedId),
        coordinatorMemberName:
          typeof definition?.coordinatorMemberName === "string" &&
          definition.coordinatorMemberName.trim().length > 0
            ? definition.coordinatorMemberName.trim()
            : null,
      };
    } catch (error) {
      logger.warn(
        `Failed to resolve team definition metadata for '${normalizedId}', using fallback metadata: ${String(error)}`,
      );
      return {
        teamDefinitionName: normalizedId,
        coordinatorMemberName: null,
      };
    }
  }

  @Query(() => AgentTeamInstance, { nullable: true })
  agentTeamInstance(@Arg("id", () => String) id: string): AgentTeamInstance | null {
    try {
      const domainTeam = this.agentTeamInstanceManager.getTeamInstance(id);
      if (!domainTeam) {
        return null;
      }
      return AgentTeamInstanceConverter.toGraphql(domainTeam as any);
    } catch (error) {
      logger.error(`Error fetching agent team instance by ID ${id}: ${String(error)}`);
      throw new Error("Unable to fetch agent team instance at this time.");
    }
  }

  @Query(() => [AgentTeamInstance])
  agentTeamInstances(): AgentTeamInstance[] {
    try {
      const instanceIds = this.agentTeamInstanceManager.listActiveInstances();
      const results: AgentTeamInstance[] = [];
      for (const instanceId of instanceIds) {
        const domainTeam = this.agentTeamInstanceManager.getTeamInstance(instanceId);
        if (domainTeam) {
          results.push(AgentTeamInstanceConverter.toGraphql(domainTeam as any));
        }
      }
      return results;
    } catch (error) {
      logger.error(`Error fetching all agent team instances: ${String(error)}`);
      throw new Error("Unable to fetch agent team instances at this time.");
    }
  }

  @Mutation(() => CreateAgentTeamInstanceResult)
  async createAgentTeamInstance(
    @Arg("input", () => CreateAgentTeamInstanceInput)
    input: CreateAgentTeamInstanceInput,
  ): Promise<CreateAgentTeamInstanceResult> {
    try {
      const teamId = this.generateTeamId();
      const resolvedMemberConfigs = this.resolveRuntimeMemberConfigs(teamId, input.memberConfigs);
      await this.agentTeamInstanceManager.createTeamInstanceWithId(
        teamId,
        input.teamDefinitionId,
        resolvedMemberConfigs,
      );
      try {
        const metadata = await this.resolveTeamDefinitionMetadata(input.teamDefinitionId);
        const manifest = this.buildTeamRunManifest({
          teamId,
          teamDefinitionId: input.teamDefinitionId,
          teamDefinitionName: metadata.teamDefinitionName,
          coordinatorMemberName: metadata.coordinatorMemberName,
          memberConfigs: resolvedMemberConfigs,
        });
        await this.teamRunHistoryService.upsertTeamRunHistoryRow({
          teamId,
          manifest,
          summary: "",
          lastKnownStatus: "IDLE",
        });
      } catch (historyError) {
        logger.warn(
          `Failed to upsert team run history for '${teamId}' during createAgentTeamInstance: ${String(historyError)}`,
        );
      }
      return {
        success: true,
        message: "Agent team instance created successfully.",
        teamId,
      };
    } catch (error) {
      logger.error(`Error creating agent team instance: ${String(error)}`);
      return { success: false, message: String(error) };
    }
  }

  @Mutation(() => TerminateAgentTeamInstanceResult)
  async terminateAgentTeamInstance(
    @Arg("id", () => String) id: string,
  ): Promise<TerminateAgentTeamInstanceResult> {
    try {
      const success = await this.agentTeamInstanceManager.terminateTeamInstance(id);
      if (success) {
        try {
          await this.teamRunHistoryService.onTeamTerminated(id);
        } catch (historyError) {
          logger.warn(`Failed to mark team run '${id}' terminated in history: ${String(historyError)}`);
        }
      }
      return {
        success,
        message: success
          ? "Agent team instance terminated successfully."
          : "Agent team instance not found.",
      };
    } catch (error) {
      logger.error(`Error terminating agent team instance with ID ${id}: ${String(error)}`);
      return { success: false, message: String(error) };
    }
  }

  @Mutation(() => SendMessageToTeamResult)
  async sendMessageToTeam(
    @Arg("input", () => SendMessageToTeamInput) input: SendMessageToTeamInput,
  ): Promise<SendMessageToTeamResult> {
    try {
      let teamId = input.teamId ?? null;

      if (teamId && !input.teamDefinitionId && !input.memberConfigs) {
        await this.teamRunContinuationService.continueTeamRun({
          teamId,
          targetMemberRouteKey: input.targetMemberName ?? null,
          userInput: input.userInput,
        });
        return {
          success: true,
          message: "Message sent to team successfully.",
          teamId,
        };
      }

      if (!teamId) {
        logger.info("sendMessageToTeam: teamId not provided. Attempting lazy creation.");
        if (!input.teamDefinitionId || !input.memberConfigs) {
          throw new Error("teamDefinitionId and memberConfigs are required for lazy team creation.");
        }

        teamId = this.generateTeamId();
        const resolvedMemberConfigs = this.resolveRuntimeMemberConfigs(teamId, input.memberConfigs);
        await this.agentTeamInstanceManager.createTeamInstanceWithId(
          teamId,
          input.teamDefinitionId,
          resolvedMemberConfigs,
        );
        try {
          const metadata = await this.resolveTeamDefinitionMetadata(input.teamDefinitionId);
          const manifest = this.buildTeamRunManifest({
            teamId,
            teamDefinitionId: input.teamDefinitionId,
            teamDefinitionName: metadata.teamDefinitionName,
            coordinatorMemberName: metadata.coordinatorMemberName,
            memberConfigs: resolvedMemberConfigs,
          });
          await this.teamRunHistoryService.upsertTeamRunHistoryRow({
            teamId,
            manifest,
            summary: "",
            lastKnownStatus: "IDLE",
          });
        } catch (historyError) {
          logger.warn(
            `Failed to upsert team run history for '${teamId}' during lazy create: ${String(historyError)}`,
          );
        }
        logger.info(`Lazy creation successful. New team ID: ${teamId}`);
      }

      if (!teamId) {
        throw new Error("Team ID could not be resolved for sendMessageToTeam.");
      }
      const userMessage = UserInputConverter.toAgentInputUserMessage(input.userInput);
      await getDefaultTeamCommandIngressService().dispatchUserMessage({
        teamId,
        userMessage,
        targetMemberName: input.targetMemberName ?? null,
      });
      try {
        await this.teamRunHistoryService.onTeamEvent(teamId, {
          status: "ACTIVE",
          summary: input.userInput?.content ?? "",
        });
      } catch (historyError) {
        logger.warn(`Failed to record team run activity for '${teamId}': ${String(historyError)}`);
      }

      return {
        success: true,
        message: "Message sent to team successfully.",
        teamId,
      };
    } catch (error) {
      logger.error(`Error sending message to team: ${String(error)}`);
      return {
        success: false,
        message: String(error),
        teamId: input.teamId ?? null,
      };
    }
  }
}
