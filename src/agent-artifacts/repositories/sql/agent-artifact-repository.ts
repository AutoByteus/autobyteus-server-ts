import { Prisma, type AgentArtifact as PrismaAgentArtifact } from "@prisma/client";
import { BaseRepository } from "repository_prisma";

const logger = {
  info: (...args: unknown[]) => console.info(...args),
  error: (...args: unknown[]) => console.error(...args),
};

export class SqlAgentArtifactRepository extends BaseRepository.forModel(
  Prisma.ModelName.AgentArtifact,
) {
  async createArtifact(options: {
    agentId: string;
    path: string;
    type: string;
    workspaceRoot?: string | null;
    url?: string | null;
    createdAt?: Date;
    updatedAt?: Date;
  }): Promise<PrismaAgentArtifact> {
    try {
      const created = await this.create({
        data: {
          agentId: options.agentId,
          path: options.path,
          type: options.type,
          workspaceRoot: options.workspaceRoot ?? undefined,
          url: options.url ?? undefined,
          createdAt: options.createdAt ?? undefined,
          updatedAt: options.updatedAt ?? undefined,
        },
      });
      logger.info(`Created agent artifact with ID ${created.id}`);
      return created;
    } catch (error) {
      logger.error(`Failed to create agent artifact: ${String(error)}`);
      throw error;
    }
  }

  async findById(id: number): Promise<PrismaAgentArtifact | null> {
    try {
      return await this.findUnique({ where: { id } });
    } catch (error) {
      logger.error(`Failed to find agent artifact by id ${id}: ${String(error)}`);
      throw error;
    }
  }

  async getByAgentId(agentId: string): Promise<PrismaAgentArtifact[]> {
    try {
      return await this.findMany({
        where: { agentId },
        orderBy: { createdAt: "asc" },
      });
    } catch (error) {
      logger.error(`Failed to get artifacts for agent ${agentId}: ${String(error)}`);
      throw error;
    }
  }
}
