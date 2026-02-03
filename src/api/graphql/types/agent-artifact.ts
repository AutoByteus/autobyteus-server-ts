import { Arg, Field, ObjectType, Query, Resolver } from "type-graphql";
import { ArtifactService } from "../../../agent-artifacts/services/artifact-service.js";
import type { AgentArtifact as DomainAgentArtifact } from "../../../agent-artifacts/domain/models.js";

@ObjectType()
export class AgentArtifact {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  agentId!: string;

  @Field(() => String)
  path!: string;

  @Field(() => String)
  type!: string;

  @Field(() => String, { nullable: true })
  workspaceRoot?: string | null;

  @Field(() => String)
  createdAt!: string;

  @Field(() => String)
  updatedAt!: string;
}

const toGraphql = (artifact: DomainAgentArtifact): AgentArtifact => ({
  id: artifact.id ?? "",
  agentId: artifact.agentId,
  path: artifact.path,
  type: artifact.type,
  workspaceRoot: artifact.workspaceRoot ?? null,
  createdAt: artifact.createdAt.toISOString(),
  updatedAt: artifact.updatedAt.toISOString(),
});

@Resolver()
export class AgentArtifactResolver {
  @Query(() => [AgentArtifact])
  async agentArtifacts(
    @Arg("agentId", () => String) agentId: string,
  ): Promise<AgentArtifact[]> {
    const service = ArtifactService.getInstance();
    const artifacts = await service.getArtifactsByAgentId(agentId);
    return artifacts.map(toGraphql);
  }
}
