import { Prisma } from "@prisma/client";
import { BaseRepository } from "repository_prisma";
import {
  parseExternalChannelProvider,
  type ExternalChannelProvider,
} from "autobyteus-ts/external-channel/provider.js";
import {
  parseExternalChannelTransport,
  type ExternalChannelTransport,
} from "autobyteus-ts/external-channel/channel-transport.js";
import type {
  ChannelBinding,
  ChannelBindingLookup,
  ChannelBindingProviderDefaultLookup,
  ChannelDispatchTarget,
  ChannelSourceRoute,
  UpsertChannelBindingInput,
} from "../domain/models.js";
import type { ChannelBindingProvider } from "./channel-binding-provider.js";

class SqlChannelBindingRepository extends BaseRepository.forModel(
  Prisma.ModelName.ChannelBinding,
) {}

export class SqlChannelBindingProvider implements ChannelBindingProvider {
  private readonly repository = new SqlChannelBindingRepository();

  async findBinding(input: ChannelBindingLookup): Promise<ChannelBinding | null> {
    const found = await this.repository.findUnique({
      where: {
        provider_transport_accountId_peerId_threadId: {
          provider: input.provider,
          transport: input.transport,
          accountId: input.accountId,
          peerId: input.peerId,
          threadId: toThreadStorage(input.threadId),
        },
      },
    });

    return found ? toDomain(found) : null;
  }

  async findProviderDefaultBinding(
    input: ChannelBindingProviderDefaultLookup,
  ): Promise<ChannelBinding | null> {
    const found = await this.repository.findFirst({
      where: {
        provider: input.provider,
        accountId: input.accountId,
        peerId: input.peerId,
        threadId: toThreadStorage(input.threadId),
        allowTransportFallback: true,
      },
      orderBy: {
        updatedAt: "desc",
      },
    });

    return found ? toDomain(found) : null;
  }

  async findBindingByDispatchTarget(
    target: ChannelDispatchTarget,
  ): Promise<ChannelBinding | null> {
    const agentId = normalizeNullableString(target.agentId);
    const teamId = normalizeNullableString(target.teamId);

    if (agentId) {
      const agentBinding = await this.repository.findFirst({
        where: {
          targetType: "AGENT",
          agentId,
        },
        orderBy: {
          updatedAt: "desc",
        },
      });
      if (agentBinding) {
        return toDomain(agentBinding);
      }
    }

    if (!teamId) {
      return null;
    }

    const teamBinding = await this.repository.findFirst({
      where: {
        targetType: "TEAM",
        teamId,
      },
      orderBy: {
        updatedAt: "desc",
      },
    });
    return teamBinding ? toDomain(teamBinding) : null;
  }

  async isRouteBoundToTarget(
    route: ChannelSourceRoute,
    target: ChannelDispatchTarget,
  ): Promise<boolean> {
    const agentId = normalizeNullableString(target.agentId);
    const teamId = normalizeNullableString(target.teamId);
    const or: Array<Record<string, unknown>> = [];
    if (agentId) {
      or.push({
        targetType: "AGENT",
        agentId,
      });
    }
    if (teamId) {
      or.push({
        targetType: "TEAM",
        teamId,
      });
    }
    if (or.length === 0) {
      return false;
    }

    const found = await this.repository.findFirst({
      where: {
        provider: route.provider,
        transport: route.transport,
        accountId: route.accountId,
        peerId: route.peerId,
        threadId: toThreadStorage(route.threadId),
        OR: or as any,
      },
    });
    return found !== null;
  }

  async listBindings(): Promise<ChannelBinding[]> {
    const bindings = await this.repository.findMany({
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
    });
    return bindings.map((binding) => toDomain(binding));
  }

  async upsertBinding(input: UpsertChannelBindingInput): Promise<ChannelBinding> {
    const createdOrUpdated = await this.repository.upsert({
      where: {
        provider_transport_accountId_peerId_threadId: {
          provider: input.provider,
          transport: input.transport,
          accountId: input.accountId,
          peerId: input.peerId,
          threadId: toThreadStorage(input.threadId),
        },
      },
      create: {
        provider: input.provider,
        transport: input.transport,
        accountId: input.accountId,
        peerId: input.peerId,
        threadId: toThreadStorage(input.threadId),
        targetType: input.targetType,
        agentId: normalizeNullableString(input.agentId ?? null) ?? undefined,
        teamId: normalizeNullableString(input.teamId ?? null) ?? undefined,
        targetNodeName:
          normalizeNullableString(input.targetNodeName ?? null) ?? undefined,
        allowTransportFallback: input.allowTransportFallback ?? false,
      },
      update: {
        targetType: input.targetType,
        agentId: normalizeNullableString(input.agentId ?? null),
        teamId: normalizeNullableString(input.teamId ?? null),
        targetNodeName: normalizeNullableString(input.targetNodeName ?? null),
        allowTransportFallback: input.allowTransportFallback ?? false,
      },
    });

    return toDomain(createdOrUpdated);
  }

  async upsertBindingAgentId(
    bindingId: string,
    agentId: string,
  ): Promise<ChannelBinding> {
    const normalizedId = parseBindingId(bindingId);
    const normalizedAgentId = normalizeRequiredString(agentId, "agentId");
    const updated = await this.repository.update({
      where: {
        id: normalizedId,
      },
      data: {
        agentId: normalizedAgentId,
        targetType: "AGENT",
      },
    });
    return toDomain(updated);
  }

  async deleteBinding(bindingId: string): Promise<boolean> {
    const normalizedId = parseBindingId(bindingId);
    const existing = await this.repository.findUnique({
      where: {
        id: normalizedId,
      },
    });
    if (!existing) {
      return false;
    }

    await this.repository.delete({
      where: {
        id: normalizedId,
      },
    });
    return true;
  }
}

const toThreadStorage = (threadId: string | null): string =>
  normalizeNullableString(threadId) ?? "";

const fromThreadStorage = (threadId: string): string | null => {
  const normalized = threadId.trim();
  return normalized.length > 0 ? normalized : null;
};

const parseBindingId = (value: string): number => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error("bindingId must be a non-empty string.");
  }
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`bindingId must be a positive integer string. Received: ${value}`);
  }
  return parsed;
};

const normalizeRequiredString = (value: string, field: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return normalized;
};

const normalizeNullableString = (value: string | null): string | null => {
  if (value === null) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};

const toDomain = (value: {
  id: number;
  provider: string;
  transport: string;
  accountId: string;
  peerId: string;
  threadId: string;
  targetType: string;
  agentId: string | null;
  teamId: string | null;
  targetNodeName: string | null;
  allowTransportFallback: boolean;
  createdAt: Date;
  updatedAt: Date;
}): ChannelBinding => ({
  id: value.id.toString(),
  provider: parseProvider(value.provider),
  transport: parseTransport(value.transport),
  accountId: value.accountId,
  peerId: value.peerId,
  threadId: fromThreadStorage(value.threadId),
  targetType: parseTargetType(value.targetType),
  agentId: value.agentId,
  teamId: value.teamId,
  targetNodeName: value.targetNodeName,
  allowTransportFallback: value.allowTransportFallback,
  createdAt: value.createdAt,
  updatedAt: value.updatedAt,
});

const parseProvider = (value: string): ExternalChannelProvider =>
  parseExternalChannelProvider(value);

const parseTransport = (value: string): ExternalChannelTransport =>
  parseExternalChannelTransport(value);

const parseTargetType = (value: string): "AGENT" | "TEAM" => {
  if (value === "AGENT" || value === "TEAM") {
    return value;
  }
  throw new Error(`Unsupported channel target type stored in DB: ${value}`);
};
