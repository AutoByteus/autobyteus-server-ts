import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ExternalChannelProvider } from "autobyteus-ts/external-channel/provider.js";
import { ExternalChannelTransport } from "autobyteus-ts/external-channel/channel-transport.js";
import { SqlChannelMessageReceiptProvider } from "../../../../src/external-channel/providers/sql-channel-message-receipt-provider.js";

const unique = (prefix: string): string => `${prefix}-${randomUUID()}`;

describe("SqlChannelMessageReceiptProvider", () => {
  it("records ingress receipt and returns latest source by agentId", async () => {
    const provider = new SqlChannelMessageReceiptProvider();
    const agentId = unique("agent");
    const accountId = unique("acct");
    const peerId = unique("peer");

    await provider.recordIngressReceipt({
      provider: ExternalChannelProvider.WHATSAPP,
      transport: ExternalChannelTransport.BUSINESS_API,
      accountId,
      peerId,
      threadId: null,
      externalMessageId: "ext-1",
      receivedAt: new Date("2026-02-08T00:00:00.000Z"),
      agentId,
      teamId: null,
    });

    const source = await provider.getLatestSourceByAgentId(agentId);

    expect(source).not.toBeNull();
    expect(source?.provider).toBe(ExternalChannelProvider.WHATSAPP);
    expect(source?.transport).toBe(ExternalChannelTransport.BUSINESS_API);
    expect(source?.threadId).toBeNull();
    expect(source?.externalMessageId).toBe("ext-1");
  });

  it("returns the most recent source context by receivedAt", async () => {
    const provider = new SqlChannelMessageReceiptProvider();
    const agentId = unique("agent");
    const accountId = unique("acct");
    const peerId = unique("peer");

    await provider.recordIngressReceipt({
      provider: ExternalChannelProvider.WHATSAPP,
      transport: ExternalChannelTransport.BUSINESS_API,
      accountId,
      peerId,
      threadId: "thread-1",
      externalMessageId: "ext-old",
      receivedAt: new Date("2026-02-08T00:00:00.000Z"),
      agentId,
      teamId: null,
    });
    await provider.recordIngressReceipt({
      provider: ExternalChannelProvider.WHATSAPP,
      transport: ExternalChannelTransport.BUSINESS_API,
      accountId,
      peerId,
      threadId: "thread-1",
      externalMessageId: "ext-new",
      receivedAt: new Date("2026-02-08T00:01:00.000Z"),
      agentId,
      teamId: null,
    });

    const source = await provider.getLatestSourceByAgentId(agentId);

    expect(source?.externalMessageId).toBe("ext-new");
    expect(source?.threadId).toBe("thread-1");
  });

  it("upserts duplicate route+message receipt key instead of creating duplicates", async () => {
    const provider = new SqlChannelMessageReceiptProvider();
    const agentId = unique("agent");
    const accountId = unique("acct");
    const peerId = unique("peer");

    await provider.recordIngressReceipt({
      provider: ExternalChannelProvider.WHATSAPP,
      transport: ExternalChannelTransport.PERSONAL_SESSION,
      accountId,
      peerId,
      threadId: null,
      externalMessageId: "ext-dup",
      receivedAt: new Date("2026-02-08T00:00:00.000Z"),
      agentId,
      teamId: null,
    });
    await provider.recordIngressReceipt({
      provider: ExternalChannelProvider.WHATSAPP,
      transport: ExternalChannelTransport.PERSONAL_SESSION,
      accountId,
      peerId,
      threadId: null,
      externalMessageId: "ext-dup",
      receivedAt: new Date("2026-02-08T00:05:00.000Z"),
      agentId,
      teamId: null,
    });

    const source = await provider.getLatestSourceByAgentId(agentId);
    expect(source?.externalMessageId).toBe("ext-dup");
    expect(source?.receivedAt.toISOString()).toBe("2026-02-08T00:05:00.000Z");
  });

  it("returns null for unknown agent and rejects blank lookup keys", async () => {
    const provider = new SqlChannelMessageReceiptProvider();
    const missing = await provider.getLatestSourceByAgentId(unique("missing-agent"));
    expect(missing).toBeNull();

    await expect(provider.getLatestSourceByAgentId("   ")).rejects.toThrow(
      "agentId must be a non-empty string.",
    );
  });

  it("resolves latest source by dispatch target (agent first, then team)", async () => {
    const provider = new SqlChannelMessageReceiptProvider();
    const accountId = unique("acct");
    const peerId = unique("peer");
    const teamId = unique("team");
    const agentId = unique("agent");

    await provider.recordIngressReceipt({
      provider: ExternalChannelProvider.WHATSAPP,
      transport: ExternalChannelTransport.PERSONAL_SESSION,
      accountId,
      peerId,
      threadId: null,
      externalMessageId: "team-msg",
      receivedAt: new Date("2026-02-08T00:00:00.000Z"),
      agentId: null,
      teamId,
    });

    const teamSource = await provider.getLatestSourceByDispatchTarget({
      agentId: null,
      teamId,
    });
    expect(teamSource?.externalMessageId).toBe("team-msg");

    await provider.recordIngressReceipt({
      provider: ExternalChannelProvider.WHATSAPP,
      transport: ExternalChannelTransport.PERSONAL_SESSION,
      accountId,
      peerId,
      threadId: null,
      externalMessageId: "agent-msg",
      receivedAt: new Date("2026-02-08T00:01:00.000Z"),
      agentId,
      teamId,
    });

    const preferred = await provider.getLatestSourceByDispatchTarget({
      agentId,
      teamId,
    });
    expect(preferred?.externalMessageId).toBe("agent-msg");
  });

  it("binds turn to receipt and resolves source by (agentId, turnId)", async () => {
    const provider = new SqlChannelMessageReceiptProvider();
    const agentId = unique("agent");
    const accountId = unique("acct");
    const peerId = unique("peer");

    await provider.bindTurnToReceipt({
      provider: ExternalChannelProvider.WHATSAPP,
      transport: ExternalChannelTransport.PERSONAL_SESSION,
      accountId,
      peerId,
      threadId: null,
      externalMessageId: "ext-turn-1",
      turnId: "turn-1",
      agentId,
      teamId: null,
      receivedAt: new Date("2026-02-09T00:00:00.000Z"),
    });

    const source = await provider.getSourceByAgentTurn(agentId, "turn-1");
    expect(source).not.toBeNull();
    expect(source?.externalMessageId).toBe("ext-turn-1");
    expect(source?.turnId).toBe("turn-1");
  });
});
