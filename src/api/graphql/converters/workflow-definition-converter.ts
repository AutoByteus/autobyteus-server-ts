import type { AgentWorkflowDefinition as DomainWorkflowDefinition } from "../../../workflow-definition/domain/models.js";
import { WorkflowDefinition, WorkflowNode } from "../types/workflow-definition.js";

const logger = {
  error: (...args: unknown[]) => console.error(...args),
};

export class WorkflowDefinitionConverter {
  static toGraphql(domainDefinition: DomainWorkflowDefinition): WorkflowDefinition {
    try {
      const graphqlNodes: WorkflowNode[] = domainDefinition.nodes.map((node) => ({
        node_id: node.nodeId,
        node_type: node.nodeType,
        reference_id: node.referenceId,
        dependencies: node.dependencies,
        properties: node.properties,
      }));

      return {
        id: String(domainDefinition.id ?? ""),
        name: domainDefinition.name,
        description: domainDefinition.description,
        nodes: graphqlNodes,
        begin_node_id: domainDefinition.beginNodeId,
        end_node_id: domainDefinition.endNodeId,
      };
    } catch (error) {
      logger.error(
        `Failed to convert WorkflowDefinition to GraphQL type for ID ${String(
          domainDefinition.id ?? "unknown",
        )}: ${String(error)}`,
      );
      throw new Error(`Failed to convert WorkflowDefinition to GraphQL type: ${String(error)}`);
    }
  }
}
