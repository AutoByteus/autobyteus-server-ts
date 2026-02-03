import { describe, expect, it } from "vitest";
import { SqlWorkflowDefinitionProvider } from "../../../src/workflow-definition/providers/sql-provider.js";
import { AgentWorkflowDefinition, WorkflowNode } from "../../../src/workflow-definition/domain/models.js";
import { NodeType } from "../../../src/workflow-definition/domain/enums.js";
const uniqueName = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const buildWorkflowDefinition = () => new AgentWorkflowDefinition({
    name: uniqueName("Workflow"),
    description: "A test workflow",
    nodes: [
        new WorkflowNode({
            nodeId: "node1",
            nodeType: NodeType.AGENT,
            referenceId: "agent1",
            dependencies: [],
            properties: {},
        }),
        new WorkflowNode({
            nodeId: "node2",
            nodeType: NodeType.WORKFLOW,
            referenceId: "wf1",
            dependencies: ["node1"],
            properties: { mode: "final" },
        }),
    ],
    beginNodeId: "node1",
    endNodeId: "node2",
});
describe("SqlWorkflowDefinitionProvider", () => {
    it("handles CRUD operations", async () => {
        const provider = new SqlWorkflowDefinitionProvider();
        const definition = buildWorkflowDefinition();
        const created = await provider.create(definition);
        expect(created.id).toBeTruthy();
        expect(created.nodes[0]).toBeInstanceOf(WorkflowNode);
        const retrieved = await provider.getById(created.id ?? "");
        expect(retrieved?.id).toBe(created.id);
        expect(retrieved?.name).toBe(definition.name);
        retrieved.description = "Updated Description";
        const updated = await provider.update(retrieved);
        expect(updated.description).toBe("Updated Description");
        const deleted = await provider.delete(updated.id ?? "");
        expect(deleted).toBe(true);
        const missing = await provider.getById(updated.id ?? "");
        expect(missing).toBeNull();
    });
});
