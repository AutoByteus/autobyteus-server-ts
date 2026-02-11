import {
  Arg,
  Field,
  InputType,
  Mutation,
  ObjectType,
  Query,
  registerEnumType,
  Resolver,
} from "type-graphql";
import { GraphQLJSON } from "graphql-scalars";
import { SkillAccessMode } from "autobyteus-ts/agent/context/skill-access-mode.js";
import { AgentInstanceManager } from "../../../agent-execution/services/agent-instance-manager.js";
import { UserInputConverter } from "../converters/user-input-converter.js";
import { AgentInstanceConverter } from "../converters/agent-instance-converter.js";
import { AgentUserInput } from "./agent-user-input.js";
import { WorkspaceInfo } from "./workspace.js";

const logger = {
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};

registerEnumType(SkillAccessMode, {
  name: "SkillAccessModeEnum",
});

@ObjectType()
export class AgentInstance {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  name!: string;

  @Field(() => String)
  role!: string;

  @Field(() => String)
  currentStatus!: string;

  @Field(() => WorkspaceInfo, { nullable: true })
  workspace?: WorkspaceInfo | null;

  @Field(() => String, { nullable: true })
  agentDefinitionId?: string | null;
}

@ObjectType()
export class TerminateAgentInstanceResult {
  @Field(() => Boolean)
  success!: boolean;

  @Field(() => String)
  message!: string;
}

@InputType()
export class SendAgentUserInputInput {
  @Field(() => AgentUserInput)
  userInput!: AgentUserInput;

  @Field(() => String, { nullable: true })
  agentId?: string | null;

  @Field(() => String, { nullable: true })
  agentDefinitionId?: string | null;

  @Field(() => String, { nullable: true })
  llmModelIdentifier?: string | null;

  @Field(() => Boolean, { nullable: true })
  autoExecuteTools?: boolean | null;

  @Field(() => String, { nullable: true })
  workspaceId?: string | null;

  @Field(() => Boolean, { nullable: true })
  useXmlToolFormat?: boolean | null;

  @Field(() => GraphQLJSON, { nullable: true })
  llmConfig?: Record<string, unknown> | null;

  @Field(() => SkillAccessMode, { nullable: true })
  skillAccessMode?: SkillAccessMode | null;
}

@ObjectType()
export class SendAgentUserInputResult {
  @Field(() => Boolean)
  success!: boolean;

  @Field(() => String)
  message!: string;

  @Field(() => String, { nullable: true })
  agentId?: string | null;
}

@InputType()
export class ApproveToolInvocationInput {
  @Field(() => String)
  agentId!: string;

  @Field(() => String)
  invocationId!: string;

  @Field(() => Boolean)
  isApproved!: boolean;

  @Field(() => String, { nullable: true })
  reason?: string | null;
}

@ObjectType()
export class ApproveToolInvocationResult {
  @Field(() => Boolean)
  success!: boolean;

  @Field(() => String)
  message!: string;
}

@Resolver()
export class AgentInstanceResolver {
  private get agentInstanceManager(): AgentInstanceManager {
    return AgentInstanceManager.getInstance();
  }

  @Query(() => AgentInstance, { nullable: true })
  async agentInstance(@Arg("id", () => String) id: string): Promise<AgentInstance | null> {
    try {
      const domainAgent = this.agentInstanceManager.getAgentInstance(id);
      if (!domainAgent) {
        return null;
      }
      return await AgentInstanceConverter.toGraphql(domainAgent as any);
    } catch (error) {
      logger.error(`Error fetching agent instance by ID ${id}: ${String(error)}`);
      throw new Error("Unable to fetch agent instance at this time.");
    }
  }

  @Query(() => [AgentInstance])
  async agentInstances(): Promise<AgentInstance[]> {
    try {
      const instanceIds = this.agentInstanceManager.listActiveInstances();
      const results = await Promise.all(
        instanceIds.map(async (instanceId) => {
          const domainAgent = this.agentInstanceManager.getAgentInstance(instanceId);
          if (!domainAgent) {
            return null;
          }
          return AgentInstanceConverter.toGraphql(domainAgent as any);
        }),
      );
      return results.filter((item): item is AgentInstance => item !== null);
    } catch (error) {
      logger.error(`Error fetching all agent instances: ${String(error)}`);
      throw new Error("Unable to fetch agent instances at this time.");
    }
  }

  @Mutation(() => TerminateAgentInstanceResult)
  async terminateAgentInstance(
    @Arg("id", () => String) id: string,
  ): Promise<TerminateAgentInstanceResult> {
    try {
      const success = await this.agentInstanceManager.terminateAgentInstance(id);
      return {
        success,
        message: success
          ? "Agent instance terminated successfully."
          : "Agent instance not found.",
      };
    } catch (error) {
      logger.error(`Error terminating agent instance with ID ${id}: ${String(error)}`);
      return {
        success: false,
        message: `Failed to terminate agent instance: ${String(error)}`,
      };
    }
  }

  @Mutation(() => SendAgentUserInputResult)
  async sendAgentUserInput(
    @Arg("input", () => SendAgentUserInputInput) input: SendAgentUserInputInput,
  ): Promise<SendAgentUserInputResult> {
    try {
      let agentId = input.agentId ?? null;
      let agent = agentId ? this.agentInstanceManager.getAgentInstance(agentId) : null;

      if (agentId && !agent) {
        logger.warn(`sendAgentUserInput: Agent with ID '${agentId}' not found.`);
        return {
          success: false,
          message: `Agent with ID '${agentId}' not found.`,
          agentId: null,
        };
      }

      if (!agent) {
        if (!input.agentDefinitionId || !input.llmModelIdentifier) {
          logger.warn(
            "sendAgentUserInput: agentDefinitionId and llmModelIdentifier are required to create a new agent.",
          );
          return {
            success: false,
            message:
              "agentDefinitionId and llmModelIdentifier are required when creating a new agent.",
            agentId: null,
          };
        }

        logger.info(
          `Creating a new agent instance from definition '${input.agentDefinitionId}'...`,
        );
        agentId = await this.agentInstanceManager.createAgentInstance({
          agentDefinitionId: input.agentDefinitionId,
          llmModelIdentifier: input.llmModelIdentifier,
          autoExecuteTools: input.autoExecuteTools ?? false,
          workspaceId: input.workspaceId ?? null,
          llmConfig: input.llmConfig ?? null,
          skillAccessMode: input.skillAccessMode ?? null,
        });

        agent = this.agentInstanceManager.getAgentInstance(agentId);
        if (!agent) {
          logger.error(
            `Failed to retrieve newly created agent instance with ID '${agentId}'.`,
          );
          throw new Error("Failed to retrieve newly created agent instance.");
        }
      }

      const userMessage = UserInputConverter.toAgentInputUserMessage(input.userInput);
      await (agent as any).postUserMessage(userMessage);

      logger.info(`Successfully posted user message to agent '${agentId}'.`);
      return {
        success: true,
        message: "User input successfully sent to agent.",
        agentId,
      };
    } catch (error) {
      logger.error(`Error in sendAgentUserInput: ${String(error)}`);
      return {
        success: false,
        message: `An unexpected error occurred: ${String(error)}`,
        agentId: input.agentId ?? null,
      };
    }
  }

  @Mutation(() => ApproveToolInvocationResult)
  async approveToolInvocation(
    @Arg("input", () => ApproveToolInvocationInput) input: ApproveToolInvocationInput,
  ): Promise<ApproveToolInvocationResult> {
    try {
      logger.info(
        `Received tool invocation approval request for agent '${input.agentId}', invocation '${input.invocationId}', approved: ${input.isApproved}`,
      );

      const agent = this.agentInstanceManager.getAgentInstance(input.agentId);
      if (!agent) {
        logger.warn(`approveToolInvocation: Agent with ID '${input.agentId}' not found.`);
        return {
          success: false,
          message: `Agent with ID '${input.agentId}' not found.`,
        };
      }

      await (agent as any).postToolExecutionApproval(
        input.invocationId,
        input.isApproved,
        input.reason ?? null,
      );

      logger.info(
        `Successfully posted tool execution approval for agent '${input.agentId}', invocation '${input.invocationId}'.`,
      );
      return {
        success: true,
        message: "Tool invocation approval/denial successfully sent to agent.",
      };
    } catch (error) {
      logger.error(
        `Error in approveToolInvocation for agent '${input.agentId}': ${String(error)}`,
      );
      return {
        success: false,
        message: `An unexpected error occurred: ${String(error)}`,
      };
    }
  }
}
