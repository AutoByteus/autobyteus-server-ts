import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ExternalChannelProvider } from "autobyteus-ts/external-channel/provider.js";
import { ExternalChannelTransport } from "autobyteus-ts/external-channel/channel-transport.js";
import { SqlChannelBindingProvider } from "../../../../src/external-channel/providers/sql-channel-binding-provider.js";

const unique = (prefix: string): string => `${prefix}-${randomUUID()}`;

describe("SqlChannelBindingProvider", () => {
  it("upserts and resolves Discord channel-thread bindings", async () => {
    const provider = new SqlChannelBindingProvider();
    const accountId = "discord-app-123456";
    const peerId = "channel:111222333444555";
    const threadId = "999888777666555";

    const binding = await provider.upsertBinding({
      provider: ExternalChannelProvider.DISCORD,
      transport: ExternalChannelTransport.BUSINESS_API,
      accountId,
      peerId,
      threadId,
      targetType: "AGENT",
      agentId: "discord-agent-1",
    });

    const resolved = await provider.findBinding({
      provider: ExternalChannelProvider.DISCORD,
      transport: ExternalChannelTransport.BUSINESS_API,
      accountId,
      peerId,
      threadId,
    });

    expect(binding.id).toBeTruthy();
    expect(resolved?.id).toBe(binding.id);
    expect(resolved?.threadId).toBe(threadId);
    expect(resolved?.agentId).toBe("discord-agent-1");
  });

  it("supports bound-target checks for agent and team targets", async () => {
    const provider = new SqlChannelBindingProvider();
    const accountId = unique("acct");
    const peerId = unique("peer");

    await provider.upsertBinding({
      provider: ExternalChannelProvider.DISCORD,
      transport: ExternalChannelTransport.BUSINESS_API,
      accountId,
      peerId,
      threadId: null,
      targetType: "TEAM",
      teamId: "team-1",
      targetMemberName: "coordinator",
    });

    const boundToTeam = await provider.isRouteBoundToTarget(
      {
        provider: ExternalChannelProvider.DISCORD,
        transport: ExternalChannelTransport.BUSINESS_API,
        accountId,
        peerId,
        threadId: null,
      },
      {
        agentId: null,
        teamId: "team-1",
      },
    );

    const boundToDifferentTeam = await provider.isRouteBoundToTarget(
      {
        provider: ExternalChannelProvider.DISCORD,
        transport: ExternalChannelTransport.BUSINESS_API,
        accountId,
        peerId,
        threadId: null,
      },
      {
        agentId: null,
        teamId: "team-2",
      },
    );

    expect(boundToTeam).toBe(true);
    expect(boundToDifferentTeam).toBe(false);
  });

  it("upserts and resolves exact route binding", async () => {
    const provider = new SqlChannelBindingProvider();
    const accountId = unique("acct");
    const peerId = unique("peer");

    const binding = await provider.upsertBinding({
      provider: ExternalChannelProvider.WHATSAPP,
      transport: ExternalChannelTransport.BUSINESS_API,
      accountId,
      peerId,
      threadId: null,
      targetType: "AGENT",
      agentId: "agent-1",
    });

    const resolved = await provider.findBinding({
      provider: ExternalChannelProvider.WHATSAPP,
      transport: ExternalChannelTransport.BUSINESS_API,
      accountId,
      peerId,
      threadId: null,
    });

    expect(binding.id).toBeTruthy();
    expect(resolved?.id).toBe(binding.id);
    expect(resolved?.agentId).toBe("agent-1");
  });

  it("updates existing route record on repeated upsert", async () => {
    const provider = new SqlChannelBindingProvider();
    const accountId = unique("acct");
    const peerId = unique("peer");

    const first = await provider.upsertBinding({
      provider: ExternalChannelProvider.WHATSAPP,
      transport: ExternalChannelTransport.BUSINESS_API,
      accountId,
      peerId,
      threadId: "thread-1",
      targetType: "AGENT",
      agentId: "agent-1",
    });
    const second = await provider.upsertBinding({
      provider: ExternalChannelProvider.WHATSAPP,
      transport: ExternalChannelTransport.BUSINESS_API,
      accountId,
      peerId,
      threadId: "thread-1",
      targetType: "AGENT",
      agentId: "agent-2",
    });

    expect(second.id).toBe(first.id);
    expect(second.agentId).toBe("agent-2");
  });

  it("lists bindings in descending updatedAt order", async () => {
    const provider = new SqlChannelBindingProvider();
    const accountId = unique("acct");
    const peerId = unique("peer");

    const first = await provider.upsertBinding({
      provider: ExternalChannelProvider.WHATSAPP,
      transport: ExternalChannelTransport.BUSINESS_API,
      accountId,
      peerId,
      threadId: null,
      targetType: "AGENT",
      agentId: "agent-1",
    });

    const second = await provider.upsertBinding({
      provider: ExternalChannelProvider.WHATSAPP,
      transport: ExternalChannelTransport.PERSONAL_SESSION,
      accountId,
      peerId,
      threadId: null,
      targetType: "AGENT",
      agentId: "agent-2",
    });

    const listed = await provider.listBindings();
    const ids = listed.map((item) => item.id);

    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
  });

  it("deletes bindings by id and reports false for missing ids", async () => {
    const provider = new SqlChannelBindingProvider();
    const accountId = unique("acct");
    const peerId = unique("peer");

    const binding = await provider.upsertBinding({
      provider: ExternalChannelProvider.WHATSAPP,
      transport: ExternalChannelTransport.BUSINESS_API,
      accountId,
      peerId,
      threadId: null,
      targetType: "AGENT",
      agentId: "agent-delete",
    });

    const deleted = await provider.deleteBinding(binding.id);
    const deletedAgain = await provider.deleteBinding(binding.id);
    const found = await provider.findBinding({
      provider: ExternalChannelProvider.WHATSAPP,
      transport: ExternalChannelTransport.BUSINESS_API,
      accountId,
      peerId,
      threadId: null,
    });

    expect(deleted).toBe(true);
    expect(deletedAgain).toBe(false);
    expect(found).toBeNull();
  });
});
