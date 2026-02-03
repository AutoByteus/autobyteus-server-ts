export class TokenUsageRecord {
  agentId: string;
  role: string;
  tokenCount: number;
  cost: number;
  createdAt: Date;
  tokenUsageRecordId?: string | null;
  llmModel?: string | null;

  constructor(options: {
    agentId: string;
    role: string;
    tokenCount: number;
    cost: number;
    createdAt?: Date | null;
    tokenUsageRecordId?: string | null;
    llmModel?: string | null;
  }) {
    this.agentId = options.agentId;
    this.role = options.role;
    this.tokenCount = options.tokenCount;
    this.cost = options.cost;
    this.createdAt = options.createdAt ?? new Date();
    this.tokenUsageRecordId = options.tokenUsageRecordId ?? null;
    this.llmModel = options.llmModel ?? null;
  }
}

export class TokenUsageStats {
  promptTokens: number;
  assistantTokens: number;
  promptTokenCost: number;
  assistantTokenCost: number;
  totalCost: number;

  constructor(options?: {
    promptTokens?: number;
    assistantTokens?: number;
    promptTokenCost?: number;
    assistantTokenCost?: number;
    totalCost?: number;
  }) {
    this.promptTokens = options?.promptTokens ?? 0;
    this.assistantTokens = options?.assistantTokens ?? 0;
    this.promptTokenCost = options?.promptTokenCost ?? 0;
    this.assistantTokenCost = options?.assistantTokenCost ?? 0;
    this.totalCost = options?.totalCost ?? 0;
  }
}
