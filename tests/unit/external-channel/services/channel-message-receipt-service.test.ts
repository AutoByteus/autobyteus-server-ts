import { describe, expect, it, vi } from "vitest";
import { ExternalChannelProvider } from "autobyteus-ts/external-channel/provider.js";
import { ExternalChannelTransport } from "autobyteus-ts/external-channel/channel-transport.js";
import { ChannelMessageReceiptService } from "../../../../src/external-channel/services/channel-message-receipt-service.js";
import type {
  ChannelIngressReceiptInput,
  ChannelSourceContext,
} from "../../../../src/external-channel/domain/models.js";
import type { ChannelMessageReceiptProvider } from "../../../../src/external-channel/providers/channel-message-receipt-provider.js";

const createReceiptInput = (): ChannelIngressReceiptInput => ({
  provider: ExternalChannelProvider.WHATSAPP,
  transport: ExternalChannelTransport.BUSINESS_API,
  accountId: " account-1 ",
  peerId: " peer-1 ",
  threadId: " thread-1 ",
  externalMessageId: " msg-1 ",
  receivedAt: new Date("2026-02-08T00:00:00.000Z"),
  agentId: " agent-1 ",
  teamId: null,
});

const createSourceContext = (): ChannelSourceContext => ({
  provider: ExternalChannelProvider.WHATSAPP,
  transport: ExternalChannelTransport.BUSINESS_API,
  accountId: "account-1",
  peerId: "peer-1",
  threadId: "thread-1",
  externalMessageId: "msg-1",
  receivedAt: new Date("2026-02-08T00:00:00.000Z"),
});

describe("ChannelMessageReceiptService", () => {
  it("normalizes values and delegates receipt writes", async () => {
    const provider: ChannelMessageReceiptProvider = {
      recordIngressReceipt: vi.fn().mockResolvedValue(undefined),
      bindTurnToReceipt: vi.fn().mockResolvedValue(undefined),
      getLatestSourceByAgentId: vi.fn(),
      getLatestSourceByDispatchTarget: vi.fn(),
      getSourceByAgentTurn: vi.fn(),
    };
    const service = new ChannelMessageReceiptService(provider);

    await service.recordIngressReceipt(createReceiptInput());

    expect(provider.recordIngressReceipt).toHaveBeenCalledWith({
      provider: ExternalChannelProvider.WHATSAPP,
      transport: ExternalChannelTransport.BUSINESS_API,
      accountId: "account-1",
      peerId: "peer-1",
      threadId: "thread-1",
      externalMessageId: "msg-1",
      receivedAt: new Date("2026-02-08T00:00:00.000Z"),
      agentId: "agent-1",
      teamId: null,
    });
  });

  it("throws when both agentId and teamId are absent", async () => {
    const provider: ChannelMessageReceiptProvider = {
      recordIngressReceipt: vi.fn(),
      bindTurnToReceipt: vi.fn(),
      getLatestSourceByAgentId: vi.fn(),
      getLatestSourceByDispatchTarget: vi.fn(),
      getSourceByAgentTurn: vi.fn(),
    };
    const service = new ChannelMessageReceiptService(provider);
    const input = createReceiptInput();
    input.agentId = null;

    await expect(service.recordIngressReceipt(input)).rejects.toThrow(
      "Ingress receipt requires at least one target reference (agentId or teamId).",
    );
    expect(provider.recordIngressReceipt).not.toHaveBeenCalled();
  });

  it("validates and delegates source lookups", async () => {
    const context = createSourceContext();
    const provider: ChannelMessageReceiptProvider = {
      recordIngressReceipt: vi.fn(),
      bindTurnToReceipt: vi.fn(),
      getLatestSourceByAgentId: vi.fn().mockResolvedValue(context),
      getLatestSourceByDispatchTarget: vi.fn().mockResolvedValue(context),
      getSourceByAgentTurn: vi.fn().mockResolvedValue(context),
    };
    const service = new ChannelMessageReceiptService(provider);

    const result = await service.getLatestSourceByAgentId(" agent-1 ");

    expect(result).toEqual(context);
    expect(provider.getLatestSourceByAgentId).toHaveBeenCalledWith("agent-1");
  });

  it("throws on blank lookup agentId", async () => {
    const provider: ChannelMessageReceiptProvider = {
      recordIngressReceipt: vi.fn(),
      bindTurnToReceipt: vi.fn(),
      getLatestSourceByAgentId: vi.fn(),
      getLatestSourceByDispatchTarget: vi.fn(),
      getSourceByAgentTurn: vi.fn(),
    };
    const service = new ChannelMessageReceiptService(provider);

    await expect(service.getLatestSourceByAgentId("   ")).rejects.toThrow(
      "agentId must be a non-empty string.",
    );
    expect(provider.getLatestSourceByAgentId).not.toHaveBeenCalled();
  });

  it("normalizes and delegates dispatch-target source lookups", async () => {
    const context = createSourceContext();
    const provider: ChannelMessageReceiptProvider = {
      recordIngressReceipt: vi.fn(),
      bindTurnToReceipt: vi.fn(),
      getLatestSourceByAgentId: vi.fn(),
      getLatestSourceByDispatchTarget: vi.fn().mockResolvedValue(context),
      getSourceByAgentTurn: vi.fn().mockResolvedValue(context),
    };
    const service = new ChannelMessageReceiptService(provider);

    const result = await service.getLatestSourceByDispatchTarget({
      agentId: " agent-1 ",
      teamId: " ",
    });

    expect(result).toEqual(context);
    expect(provider.getLatestSourceByDispatchTarget).toHaveBeenCalledWith({
      agentId: "agent-1",
      teamId: null,
    });
  });

  it("rejects dispatch-target lookup with no identifiers", async () => {
    const provider: ChannelMessageReceiptProvider = {
      recordIngressReceipt: vi.fn(),
      bindTurnToReceipt: vi.fn(),
      getLatestSourceByAgentId: vi.fn(),
      getLatestSourceByDispatchTarget: vi.fn(),
      getSourceByAgentTurn: vi.fn(),
    };
    const service = new ChannelMessageReceiptService(provider);

    await expect(
      service.getLatestSourceByDispatchTarget({
        agentId: " ",
        teamId: null,
      }),
    ).rejects.toThrow(
      "Dispatch target lookup requires at least one of agentId or teamId.",
    );
    expect(provider.getLatestSourceByDispatchTarget).not.toHaveBeenCalled();
  });

  it("normalizes and delegates turn binding", async () => {
    const provider: ChannelMessageReceiptProvider = {
      recordIngressReceipt: vi.fn(),
      bindTurnToReceipt: vi.fn().mockResolvedValue(undefined),
      getLatestSourceByAgentId: vi.fn(),
      getLatestSourceByDispatchTarget: vi.fn(),
      getSourceByAgentTurn: vi.fn(),
    };
    const service = new ChannelMessageReceiptService(provider);

    await service.bindTurnToReceipt({
      provider: ExternalChannelProvider.WHATSAPP,
      transport: ExternalChannelTransport.PERSONAL_SESSION,
      accountId: " acct-1 ",
      peerId: " peer-1 ",
      threadId: " ",
      externalMessageId: " msg-1 ",
      turnId: " turn-1 ",
      agentId: " agent-1 ",
      teamId: null,
      receivedAt: new Date("2026-02-09T00:00:00.000Z"),
    });

    expect(provider.bindTurnToReceipt).toHaveBeenCalledWith({
      provider: ExternalChannelProvider.WHATSAPP,
      transport: ExternalChannelTransport.PERSONAL_SESSION,
      accountId: "acct-1",
      peerId: "peer-1",
      threadId: null,
      externalMessageId: "msg-1",
      turnId: "turn-1",
      agentId: "agent-1",
      teamId: null,
      receivedAt: new Date("2026-02-09T00:00:00.000Z"),
    });
  });

  it("delegates source lookup by agent turn", async () => {
    const context = createSourceContext();
    const provider: ChannelMessageReceiptProvider = {
      recordIngressReceipt: vi.fn(),
      bindTurnToReceipt: vi.fn(),
      getLatestSourceByAgentId: vi.fn(),
      getLatestSourceByDispatchTarget: vi.fn(),
      getSourceByAgentTurn: vi.fn().mockResolvedValue(context),
    };
    const service = new ChannelMessageReceiptService(provider);

    const result = await service.getSourceByAgentTurn(" agent-1 ", " turn-1 ");

    expect(result).toEqual(context);
    expect(provider.getSourceByAgentTurn).toHaveBeenCalledWith("agent-1", "turn-1");
  });
});
