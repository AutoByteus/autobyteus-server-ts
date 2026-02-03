import { AgentPromptMapping } from "../domain/models.js";
import { PrismaAgentPromptMappingConverter } from "../converters/prisma-converter.js";
import { SqlAgentPromptMappingRepository } from "../repositories/sql/agent-prompt-mapping-repository.js";

export class SqlAgentPromptMappingProvider {
  private repository: SqlAgentPromptMappingRepository;

  constructor(repository: SqlAgentPromptMappingRepository = new SqlAgentPromptMappingRepository()) {
    this.repository = repository;
  }

  async getByAgentDefinitionId(agentDefinitionId: string): Promise<AgentPromptMapping | null> {
    const mapping = await this.repository.getByAgentDefinitionId(Number(agentDefinitionId));
    return mapping ? PrismaAgentPromptMappingConverter.toDomain(mapping) : null;
  }

  async upsert(domainObj: AgentPromptMapping): Promise<AgentPromptMapping> {
    const agentDefinitionId = Number(domainObj.agentDefinitionId);
    const createInput = PrismaAgentPromptMappingConverter.toCreateInput(domainObj);
    const updateInput = PrismaAgentPromptMappingConverter.toUpdateInput(domainObj);
    const result = await this.repository.upsertMapping(agentDefinitionId, createInput, updateInput);
    return PrismaAgentPromptMappingConverter.toDomain(result);
  }

  async deleteByAgentDefinitionId(agentDefinitionId: string): Promise<boolean> {
    return this.repository.deleteByAgentDefinitionId(Number(agentDefinitionId));
  }
}
