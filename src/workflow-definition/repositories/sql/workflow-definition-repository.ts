import { Prisma, type AgentWorkflowDefinition as PrismaWorkflowDefinition } from "@prisma/client";
import { BaseRepository } from "repository_prisma";

const logger = {
  info: (...args: unknown[]) => console.info(...args),
  warn: (...args: unknown[]) => console.warn(...args),
  error: (...args: unknown[]) => console.error(...args),
};

export class SqlWorkflowDefinitionRepository extends BaseRepository.forModel(
  Prisma.ModelName.AgentWorkflowDefinition,
) {
  async createDefinition(
    data: Prisma.AgentWorkflowDefinitionCreateInput,
  ): Promise<PrismaWorkflowDefinition> {
    try {
      const created = await this.create({ data });
      logger.info(`Successfully created workflow definition with ID: ${created.id}`);
      return created;
    } catch (error) {
      logger.error(`Failed to create workflow definition: ${String(error)}`);
      throw error;
    }
  }

  async findById(id: number): Promise<PrismaWorkflowDefinition | null> {
    return this.findUnique({ where: { id } });
  }

  async findAll(): Promise<PrismaWorkflowDefinition[]> {
    return this.findMany();
  }

  async updateDefinition(options: {
    id: number;
    data: Prisma.AgentWorkflowDefinitionUpdateInput;
  }): Promise<PrismaWorkflowDefinition> {
    try {
      const updated = await this.update({ where: { id: options.id }, data: options.data });
      logger.info(`Successfully updated workflow definition with ID: ${updated.id}`);
      return updated;
    } catch (error) {
      logger.error(`Failed to update workflow definition with ID ${options.id}: ${String(error)}`);
      throw error;
    }
  }

  async deleteById(id: number): Promise<boolean> {
    try {
      const existing = await this.findById(id);
      if (!existing) {
        logger.warn(`Workflow definition with ID ${id} not found for deletion.`);
        return false;
      }
      await this.delete({ where: { id } });
      logger.info(`Successfully deleted workflow definition with ID: ${id}`);
      return true;
    } catch (error) {
      logger.error(`Failed to delete workflow definition with ID ${id}: ${String(error)}`);
      throw error;
    }
  }
}
