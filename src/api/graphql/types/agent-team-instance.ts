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
import { GraphQLJSON } from "graphql-scalars";
import { TaskNotificationMode } from "autobyteus-ts/agent-team/task-notification/task-notification-mode.js";
import { AgentTeamInstanceManager } from "../../../agent-team-execution/services/agent-team-instance-manager.js";
import { getDefaultTeamCommandIngressService } from "../../../distributed/bootstrap/default-distributed-runtime-composition.js";
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

  @Field(() => GraphQLJSON, { nullable: true })
  llmConfig?: Record<string, unknown> | null;
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
  private get agentTeamInstanceManager(): AgentTeamInstanceManager {
    return AgentTeamInstanceManager.getInstance();
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
      const teamId = await this.agentTeamInstanceManager.createTeamInstance(
        input.teamDefinitionId,
        input.memberConfigs.map((config) => ({
          memberName: config.memberName,
          agentDefinitionId: config.agentDefinitionId,
          llmModelIdentifier: config.llmModelIdentifier,
          autoExecuteTools: config.autoExecuteTools,
          workspaceId: config.workspaceId ?? null,
          llmConfig: config.llmConfig ?? null,
        })),
      );
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

      if (!teamId) {
        logger.info("sendMessageToTeam: teamId not provided. Attempting lazy creation.");
        if (!input.teamDefinitionId || !input.memberConfigs) {
          throw new Error("teamDefinitionId and memberConfigs are required for lazy team creation.");
        }

        teamId = await this.agentTeamInstanceManager.createTeamInstance(
          input.teamDefinitionId,
          input.memberConfigs.map((config) => ({
            memberName: config.memberName,
            agentDefinitionId: config.agentDefinitionId,
            llmModelIdentifier: config.llmModelIdentifier,
            autoExecuteTools: config.autoExecuteTools,
            workspaceId: config.workspaceId ?? null,
            llmConfig: config.llmConfig ?? null,
          })),
        );
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
