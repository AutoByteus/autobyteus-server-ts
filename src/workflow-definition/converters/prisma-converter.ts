import type { AgentWorkflowDefinition as PrismaWorkflowDefinition, Prisma } from "@prisma/client";
import { AgentWorkflowDefinition, WorkflowNode } from "../domain/models.js";
import { NodeType } from "../domain/enums.js";

const parseNodeType = (value: unknown): NodeType | null => {
  if (value === NodeType.AGENT || value === NodeType.WORKFLOW) {
    return value;
  }
  if (typeof value === "string") {
    if (value === NodeType.AGENT || value === NodeType.WORKFLOW) {
      return value as NodeType;
    }
  }
  return null;
};

const parseNodes = (value: unknown): WorkflowNode[] => {
  let rawNodes: unknown[] = [];

  if (Array.isArray(value)) {
    rawNodes = value;
  } else if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        rawNodes = parsed;
      }
    } catch {
      return [];
    }
  } else {
    return [];
  }

  return rawNodes
    .map((node) => {
      if (!node || typeof node !== "object") {
        return null;
      }
      const record = node as Record<string, unknown>;
      const nodeId = (record.nodeId ?? record.node_id) as string | undefined;
      const referenceId = (record.referenceId ?? record.reference_id) as string | undefined;
      const nodeTypeRaw = record.nodeType ?? record.node_type;
      const nodeType = parseNodeType(nodeTypeRaw);
      const dependencies = Array.isArray(record.dependencies)
        ? record.dependencies.filter((item): item is string => typeof item === "string")
        : [];
      const properties =
        record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)
          ? (record.properties as Record<string, unknown>)
          : {};

      if (!nodeId || !referenceId || !nodeType) {
        return null;
      }

      return new WorkflowNode({
        nodeId,
        nodeType,
        referenceId,
        dependencies,
        properties,
      });
    })
    .filter((node): node is WorkflowNode => node !== null);
};

const toNodePayload = (node: WorkflowNode): Record<string, unknown> => ({
  node_id: node.nodeId,
  node_type: node.nodeType,
  reference_id: node.referenceId,
  dependencies: node.dependencies,
  properties: node.properties,
});

export class PrismaWorkflowDefinitionConverter {
  static toDomain(prismaObj: PrismaWorkflowDefinition): AgentWorkflowDefinition {
    return new AgentWorkflowDefinition({
      id: prismaObj.id?.toString(),
      name: prismaObj.name,
      description: prismaObj.description,
      nodes: parseNodes(prismaObj.nodes),
      beginNodeId: prismaObj.beginNodeId,
      endNodeId: prismaObj.endNodeId,
    });
  }

  static toCreateInput(domainObj: AgentWorkflowDefinition): Prisma.AgentWorkflowDefinitionCreateInput {
    return {
      name: domainObj.name,
      description: domainObj.description,
      nodes: JSON.stringify(domainObj.nodes.map(toNodePayload)),
      beginNodeId: domainObj.beginNodeId,
      endNodeId: domainObj.endNodeId,
    };
  }

  static toUpdateInput(domainObj: AgentWorkflowDefinition): {
    id: number;
    data: Prisma.AgentWorkflowDefinitionUpdateInput;
  } {
    if (!domainObj.id) {
      throw new Error("AgentWorkflowDefinition id is required for update");
    }

    return {
      id: Number(domainObj.id),
      data: {
        name: domainObj.name,
        description: domainObj.description,
        nodes: JSON.stringify(domainObj.nodes.map(toNodePayload)),
        beginNodeId: domainObj.beginNodeId,
        endNodeId: domainObj.endNodeId,
      },
    };
  }
}
