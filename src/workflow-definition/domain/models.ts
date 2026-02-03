import { NodeType } from "./enums.js";

type WorkflowNodeOptions = {
  nodeId: string;
  nodeType: NodeType;
  referenceId: string;
  dependencies?: string[];
  properties?: Record<string, unknown>;
};

export class WorkflowNode {
  nodeId: string;
  nodeType: NodeType;
  referenceId: string;
  dependencies: string[];
  properties: Record<string, unknown>;

  constructor(options: WorkflowNodeOptions) {
    this.nodeId = options.nodeId;
    this.nodeType = options.nodeType;
    this.referenceId = options.referenceId;
    this.dependencies = options.dependencies ?? [];
    this.properties = options.properties ?? {};
  }
}

export class AgentWorkflowDefinition {
  id?: string | null;
  name: string;
  description: string;
  nodes: WorkflowNode[];
  beginNodeId: string;
  endNodeId: string;

  constructor(options: {
    name: string;
    description: string;
    nodes: WorkflowNode[];
    beginNodeId: string;
    endNodeId: string;
    id?: string | null;
  }) {
    this.name = options.name;
    this.description = options.description;
    this.nodes = options.nodes;
    this.beginNodeId = options.beginNodeId;
    this.endNodeId = options.endNodeId;
    this.id = options.id ?? null;
  }
}

export class AgentWorkflowDefinitionUpdate {
  name?: string | null;
  description?: string | null;
  nodes?: WorkflowNode[] | null;
  beginNodeId?: string | null;
  endNodeId?: string | null;

  constructor(options: {
    name?: string | null;
    description?: string | null;
    nodes?: WorkflowNode[] | null;
    beginNodeId?: string | null;
    endNodeId?: string | null;
  } = {}) {
    this.name = options.name ?? null;
    this.description = options.description ?? null;
    this.nodes = options.nodes ?? null;
    this.beginNodeId = options.beginNodeId ?? null;
    this.endNodeId = options.endNodeId ?? null;
  }
}
