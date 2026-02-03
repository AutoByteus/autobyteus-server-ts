import { AgentWorkflowDefinition, WorkflowNode } from "../domain/models.js";
import { NodeType } from "../domain/enums.js";
import { AgentWorkflowDefinitionPersistenceProvider } from "../providers/persistence-provider.js";

const logger = {
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
};

type WorkflowDefinitionProvider = {
  create: (definition: AgentWorkflowDefinition) => Promise<AgentWorkflowDefinition>;
  getById: (id: string) => Promise<AgentWorkflowDefinition | null>;
  getAll: () => Promise<AgentWorkflowDefinition[]>;
  update: (definition: AgentWorkflowDefinition) => Promise<AgentWorkflowDefinition>;
  delete: (id: string) => Promise<boolean>;
};

type WorkflowDefinitionServiceOptions = {
  provider?: WorkflowDefinitionProvider;
  persistenceProvider?: AgentWorkflowDefinitionPersistenceProvider;
};

type WorkflowNodeInput = {
  nodeId: string;
  nodeType: NodeType | string;
  referenceId: string;
  dependencies?: string[];
  properties?: Record<string, unknown>;
};

export type WorkflowDefinitionCreateInput = {
  name: string;
  description: string;
  nodes: WorkflowNodeInput[];
  beginNodeId: string;
  endNodeId: string;
};

const parseNodeType = (value: unknown): NodeType => {
  if (value === NodeType.AGENT || value === NodeType.WORKFLOW) {
    return value as NodeType;
  }
  if (typeof value === "string") {
    if (value === NodeType.AGENT || value === NodeType.WORKFLOW) {
      return value as NodeType;
    }
  }
  throw new Error(`Invalid node_type '${String(value)}' for workflow node.`);
};

const toWorkflowNodes = (nodes: WorkflowNodeInput[]): WorkflowNode[] => {
  return nodes.map((node) => {
    const nodeId = node.nodeId;
    const nodeType = parseNodeType(node.nodeType);
    const referenceId = node.referenceId;
    if (!nodeId || !referenceId) {
      throw new Error("Workflow node must include nodeId and referenceId.");
    }
    return new WorkflowNode({
      nodeId,
      nodeType,
      referenceId,
      dependencies: node.dependencies ?? [],
      properties: node.properties ?? {},
    });
  });
};

export class WorkflowDefinitionService {
  private static instance: WorkflowDefinitionService | null = null;

  static getInstance(options: WorkflowDefinitionServiceOptions = {}): WorkflowDefinitionService {
    if (!WorkflowDefinitionService.instance) {
      WorkflowDefinitionService.instance = new WorkflowDefinitionService(options);
    }
    return WorkflowDefinitionService.instance;
  }

  static resetInstance(): void {
    WorkflowDefinitionService.instance = null;
  }

  readonly provider: WorkflowDefinitionProvider;

  constructor(options: WorkflowDefinitionServiceOptions = {}) {
    const persistenceProvider =
      options.persistenceProvider ?? new AgentWorkflowDefinitionPersistenceProvider();
    this.provider = options.provider ?? persistenceProvider;
  }

  async createDefinition(data: WorkflowDefinitionCreateInput): Promise<AgentWorkflowDefinition> {
    if (!data?.name || !data?.description || !data?.nodes) {
      throw new Error("Missing required fields for workflow definition creation.");
    }

    const { beginNodeId, endNodeId } = data;
    if (!beginNodeId || !endNodeId) {
      throw new Error("Missing beginNodeId/endNodeId for workflow definition creation.");
    }

    const nodes = toWorkflowNodes(data.nodes);

    const definition = new AgentWorkflowDefinition({
      name: data.name,
      description: data.description,
      nodes,
      beginNodeId,
      endNodeId,
    });

    const created = await this.provider.create(definition);
    logger.info(`Workflow Definition created successfully with ID: ${created.id}`);
    return created;
  }

  async getDefinitionById(definitionId: string): Promise<AgentWorkflowDefinition | null> {
    return this.provider.getById(definitionId);
  }

  async getAllDefinitions(): Promise<AgentWorkflowDefinition[]> {
    return this.provider.getAll();
  }

  async updateDefinition(
    definitionId: string,
    data: Partial<WorkflowDefinitionCreateInput>,
  ): Promise<AgentWorkflowDefinition> {
    const existing = await this.provider.getById(definitionId);
    if (!existing) {
      throw new Error(`Workflow Definition with ID ${definitionId} not found.`);
    }

    if (data.nodes !== undefined) {
      existing.nodes = toWorkflowNodes(data.nodes);
    }

    const updates: Record<string, unknown> = {
      name: data.name,
      description: data.description,
      beginNodeId: data.beginNodeId,
      endNodeId: data.endNodeId,
    };

    const updateRecord = existing as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(updates)) {
      if (value !== null && value !== undefined && key in existing) {
        updateRecord[key] = value;
      }
    }

    const updated = await this.provider.update(existing);
    logger.info(`Workflow Definition with ID ${definitionId} updated successfully.`);
    return updated;
  }

  async deleteDefinition(definitionId: string): Promise<boolean> {
    const existing = await this.provider.getById(definitionId);
    if (!existing) {
      throw new Error(`Workflow Definition with ID ${definitionId} not found.`);
    }

    const success = await this.provider.delete(definitionId);
    if (success) {
      logger.info(`Workflow Definition with ID ${definitionId} deleted successfully.`);
    } else {
      logger.warn(`Failed to delete workflow definition with ID ${definitionId}.`);
    }
    return success;
  }
}
