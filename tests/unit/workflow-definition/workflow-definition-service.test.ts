import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkflowDefinitionService,
  type WorkflowDefinitionCreateInput,
} from "../../../src/workflow-definition/services/workflow-definition-service.js";
import { AgentWorkflowDefinition, WorkflowNode } from "../../../src/workflow-definition/domain/models.js";
import { NodeType } from "../../../src/workflow-definition/domain/enums.js";

describe("WorkflowDefinitionService", () => {
  let provider: {
    create: ReturnType<typeof vi.fn>;
    getById: ReturnType<typeof vi.fn>;
    getAll: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };

  const buildCreateInput = (): WorkflowDefinitionCreateInput => ({
    name: "Sample Workflow",
    description: "A test workflow",
    nodes: [
      {
        nodeId: "node1",
        nodeType: NodeType.AGENT,
        referenceId: "agent1",
        dependencies: [],
        properties: {},
      },
      {
        nodeId: "node2",
        nodeType: NodeType.WORKFLOW,
        referenceId: "wf1",
        dependencies: ["node1"],
        properties: { mode: "final" },
      },
    ],
    beginNodeId: "node1",
    endNodeId: "node2",
  });

  const buildDomainDefinition = (id?: string) => {
    const input = buildCreateInput();
    return new AgentWorkflowDefinition({
      id,
      name: input.name,
      description: input.description,
      nodes: input.nodes.map(
        (node) =>
          new WorkflowNode({
            nodeId: node.nodeId,
            nodeType: node.nodeType as NodeType,
            referenceId: node.referenceId,
            dependencies: node.dependencies ?? [],
            properties: node.properties ?? {},
          }),
      ),
      beginNodeId: input.beginNodeId,
      endNodeId: input.endNodeId,
    });
  };

  beforeEach(() => {
    provider = {
      create: vi.fn(async (definition: AgentWorkflowDefinition) =>
        new AgentWorkflowDefinition({
          id: "def-123",
          name: definition.name,
          description: definition.description,
          nodes: definition.nodes,
          beginNodeId: definition.beginNodeId,
          endNodeId: definition.endNodeId,
        }),
      ),
      getById: vi.fn(async () => null),
      getAll: vi.fn(async () => []),
      update: vi.fn(async (definition: AgentWorkflowDefinition) => definition),
      delete: vi.fn(async () => true),
    };
  });

  const buildService = () => new WorkflowDefinitionService({ provider });

  it("creates workflow definitions", async () => {
    const service = buildService();
    const input = buildCreateInput();

    const created = await service.createDefinition(input);

    expect(provider.create).toHaveBeenCalledOnce();
    const passed = provider.create.mock.calls[0]?.[0] as AgentWorkflowDefinition;
    expect(passed.id).toBeNull();
    expect(passed.nodes[0]).toBeInstanceOf(WorkflowNode);
    expect(created.id).toBe("def-123");
  });

  it("gets definitions by id", async () => {
    const service = buildService();
    const existing = buildDomainDefinition("def-123");
    provider.getById.mockResolvedValue(existing);

    const retrieved = await service.getDefinitionById("def-123");

    expect(provider.getById).toHaveBeenCalledWith("def-123");
    expect(retrieved).toBe(existing);
  });

  it("returns null for missing definitions", async () => {
    const service = buildService();
    provider.getById.mockResolvedValue(null);

    const retrieved = await service.getDefinitionById("missing-id");

    expect(provider.getById).toHaveBeenCalledWith("missing-id");
    expect(retrieved).toBeNull();
  });

  it("gets all definitions", async () => {
    const service = buildService();
    const existing = buildDomainDefinition("def-123");
    provider.getAll.mockResolvedValue([existing]);

    const allDefs = await service.getAllDefinitions();

    expect(provider.getAll).toHaveBeenCalledOnce();
    expect(allDefs).toEqual([existing]);
  });

  it("updates definitions with provided fields", async () => {
    const service = buildService();
    const existing = buildDomainDefinition("def-123");
    provider.getById.mockResolvedValue(existing);

    const updateData: Partial<WorkflowDefinitionCreateInput> = {
      description: "Updated Description",
      nodes: [
        {
          nodeId: "node1",
          nodeType: "AGENT",
          referenceId: "agent1",
          dependencies: [],
          properties: {},
        },
      ],
    };

    const updated = await service.updateDefinition("def-123", updateData);

    expect(provider.getById).toHaveBeenCalledWith("def-123");
    expect(provider.update).toHaveBeenCalledOnce();
    expect(updated.description).toBe("Updated Description");
    expect(updated.nodes[0].nodeType).toBe(NodeType.AGENT);
  });

  it("throws when updating missing definitions", async () => {
    const service = buildService();
    provider.getById.mockResolvedValue(null);

    await expect(service.updateDefinition("missing-id", { description: "Updated" })).rejects.toThrow(
      "Workflow Definition with ID missing-id not found.",
    );
  });

  it("deletes definitions", async () => {
    const service = buildService();
    const existing = buildDomainDefinition("def-123");
    provider.getById.mockResolvedValue(existing);
    provider.delete.mockResolvedValue(true);

    const result = await service.deleteDefinition("def-123");

    expect(provider.getById).toHaveBeenCalledWith("def-123");
    expect(provider.delete).toHaveBeenCalledWith("def-123");
    expect(result).toBe(true);
  });

  it("throws when deleting missing definitions", async () => {
    const service = buildService();
    provider.getById.mockResolvedValue(null);

    await expect(service.deleteDefinition("missing-id")).rejects.toThrow(
      "Workflow Definition with ID missing-id not found.",
    );
  });
});
