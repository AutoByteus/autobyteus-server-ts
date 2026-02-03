import { Arg, Field, ObjectType, Query, Resolver, registerEnumType } from "type-graphql";
import { GraphQLJSON } from "graphql-scalars";
import { NodeType } from "../../../workflow-definition/domain/enums.js";
import { WorkflowDefinitionService } from "../../../workflow-definition/services/workflow-definition-service.js";
import { WorkflowDefinitionConverter } from "../converters/workflow-definition-converter.js";

registerEnumType(NodeType, { name: "NodeType" });

const logger = {
  error: (...args: unknown[]) => console.error(...args),
};

@ObjectType()
export class WorkflowNode {
  @Field(() => String)
  node_id!: string;

  @Field(() => NodeType)
  node_type!: NodeType;

  @Field(() => String)
  reference_id!: string;

  @Field(() => [String])
  dependencies!: string[];

  @Field(() => GraphQLJSON)
  properties!: Record<string, unknown>;
}

@ObjectType()
export class WorkflowDefinition {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  name!: string;

  @Field(() => String)
  description!: string;

  @Field(() => [WorkflowNode])
  nodes!: WorkflowNode[];

  @Field(() => String)
  begin_node_id!: string;

  @Field(() => String)
  end_node_id!: string;
}

@Resolver()
export class WorkflowDefinitionResolver {
  @Query(() => WorkflowDefinition, { nullable: true })
  async workflowDefinition(
    @Arg("id", () => String) id: string,
  ): Promise<WorkflowDefinition | null> {
    try {
      const service = WorkflowDefinitionService.getInstance();
      const domainDefinition = await service.getDefinitionById(id);
      if (!domainDefinition) {
        return null;
      }
      return WorkflowDefinitionConverter.toGraphql(domainDefinition);
    } catch (error) {
      logger.error(`Error fetching workflow definition by ID ${id}: ${String(error)}`);
      throw new Error("Unable to fetch workflow definition at this time.");
    }
  }

  @Query(() => [WorkflowDefinition])
  async workflowDefinitions(): Promise<WorkflowDefinition[]> {
    try {
      const service = WorkflowDefinitionService.getInstance();
      const definitions = await service.getAllDefinitions();
      return definitions.map((definition) => WorkflowDefinitionConverter.toGraphql(definition));
    } catch (error) {
      logger.error(`Error fetching all workflow definitions: ${String(error)}`);
      throw new Error("Unable to fetch workflow definitions at this time.");
    }
  }
}
