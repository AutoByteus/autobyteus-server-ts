import "reflect-metadata";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { graphql as graphqlFn, GraphQLSchema } from "graphql";
import { buildGraphqlSchema } from "../../../src/api/graphql/schema.js";
import { AgentInstanceManager } from "../../../src/agent-execution/services/agent-instance-manager.js";
import { AgentTeamInstanceManager } from "../../../src/agent-team-execution/services/agent-team-instance-manager.js";

const unique = (prefix: string): string => `${prefix}-${randomUUID()}`;

describe("External channel setup GraphQL e2e", () => {
  let schema: GraphQLSchema;
  let graphql: typeof graphqlFn;

  const activeAgentId = unique("active-agent");

  beforeAll(async () => {
    schema = await buildGraphqlSchema();
    const require = createRequire(import.meta.url);
    const typeGraphqlRoot = path.dirname(require.resolve("type-graphql"));
    const graphqlPath = require.resolve("graphql", { paths: [typeGraphqlRoot] });
    const graphqlModule = await import(graphqlPath);
    graphql = graphqlModule.graphql as typeof graphqlFn;

    const agentManager = AgentInstanceManager.getInstance();
    vi.spyOn(agentManager, "listActiveInstances").mockReturnValue([activeAgentId]);
    vi.spyOn(agentManager, "getAgentInstance").mockImplementation((id: string) => {
      if (id !== activeAgentId) {
        return null;
      }
      return {
        agentId: activeAgentId,
        context: {
          config: {
            name: "Setup Agent",
          },
        },
        currentStatus: "IDLE",
      } as any;
    });

    const teamManager = AgentTeamInstanceManager.getInstance();
    vi.spyOn(teamManager, "listActiveInstances").mockReturnValue([]);
    vi.spyOn(teamManager, "getTeamInstance").mockReturnValue(null);
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  const execGraphql = async <T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> => {
    const result = await graphql({
      schema,
      source: query,
      variableValues: variables,
    });
    if (result.errors?.length) {
      throw result.errors[0];
    }
    return result.data as T;
  };

  it("exposes setup capability query", async () => {
    const query = `
      query Capabilities {
        externalChannelCapabilities {
          bindingCrudEnabled
          reason
          acceptedProviderTransportPairs
        }
      }
    `;

    const data = await execGraphql<{
      externalChannelCapabilities: {
        bindingCrudEnabled: boolean;
        reason: string | null;
        acceptedProviderTransportPairs: string[];
      };
    }>(query);

    expect(data.externalChannelCapabilities.bindingCrudEnabled).toBe(true);
    expect(data.externalChannelCapabilities.reason).toBeNull();
    expect(data.externalChannelCapabilities.acceptedProviderTransportPairs).toEqual([
      "WHATSAPP:BUSINESS_API",
      "WHATSAPP:PERSONAL_SESSION",
      "WECOM:BUSINESS_API",
      "WECHAT:PERSONAL_SESSION",
    ]);
  });

  it("returns active binding target options", async () => {
    const query = `
      query TargetOptions {
        externalChannelBindingTargetOptions {
          targetType
          targetId
          displayName
          status
        }
      }
    `;

    const data = await execGraphql<{
      externalChannelBindingTargetOptions: Array<{
        targetType: string;
        targetId: string;
        displayName: string;
        status: string;
      }>;
    }>(query);

    expect(data.externalChannelBindingTargetOptions).toEqual([
      {
        targetType: "AGENT",
        targetId: activeAgentId,
        displayName: "Setup Agent",
        status: "IDLE",
      },
    ]);
  });

  it("supports upsert/list/delete binding setup lifecycle", async () => {
    const accountId = unique("acct");
    const peerId = unique("peer");

    const upsertMutation = `
      mutation Upsert($input: UpsertExternalChannelBindingInput!) {
        upsertExternalChannelBinding(input: $input) {
          id
          provider
          transport
          accountId
          peerId
          threadId
          targetType
          targetId
          allowTransportFallback
        }
      }
    `;

    const upsertData = await execGraphql<{
      upsertExternalChannelBinding: {
        id: string;
        accountId: string;
        peerId: string;
        targetType: string;
        targetId: string;
      };
    }>(upsertMutation, {
      input: {
        provider: "WHATSAPP",
        transport: "PERSONAL_SESSION",
        accountId,
        peerId,
        threadId: null,
        targetType: "AGENT",
        targetId: activeAgentId,
        allowTransportFallback: false,
      },
    });

    expect(upsertData.upsertExternalChannelBinding.accountId).toBe(accountId);
    expect(upsertData.upsertExternalChannelBinding.peerId).toBe(peerId);
    expect(upsertData.upsertExternalChannelBinding.targetType).toBe("AGENT");
    expect(upsertData.upsertExternalChannelBinding.targetId).toBe(activeAgentId);

    const bindingId = upsertData.upsertExternalChannelBinding.id;

    const listQuery = `
      query ListBindings {
        externalChannelBindings {
          id
          accountId
          peerId
          targetType
          targetId
        }
      }
    `;

    const listed = await execGraphql<{
      externalChannelBindings: Array<{
        id: string;
        accountId: string;
        peerId: string;
        targetType: string;
        targetId: string;
      }>;
    }>(listQuery);

    const created = listed.externalChannelBindings.find((binding) => binding.id === bindingId);
    expect(created).toBeTruthy();
    expect(created?.accountId).toBe(accountId);
    expect(created?.peerId).toBe(peerId);
    expect(created?.targetType).toBe("AGENT");
    expect(created?.targetId).toBe(activeAgentId);

    const deleteMutation = `
      mutation DeleteBinding($id: String!) {
        deleteExternalChannelBinding(id: $id)
      }
    `;

    const deleted = await execGraphql<{ deleteExternalChannelBinding: boolean }>(
      deleteMutation,
      { id: bindingId },
    );

    expect(deleted.deleteExternalChannelBinding).toBe(true);

    const listedAfterDelete = await execGraphql<{
      externalChannelBindings: Array<{ id: string }>;
    }>(listQuery);

    expect(
      listedAfterDelete.externalChannelBindings.some((binding) => binding.id === bindingId),
    ).toBe(false);
  });

  it("rejects stale target ids during upsert", async () => {
    const upsertMutation = `
      mutation Upsert($input: UpsertExternalChannelBindingInput!) {
        upsertExternalChannelBinding(input: $input) {
          id
        }
      }
    `;

    await expect(
      execGraphql(upsertMutation, {
        input: {
          provider: "WHATSAPP",
          transport: "PERSONAL_SESSION",
          accountId: "acct-stale",
          peerId: "peer-stale",
          threadId: null,
          targetType: "AGENT",
          targetId: "non-existent-agent",
          allowTransportFallback: false,
        },
      }),
    ).rejects.toThrow("TARGET_NOT_ACTIVE");
  });

  it("rejects unsupported provider/transport combinations during upsert", async () => {
    const upsertMutation = `
      mutation Upsert($input: UpsertExternalChannelBindingInput!) {
        upsertExternalChannelBinding(input: $input) {
          id
        }
      }
    `;

    await expect(
      execGraphql(upsertMutation, {
        input: {
          provider: "WECHAT",
          transport: "BUSINESS_API",
          accountId: "acct-wechat",
          peerId: "peer-wechat",
          threadId: null,
          targetType: "AGENT",
          targetId: activeAgentId,
          allowTransportFallback: false,
        },
      }),
    ).rejects.toThrow("UNSUPPORTED_PROVIDER_TRANSPORT_COMBINATION");
  });

  it("accepts supported WECHAT + PERSONAL_SESSION binding combinations", async () => {
    const upsertMutation = `
      mutation Upsert($input: UpsertExternalChannelBindingInput!) {
        upsertExternalChannelBinding(input: $input) {
          provider
          transport
          targetType
          targetId
        }
      }
    `;

    const result = await execGraphql<{
      upsertExternalChannelBinding: {
        provider: string;
        transport: string;
        targetType: string;
        targetId: string;
      };
    }>(upsertMutation, {
      input: {
        provider: "WECHAT",
        transport: "PERSONAL_SESSION",
        accountId: "wechat-acct",
        peerId: "wechat-peer",
        threadId: null,
        targetType: "AGENT",
        targetId: activeAgentId,
        allowTransportFallback: false,
      },
    });

    expect(result.upsertExternalChannelBinding).toMatchObject({
      provider: "WECHAT",
      transport: "PERSONAL_SESSION",
      targetType: "AGENT",
      targetId: activeAgentId,
    });
  });
});
