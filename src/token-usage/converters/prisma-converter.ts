import type { Prisma, TokenUsageRecord as PrismaTokenUsageRecord } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { TokenUsageRecord } from "../domain/models.js";

export class PrismaConverter {
  toDomainRecord(sqlRecord: PrismaTokenUsageRecord): TokenUsageRecord {
    return new TokenUsageRecord({
      agentId: sqlRecord.agentId,
      role: sqlRecord.role,
      tokenCount: sqlRecord.tokenCount,
      cost: sqlRecord.cost,
      createdAt: sqlRecord.createdAt,
      tokenUsageRecordId: sqlRecord.usageRecordId,
      llmModel: sqlRecord.llmModel ?? null,
    });
  }

  toDomainRecords(records: PrismaTokenUsageRecord[]): TokenUsageRecord[] {
    return records.map((record) => this.toDomainRecord(record));
  }

  toCreateInput(domainRecord: TokenUsageRecord): Prisma.TokenUsageRecordCreateInput {
    return {
      usageRecordId: domainRecord.tokenUsageRecordId ?? randomUUID(),
      agentId: domainRecord.agentId,
      role: domainRecord.role,
      tokenCount: domainRecord.tokenCount,
      cost: domainRecord.cost,
      createdAt: domainRecord.createdAt ?? new Date(),
      llmModel: domainRecord.llmModel ?? undefined,
    };
  }
}
