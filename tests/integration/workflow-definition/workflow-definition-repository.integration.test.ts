import { describe, expect, it } from "vitest";
import { SqlWorkflowDefinitionRepository } from "../../../src/workflow-definition/repositories/sql/workflow-definition-repository.js";

const buildNodesPayload = () =>
  JSON.stringify([
    {
      node_id: "start",
      node_type: "AGENT",
      reference_id: "agent1",
      dependencies: [],
      properties: {},
    },
  ]);

const uniqueName = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

describe("SqlWorkflowDefinitionRepository", () => {
  it("creates and finds workflow definitions", async () => {
    const repo = new SqlWorkflowDefinitionRepository();
    const created = await repo.createDefinition({
      name: uniqueName("SQL Workflow"),
      description: "Test",
      nodes: buildNodesPayload(),
      beginNodeId: "start",
      endNodeId: "start",
    });

    expect(created.id).toBeDefined();
    expect(created.description).toBe("Test");

    const found = await repo.findById(created.id);
    expect(found).not.toBeNull();
    expect(found?.name).toBe(created.name);

    const nodes = JSON.parse(found?.nodes ?? "[]") as Array<{ node_id?: string }>;
    expect(nodes[0]?.node_id).toBe("start");
  });

  it("updates workflow definitions", async () => {
    const repo = new SqlWorkflowDefinitionRepository();
    const created = await repo.createDefinition({
      name: uniqueName("Update SQL Workflow"),
      description: "Original",
      nodes: buildNodesPayload(),
      beginNodeId: "start",
      endNodeId: "start",
    });

    const updated = await repo.updateDefinition({
      id: created.id,
      data: { description: "Updated" },
    });

    expect(updated.description).toBe("Updated");
  });

  it("deletes workflow definitions", async () => {
    const repo = new SqlWorkflowDefinitionRepository();
    const created = await repo.createDefinition({
      name: uniqueName("Delete SQL Workflow"),
      description: "To delete",
      nodes: buildNodesPayload(),
      beginNodeId: "start",
      endNodeId: "start",
    });

    const deleted = await repo.deleteById(created.id);
    expect(deleted).toBe(true);

    const found = await repo.findById(created.id);
    expect(found).toBeNull();
  });
});
