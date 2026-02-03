import { AgentWorkflowDefinition } from "../domain/models.js";
import { SqlWorkflowDefinitionProvider } from "./sql-provider.js";

export class AgentWorkflowDefinitionPersistenceProvider {
  private provider: SqlWorkflowDefinitionProvider;

  constructor() {
    this.provider = new SqlWorkflowDefinitionProvider();
  }

  async create(definition: AgentWorkflowDefinition): Promise<AgentWorkflowDefinition> {
    return this.provider.create(definition);
  }

  async getById(id: string): Promise<AgentWorkflowDefinition | null> {
    return this.provider.getById(id);
  }

  async getAll(): Promise<AgentWorkflowDefinition[]> {
    return this.provider.getAll();
  }

  async update(definition: AgentWorkflowDefinition): Promise<AgentWorkflowDefinition> {
    return this.provider.update(definition);
  }

  async delete(id: string): Promise<boolean> {
    return this.provider.delete(id);
  }
}
