import {
  parseExternalChannelProvider,
  type ExternalChannelProvider,
} from "autobyteus-ts/external-channel/provider.js";
import {
  parseExternalChannelTransport,
  type ExternalChannelTransport,
} from "autobyteus-ts/external-channel/channel-transport.js";
import type {
  ChannelDispatchTarget,
  ChannelIngressReceiptInput,
  ChannelSourceContext,
  ChannelTurnReceiptBindingInput,
} from "../domain/models.js";
import type { ChannelMessageReceiptProvider } from "./channel-message-receipt-provider.js";
import {
  normalizeNullableString,
  normalizeRequiredString,
  parseDate,
  readJsonArrayFile,
  resolvePersistencePath,
  updateJsonArrayFile,
} from "../../persistence/file/store-utils.js";

type ChannelMessageReceiptRow = {
  provider: string;
  transport: string;
  accountId: string;
  peerId: string;
  threadId: string;
  externalMessageId: string;
  turnId: string | null;
  agentId: string | null;
  teamId: string | null;
  receivedAt: string;
  createdAt: string;
  updatedAt: string;
};

const messageReceiptFilePath = resolvePersistencePath("external-channel", "message-receipts.json");

const toThreadStorage = (threadId: string | null): string => normalizeNullableString(threadId) ?? "";
const fromThreadStorage = (threadId: string): string | null => normalizeNullableString(threadId);

const sortByReceivedThenUpdatedDesc = (rows: ChannelMessageReceiptRow[]): ChannelMessageReceiptRow[] =>
  [...rows].sort((a, b) => {
    const receivedDiff = parseDate(b.receivedAt).getTime() - parseDate(a.receivedAt).getTime();
    if (receivedDiff !== 0) {
      return receivedDiff;
    }
    return parseDate(b.updatedAt).getTime() - parseDate(a.updatedAt).getTime();
  });

const sortByUpdatedThenReceivedDesc = (rows: ChannelMessageReceiptRow[]): ChannelMessageReceiptRow[] =>
  [...rows].sort((a, b) => {
    const updatedDiff = parseDate(b.updatedAt).getTime() - parseDate(a.updatedAt).getTime();
    if (updatedDiff !== 0) {
      return updatedDiff;
    }
    return parseDate(b.receivedAt).getTime() - parseDate(a.receivedAt).getTime();
  });

const toSourceContext = (row: ChannelMessageReceiptRow): ChannelSourceContext => ({
  provider: parseExternalChannelProvider(row.provider),
  transport: parseExternalChannelTransport(row.transport),
  accountId: row.accountId,
  peerId: row.peerId,
  threadId: fromThreadStorage(row.threadId),
  externalMessageId: row.externalMessageId,
  receivedAt: parseDate(row.receivedAt),
  turnId: normalizeNullableString(row.turnId),
});

export class FileChannelMessageReceiptProvider implements ChannelMessageReceiptProvider {
  async recordIngressReceipt(input: ChannelIngressReceiptInput): Promise<void> {
    const now = new Date().toISOString();
    await updateJsonArrayFile<ChannelMessageReceiptRow>(messageReceiptFilePath, (rows) => {
      const index = rows.findIndex(
        (row) =>
          row.provider === input.provider &&
          row.transport === input.transport &&
          row.accountId === input.accountId &&
          row.peerId === input.peerId &&
          row.threadId === toThreadStorage(input.threadId) &&
          row.externalMessageId === input.externalMessageId,
      );

      if (index < 0) {
        const created: ChannelMessageReceiptRow = {
          provider: input.provider,
          transport: input.transport,
          accountId: input.accountId,
          peerId: input.peerId,
          threadId: toThreadStorage(input.threadId),
          externalMessageId: input.externalMessageId,
          turnId: normalizeNullableString(input.turnId ?? null),
          agentId: normalizeNullableString(input.agentId),
          teamId: normalizeNullableString(input.teamId),
          receivedAt: input.receivedAt.toISOString(),
          createdAt: now,
          updatedAt: now,
        };
        return [...rows, created];
      }

      const current = rows[index] as ChannelMessageReceiptRow;
      const next = [...rows];
      next[index] = {
        ...current,
        agentId: normalizeNullableString(input.agentId),
        teamId: normalizeNullableString(input.teamId),
        receivedAt: input.receivedAt.toISOString(),
        updatedAt: now,
      };
      return next;
    });
  }

  async bindTurnToReceipt(input: ChannelTurnReceiptBindingInput): Promise<void> {
    const now = new Date().toISOString();
    await updateJsonArrayFile<ChannelMessageReceiptRow>(messageReceiptFilePath, (rows) => {
      const index = rows.findIndex(
        (row) =>
          row.provider === input.provider &&
          row.transport === input.transport &&
          row.accountId === input.accountId &&
          row.peerId === input.peerId &&
          row.threadId === toThreadStorage(input.threadId) &&
          row.externalMessageId === input.externalMessageId,
      );

      if (index < 0) {
        const created: ChannelMessageReceiptRow = {
          provider: input.provider,
          transport: input.transport,
          accountId: input.accountId,
          peerId: input.peerId,
          threadId: toThreadStorage(input.threadId),
          externalMessageId: input.externalMessageId,
          turnId: normalizeRequiredString(input.turnId, "turnId"),
          agentId: normalizeNullableString(input.agentId),
          teamId: normalizeNullableString(input.teamId),
          receivedAt: input.receivedAt.toISOString(),
          createdAt: now,
          updatedAt: now,
        };
        return [...rows, created];
      }

      const current = rows[index] as ChannelMessageReceiptRow;
      const next = [...rows];
      next[index] = {
        ...current,
        turnId: normalizeRequiredString(input.turnId, "turnId"),
        agentId: normalizeNullableString(input.agentId),
        teamId: normalizeNullableString(input.teamId),
        receivedAt: input.receivedAt.toISOString(),
        updatedAt: now,
      };
      return next;
    });
  }

  async getLatestSourceByAgentId(agentId: string): Promise<ChannelSourceContext | null> {
    const normalizedAgentId = normalizeRequiredString(agentId, "agentId");
    const rows = await readJsonArrayFile<ChannelMessageReceiptRow>(messageReceiptFilePath);
    const found = sortByReceivedThenUpdatedDesc(rows).find((row) => row.agentId === normalizedAgentId);
    return found ? toSourceContext(found) : null;
  }

  async getLatestSourceByDispatchTarget(
    target: ChannelDispatchTarget,
  ): Promise<ChannelSourceContext | null> {
    const rows = await readJsonArrayFile<ChannelMessageReceiptRow>(messageReceiptFilePath);
    const sorted = sortByReceivedThenUpdatedDesc(rows);

    const agentId = normalizeNullableString(target.agentId);
    if (agentId) {
      const byAgent = sorted.find((row) => row.agentId === agentId);
      if (byAgent) {
        return toSourceContext(byAgent);
      }
    }

    const teamId = normalizeNullableString(target.teamId);
    if (!teamId) {
      return null;
    }

    const byTeam = sorted.find((row) => row.teamId === teamId);
    return byTeam ? toSourceContext(byTeam) : null;
  }

  async getSourceByAgentTurn(
    agentId: string,
    turnId: string,
  ): Promise<ChannelSourceContext | null> {
    const normalizedAgentId = normalizeRequiredString(agentId, "agentId");
    const normalizedTurnId = normalizeRequiredString(turnId, "turnId");
    const rows = await readJsonArrayFile<ChannelMessageReceiptRow>(messageReceiptFilePath);
    const found = sortByUpdatedThenReceivedDesc(rows).find(
      (row) => row.agentId === normalizedAgentId && row.turnId === normalizedTurnId,
    );
    return found ? toSourceContext(found) : null;
  }
}

export type { ExternalChannelProvider, ExternalChannelTransport };
