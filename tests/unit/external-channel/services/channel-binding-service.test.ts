import { describe, expect, it, vi } from "vitest";
import { ExternalChannelProvider } from "autobyteus-ts/external-channel/provider.js";
import { ExternalChannelTransport } from "autobyteus-ts/external-channel/channel-transport.js";
import { ChannelBindingService } from "../../../../src/external-channel/services/channel-binding-service.js";
import type { ChannelBinding } from "../../../../src/external-channel/domain/models.js";
import type { ChannelBindingProvider } from "../../../../src/external-channel/providers/channel-binding-provider.js";

const createBinding = (transport: ExternalChannelTransport): ChannelBinding => ({
  id: `binding-${transport}`,
  provider: ExternalChannelProvider.WHATSAPP,
  transport,
  accountId: "acct-1",
  peerId: "peer-1",
  threadId: null,
  targetType: "AGENT",
  agentId: "agent-1",
  teamId: null,
  targetMemberName: null,
  createdAt: new Date("2026-02-08T00:00:00.000Z"),
  updatedAt: new Date("2026-02-08T00:00:00.000Z"),
});

const createProvider = (
  overrides: Partial<ChannelBindingProvider> = {},
): ChannelBindingProvider => ({
  findBinding: vi.fn(),
  isRouteBoundToTarget: vi.fn(),
  listBindings: vi.fn(),
  upsertBinding: vi.fn(),
  deleteBinding: vi.fn(),
  ...overrides,
});

describe("ChannelBindingService", () => {
  it("resolves exact transport binding without fallback behavior", async () => {
    const provider = createProvider({
      findBinding: vi
        .fn()
        .mockResolvedValue(createBinding(ExternalChannelTransport.BUSINESS_API)),
    });
    const service = new ChannelBindingService(provider);

    const result = await service.resolveBinding({
      provider: ExternalChannelProvider.WHATSAPP,
      transport: ExternalChannelTransport.BUSINESS_API,
      accountId: "acct-1",
      peerId: "peer-1",
      threadId: null,
    });

    expect(result?.id).toBe(`binding-${ExternalChannelTransport.BUSINESS_API}`);
    expect(provider.findBinding).toHaveBeenCalledTimes(1);
  });

  it("delegates upsert/list/delete methods to provider", async () => {
    const binding = createBinding(ExternalChannelTransport.BUSINESS_API);
    const provider = createProvider({
      upsertBinding: vi.fn().mockResolvedValue(binding),
      listBindings: vi.fn().mockResolvedValue([binding]),
      deleteBinding: vi.fn().mockResolvedValue(true),
    });
    const service = new ChannelBindingService(provider);

    const upserted = await service.upsertBinding({
      provider: ExternalChannelProvider.WHATSAPP,
      transport: ExternalChannelTransport.BUSINESS_API,
      accountId: "acct-1",
      peerId: "peer-1",
      threadId: null,
      targetType: "AGENT",
      agentId: "agent-1",
    });
    const listed = await service.listBindings();
    const deleted = await service.deleteBinding(binding.id);

    expect(upserted.id).toBe(binding.id);
    expect(listed).toEqual([binding]);
    expect(deleted).toBe(true);
    expect(provider.upsertBinding).toHaveBeenCalledTimes(1);
    expect(provider.listBindings).toHaveBeenCalledTimes(1);
    expect(provider.deleteBinding).toHaveBeenCalledWith(binding.id);
  });

  it("delegates route-target active binding checks", async () => {
    const provider = createProvider({
      isRouteBoundToTarget: vi.fn().mockResolvedValue(true),
    });
    const service = new ChannelBindingService(provider);

    const result = await service.isRouteBoundToTarget(
      {
        provider: ExternalChannelProvider.WHATSAPP,
        transport: ExternalChannelTransport.PERSONAL_SESSION,
        accountId: " acct-1 ",
        peerId: " peer-1 ",
        threadId: " ",
      },
      {
        agentId: " agent-1 ",
        teamId: null,
      },
    );

    expect(result).toBe(true);
    expect(provider.isRouteBoundToTarget).toHaveBeenCalledWith(
      {
        provider: ExternalChannelProvider.WHATSAPP,
        transport: ExternalChannelTransport.PERSONAL_SESSION,
        accountId: "acct-1",
        peerId: "peer-1",
        threadId: null,
      },
      {
        agentId: "agent-1",
        teamId: null,
      },
    );
  });

  it("rejects route-target checks with empty target identity", async () => {
    const provider = createProvider();
    const service = new ChannelBindingService(provider);

    await expect(
      service.isRouteBoundToTarget(
        {
          provider: ExternalChannelProvider.WHATSAPP,
          transport: ExternalChannelTransport.BUSINESS_API,
          accountId: "acct-1",
          peerId: "peer-1",
          threadId: null,
        },
        {
          agentId: " ",
          teamId: null,
        },
      ),
    ).rejects.toThrow(
      "Route-target verification requires at least one of agentId or teamId.",
    );
    expect(provider.isRouteBoundToTarget).not.toHaveBeenCalled();
  });
});
