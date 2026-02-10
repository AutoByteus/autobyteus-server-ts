import type {
  ChannelDispatchTarget,
  ChannelIngressReceiptInput,
  ChannelSourceContext,
  ChannelTurnReceiptBindingInput,
} from "../domain/models.js";
import type { ChannelMessageReceiptProvider } from "../providers/channel-message-receipt-provider.js";

export class ChannelMessageReceiptService {
  constructor(private readonly provider: ChannelMessageReceiptProvider) {}

  async recordIngressReceipt(input: ChannelIngressReceiptInput): Promise<void> {
    const normalized = this.normalizeReceiptInput(input);
    await this.provider.recordIngressReceipt(normalized);
  }

  async bindTurnToReceipt(input: ChannelTurnReceiptBindingInput): Promise<void> {
    const normalized = this.normalizeTurnBindingInput(input);
    await this.provider.bindTurnToReceipt(normalized);
  }

  async getLatestSourceByAgentId(
    agentId: string,
  ): Promise<ChannelSourceContext | null> {
    const normalizedAgentId = normalizeRequiredString(agentId, "agentId");
    return this.provider.getLatestSourceByAgentId(normalizedAgentId);
  }

  async getLatestSourceByDispatchTarget(
    target: ChannelDispatchTarget,
  ): Promise<ChannelSourceContext | null> {
    const agentId = normalizeNullableString(target.agentId, "agentId");
    const teamId = normalizeNullableString(target.teamId, "teamId");
    if (!agentId && !teamId) {
      throw new Error(
        "Dispatch target lookup requires at least one of agentId or teamId.",
      );
    }

    return this.provider.getLatestSourceByDispatchTarget({
      agentId,
      teamId,
    });
  }

  async getSourceByAgentTurn(
    agentId: string,
    turnId: string,
  ): Promise<ChannelSourceContext | null> {
    const normalizedAgentId = normalizeRequiredString(agentId, "agentId");
    const normalizedTurnId = normalizeRequiredString(turnId, "turnId");
    return this.provider.getSourceByAgentTurn(normalizedAgentId, normalizedTurnId);
  }

  private normalizeReceiptInput(
    input: ChannelIngressReceiptInput,
  ): ChannelIngressReceiptInput {
    const agentId = normalizeNullableString(input.agentId, "agentId");
    const teamId = normalizeNullableString(input.teamId, "teamId");
    if (!agentId && !teamId) {
      throw new Error(
        "Ingress receipt requires at least one target reference (agentId or teamId).",
      );
    }

    const receivedAt = normalizeDate(input.receivedAt, "receivedAt");

    return {
      ...input,
      accountId: normalizeRequiredString(input.accountId, "accountId"),
      peerId: normalizeRequiredString(input.peerId, "peerId"),
      threadId: normalizeNullableString(input.threadId, "threadId"),
      externalMessageId: normalizeRequiredString(
        input.externalMessageId,
        "externalMessageId",
      ),
      agentId,
      teamId,
      receivedAt,
    };
  }

  private normalizeTurnBindingInput(
    input: ChannelTurnReceiptBindingInput,
  ): ChannelTurnReceiptBindingInput {
    const agentId = normalizeNullableString(input.agentId, "agentId");
    const teamId = normalizeNullableString(input.teamId, "teamId");
    if (!agentId && !teamId) {
      throw new Error(
        "Turn receipt binding requires at least one target reference (agentId or teamId).",
      );
    }

    return {
      ...input,
      accountId: normalizeRequiredString(input.accountId, "accountId"),
      peerId: normalizeRequiredString(input.peerId, "peerId"),
      threadId: normalizeNullableString(input.threadId, "threadId"),
      externalMessageId: normalizeRequiredString(
        input.externalMessageId,
        "externalMessageId",
      ),
      turnId: normalizeRequiredString(input.turnId, "turnId"),
      receivedAt: normalizeDate(input.receivedAt, "receivedAt"),
      agentId,
      teamId,
    };
  }
}

const normalizeRequiredString = (value: string, field: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return normalized;
};

const normalizeNullableString = (
  value: string | null,
  field: string,
): string | null => {
  if (value === null) {
    return null;
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    return null;
  }
  return normalized;
};

const normalizeDate = (value: Date, field: string): Date => {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${field} must be a valid Date.`);
  }
  return value;
};
