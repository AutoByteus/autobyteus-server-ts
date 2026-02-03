import { AgentWorkflowDefinition } from "../domain/models.js";
import { PrismaWorkflowDefinitionConverter } from "../converters/prisma-converter.js";
import { SqlWorkflowDefinitionRepository } from "../repositories/sql/workflow-definition-repository.js";

export class SqlWorkflowDefinitionProvider {
  private repository: SqlWorkflowDefinitionRepository;
  private converter: typeof PrismaWorkflowDefinitionConverter;

  constructor() {
    this.repository = new SqlWorkflowDefinitionRepository();
    this.converter = PrismaWorkflowDefinitionConverter;
  }

  async create(domainObj: AgentWorkflowDefinition): Promise<AgentWorkflowDefinition> {
    const createInput = this.converter.toCreateInput(domainObj);
    const created = await this.repository.createDefinition(createInput);
    return this.converter.toDomain(created);
  }

  async getById(id: string): Promise<AgentWorkflowDefinition | null> {
    const record = await this.repository.findById(Number(id));
    return record ? this.converter.toDomain(record) : null;
  }

  async getAll(): Promise<AgentWorkflowDefinition[]> {
    const records = await this.repository.findAll();
    return records.map((record) => this.converter.toDomain(record));
  }

  async update(domainObj: AgentWorkflowDefinition): Promise<AgentWorkflowDefinition> {
    const updateInput = this.converter.toUpdateInput(domainObj);
    const updated = await this.repository.updateDefinition(updateInput);
    return this.converter.toDomain(updated);
  }

  async delete(id: string): Promise<boolean> {
    return this.repository.deleteById(Number(id));
  }
}
