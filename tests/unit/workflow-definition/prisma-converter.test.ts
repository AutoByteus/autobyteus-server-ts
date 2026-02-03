import { describe, expect, it } from "vitest";
import type { AgentWorkflowDefinition as PrismaWorkflowDefinition } from "@prisma/client";
import { PrismaWorkflowDefinitionConverter } from "../../../src/workflow-definition/converters/prisma-converter.js";
import { AgentWorkflowDefinition, WorkflowNode } from "../../../src/workflow-definition/domain/models.js";
import { NodeType } from "../../../src/workflow-definition/domain/enums.js";

const sampleNodesData = [
  {
    node_id: "start",
    node_type: "AGENT",
    reference_id: "agent_1",
    dependencies: [],
    properties: {},
  },
  {
    node_id: "middle",
    node_type: "AGENT",
    reference_id: "agent_2",
    dependencies: ["start"],
    properties: {},
  },
  {
    node_id: "end",
    node_type: "WORKFLOW",
    reference_id: "wf_1",
    dependencies: ["middle"],
    properties: { mode: "final" },
  },
];

const buildDomainDefinition = () =>
  new AgentWorkflowDefinition({
    id: "123",
    name: "Domain Workflow",
    description: "A test workflow object.",
    nodes: sampleNodesData.map(
      (node) =>
        new WorkflowNode({
          nodeId: node.node_id,
          nodeType: node.node_type as NodeType,
          referenceId: node.reference_id,
          dependencies: node.dependencies,
          properties: node.properties,
        }),
    ),
    beginNodeId: "start",
    endNodeId: "end",
  });

describe("PrismaWorkflowDefinitionConverter", () => {
  it("converts Prisma model to domain", () => {
    const prismaObj: PrismaWorkflowDefinition = {
      id: 123,
      name: "SQL Workflow",
      description: "From DB",
      nodes: JSON.stringify(sampleNodesData),
      beginNodeId: "start",
      endNodeId: "end",
    };

    const domainObj = PrismaWorkflowDefinitionConverter.toDomain(prismaObj);

    expect(domainObj.id).toBe("123");
    expect(domainObj.name).toBe(prismaObj.name);
    expect(domainObj.description).toBe(prismaObj.description);
    expect(domainObj.beginNodeId).toBe(prismaObj.beginNodeId);
    expect(domainObj.endNodeId).toBe(prismaObj.endNodeId);
    expect(domainObj.nodes).toHaveLength(3);
    expect(domainObj.nodes[1]).toBeInstanceOf(WorkflowNode);
    expect(domainObj.nodes[1].nodeId).toBe("middle");
    expect(domainObj.nodes[1].nodeType).toBe(NodeType.AGENT);
    expect(domainObj.nodes[1].dependencies).toEqual(["start"]);
  });

  it("converts domain to Prisma create input", () => {
    const domainObj = buildDomainDefinition();

    const createInput = PrismaWorkflowDefinitionConverter.toCreateInput(domainObj);

    expect(createInput.name).toBe(domainObj.name);
    expect(createInput.description).toBe(domainObj.description);
    expect(createInput.beginNodeId).toBe(domainObj.beginNodeId);
    expect(createInput.endNodeId).toBe(domainObj.endNodeId);

    const nodesPayload = JSON.parse(createInput.nodes) as Array<Record<string, unknown>>;
    expect(nodesPayload[1]?.node_id).toBe("middle");
    expect(nodesPayload[1]?.dependencies).toEqual(["start"]);
    expect(nodesPayload[2]?.node_type).toBe("WORKFLOW");
  });

  it("converts domain to Prisma update input", () => {
    const domainObj = buildDomainDefinition();

    const updateInput = PrismaWorkflowDefinitionConverter.toUpdateInput(domainObj);

    expect(updateInput.id).toBe(123);
    expect(updateInput.data.name).toBe(domainObj.name);
    expect(updateInput.data.description).toBe(domainObj.description);
  });

  it("throws when updating without an id", () => {
    const domainObj = buildDomainDefinition();
    domainObj.id = null;

    expect(() => PrismaWorkflowDefinitionConverter.toUpdateInput(domainObj)).toThrow(
      "AgentWorkflowDefinition id is required for update",
    );
  });
});
