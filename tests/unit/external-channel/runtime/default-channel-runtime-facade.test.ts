import { describe, expect, it, vi } from "vitest";
import { ExternalChannelProvider } from "autobyteus-ts/external-channel/provider.js";
import { ExternalChannelTransport } from "autobyteus-ts/external-channel/channel-transport.js";
import { ExternalPeerType } from "autobyteus-ts/external-channel/peer-type.js";
import { createChannelRoutingKey } from "autobyteus-ts/external-channel/channel-routing-key.js";
import type { ChannelBinding } from "../../../../src/external-channel/domain/models.js";
import { DefaultChannelRuntimeFacade } from "../../../../src/external-channel/runtime/default-channel-runtime-facade.js";

const createEnvelope = () => ({
  provider: ExternalChannelProvider.WHATSAPP,
  transport: ExternalChannelTransport.BUSINESS_API,
  accountId: "acct-1",
  peerId: "peer-1",
  peerType: ExternalPeerType.USER,
  threadId: "thread-1",
  externalMessageId: "msg-1",
  content: "hello",
  attachments: [],
  receivedAt: "2026-02-08T00:00:00.000Z",
  metadata: { source: "test" },
  routingKey: createChannelRoutingKey({
    provider: ExternalChannelProvider.WHATSAPP,
    transport: ExternalChannelTransport.BUSINESS_API,
    accountId: "acct-1",
    peerId: "peer-1",
    threadId: "thread-1",
  }),
});

const createAgentBinding = (): ChannelBinding => ({
  id: "binding-1",
  provider: ExternalChannelProvider.WHATSAPP,
  transport: ExternalChannelTransport.BUSINESS_API,
  accountId: "acct-1",
  peerId: "peer-1",
  threadId: "thread-1",
  targetType: "AGENT",
  agentId: "agent-1",
  teamId: null,
  targetNodeName: null,
  allowTransportFallback: false,
  createdAt: new Date("2026-02-08T00:00:00.000Z"),
  updatedAt: new Date("2026-02-08T00:00:00.000Z"),
});

const createTeamBinding = (): ChannelBinding => ({
  ...createAgentBinding(),
  targetType: "TEAM",
  agentId: null,
  teamId: "team-1",
  targetNodeName: "support-node",
});

describe("DefaultChannelRuntimeFacade", () => {
  it("dispatches to agent instance with external source metadata", async () => {
    const postUserMessage = vi.fn().mockResolvedValue(undefined);
    const facade = new DefaultChannelRuntimeFacade({
      agentInstanceManager: {
        getAgentInstance: vi.fn().mockReturnValue({
          postUserMessage,
        }),
      },
      agentTeamInstanceManager: {
        getTeamInstance: vi.fn(),
      },
    });

    const result = await facade.dispatchToBinding(createAgentBinding(), createEnvelope());

    expect(result.agentId).toBe("agent-1");
    expect(result.teamId).toBeNull();
    expect(result.dispatchedAt).toBeInstanceOf(Date);
    expect(postUserMessage).toHaveBeenCalledOnce();
    const sentMessage = postUserMessage.mock.calls[0][0];
    expect(sentMessage.content).toBe("hello");
    expect(sentMessage.metadata.externalSource).toMatchObject({
      source: "external-channel",
      provider: ExternalChannelProvider.WHATSAPP,
      transport: ExternalChannelTransport.BUSINESS_API,
      externalMessageId: "msg-1",
    });
  });

  it("dispatches to team instance and passes target node", async () => {
    const postMessage = vi.fn().mockResolvedValue(undefined);
    const facade = new DefaultChannelRuntimeFacade({
      agentInstanceManager: {
        getAgentInstance: vi.fn(),
      },
      agentTeamInstanceManager: {
        getTeamInstance: vi.fn().mockReturnValue({
          postMessage,
        }),
      },
    });

    const result = await facade.dispatchToBinding(createTeamBinding(), createEnvelope());

    expect(result.agentId).toBeNull();
    expect(result.teamId).toBe("team-1");
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "hello",
      }),
      "support-node",
    );
  });

  it("throws when agent binding has no agentId", async () => {
    const binding = createAgentBinding();
    binding.agentId = null;
    const facade = new DefaultChannelRuntimeFacade({
      agentInstanceManager: {
        getAgentInstance: vi.fn(),
      },
      agentTeamInstanceManager: {
        getTeamInstance: vi.fn(),
      },
    });

    await expect(
      facade.dispatchToBinding(binding, createEnvelope()),
    ).rejects.toThrow("binding.agentId must be a non-empty string.");
  });

  it("throws when team instance cannot be found", async () => {
    const facade = new DefaultChannelRuntimeFacade({
      agentInstanceManager: {
        getAgentInstance: vi.fn(),
      },
      agentTeamInstanceManager: {
        getTeamInstance: vi.fn().mockReturnValue(null),
      },
    });

    await expect(
      facade.dispatchToBinding(createTeamBinding(), createEnvelope()),
    ).rejects.toThrow("Team instance 'team-1' not found for channel dispatch.");
  });
});
