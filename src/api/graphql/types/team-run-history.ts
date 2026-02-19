import { Arg, Field, Mutation, ObjectType, Query, Resolver } from "type-graphql";
import { GraphQLJSON } from "graphql-scalars";
import { getTeamRunHistoryService } from "../../../run-history/services/team-run-history-service.js";
import { getTeamMemberRunProjectionService } from "../../../run-history/services/team-member-run-projection-service.js";

@ObjectType()
class TeamRunMemberHistoryObject {
  @Field(() => String)
  memberRouteKey!: string;

  @Field(() => String)
  memberName!: string;

  @Field(() => String)
  memberAgentId!: string;

  @Field(() => String, { nullable: true })
  workspaceRootPath?: string | null;

  @Field(() => String, { nullable: true })
  hostNodeId?: string | null;
}

@ObjectType()
class TeamRunHistoryItemObject {
  @Field(() => String)
  teamId!: string;

  @Field(() => String)
  teamDefinitionId!: string;

  @Field(() => String)
  teamDefinitionName!: string;

  @Field(() => String)
  summary!: string;

  @Field(() => String)
  lastActivityAt!: string;

  @Field(() => String)
  lastKnownStatus!: string;

  @Field(() => String)
  deleteLifecycle!: string;

  @Field(() => Boolean)
  isActive!: boolean;

  @Field(() => [TeamRunMemberHistoryObject])
  members!: TeamRunMemberHistoryObject[];
}

@ObjectType()
class TeamRunResumeConfigPayload {
  @Field(() => String)
  teamId!: string;

  @Field(() => Boolean)
  isActive!: boolean;

  @Field(() => GraphQLJSON)
  manifest!: unknown;
}

@ObjectType()
class TeamMemberRunProjectionPayload {
  @Field(() => String)
  agentId!: string;

  @Field(() => [GraphQLJSON])
  conversation!: Array<Record<string, unknown>>;

  @Field(() => String, { nullable: true })
  summary?: string | null;

  @Field(() => String, { nullable: true })
  lastActivityAt?: string | null;
}

@ObjectType()
class DeleteTeamRunHistoryMutationResult {
  @Field(() => Boolean)
  success!: boolean;

  @Field(() => String)
  message!: string;
}

@Resolver()
export class TeamRunHistoryResolver {
  private teamRunHistoryService = getTeamRunHistoryService();
  private teamMemberRunProjectionService = getTeamMemberRunProjectionService();

  @Query(() => [TeamRunHistoryItemObject])
  async listTeamRunHistory(): Promise<TeamRunHistoryItemObject[]> {
    return this.teamRunHistoryService.listTeamRunHistory();
  }

  @Query(() => TeamRunResumeConfigPayload)
  async getTeamRunResumeConfig(
    @Arg("teamId", () => String) teamId: string,
  ): Promise<TeamRunResumeConfigPayload> {
    return this.teamRunHistoryService.getTeamRunResumeConfig(teamId);
  }

  @Query(() => TeamMemberRunProjectionPayload)
  async getTeamMemberRunProjection(
    @Arg("teamId", () => String) teamId: string,
    @Arg("memberRouteKey", () => String) memberRouteKey: string,
  ): Promise<TeamMemberRunProjectionPayload> {
    return this.teamMemberRunProjectionService.getProjection(teamId, memberRouteKey);
  }

  @Mutation(() => DeleteTeamRunHistoryMutationResult)
  async deleteTeamRunHistory(
    @Arg("teamId", () => String) teamId: string,
  ): Promise<DeleteTeamRunHistoryMutationResult> {
    try {
      return await this.teamRunHistoryService.deleteTeamRunHistory(teamId);
    } catch (error) {
      return {
        success: false,
        message: String(error),
      };
    }
  }
}
