import { PrismaAgentArtifactConverter } from "../converters/prisma-converter.js";
import type { AgentArtifact } from "../domain/models.js";
import { SqlAgentArtifactRepository } from "../repositories/sql/agent-artifact-repository.js";
import type { ArtifactPersistenceProvider, CreateArtifactInput } from "./persistence-provider.js";

export class SqlArtifactPersistenceProvider implements ArtifactPersistenceProvider {
  constructor(private readonly repository: SqlAgentArtifactRepository = new SqlAgentArtifactRepository()) {}

  async createArtifact(input: CreateArtifactInput): Promise<AgentArtifact> {
    const created = await this.repository.createArtifact(input);
    return PrismaAgentArtifactConverter.toDomain(created);
  }

  async getByAgentId(agentId: string): Promise<AgentArtifact[]> {
    const records = await this.repository.getByAgentId(agentId);
    return records.map((record) => PrismaAgentArtifactConverter.toDomain(record));
  }
}
