import type { AgentArtifact } from "../domain/models.js";

export type CreateArtifactInput = {
  agentId: string;
  path: string;
  type: string;
  workspaceRoot?: string | null;
  url?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
};

export interface ArtifactPersistenceProvider {
  createArtifact(input: CreateArtifactInput): Promise<AgentArtifact>;
  getByAgentId(agentId: string): Promise<AgentArtifact[]>;
}
