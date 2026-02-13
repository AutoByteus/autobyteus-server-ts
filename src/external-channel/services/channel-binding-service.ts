import type {
  ChannelBinding,
  ChannelDispatchTarget,
  ChannelBindingLookup,
  ChannelSourceRoute,
  UpsertChannelBindingInput,
} from "../domain/models.js";
import type { ChannelBindingProvider } from "../providers/channel-binding-provider.js";

export class ChannelBindingService {
  constructor(
    private readonly provider: ChannelBindingProvider,
  ) {}

  async resolveBinding(
    lookup: ChannelBindingLookup,
  ): Promise<ChannelBinding | null> {
    return this.provider.findBinding(lookup);
  }

  async upsertBinding(input: UpsertChannelBindingInput): Promise<ChannelBinding> {
    return this.provider.upsertBinding(input);
  }

  async listBindings(): Promise<ChannelBinding[]> {
    return this.provider.listBindings();
  }

  async deleteBinding(bindingId: string): Promise<boolean> {
    return this.provider.deleteBinding(bindingId);
  }

  async isRouteBoundToTarget(
    route: ChannelSourceRoute,
    target: ChannelDispatchTarget,
  ): Promise<boolean> {
    const normalizedRoute: ChannelSourceRoute = {
      provider: route.provider,
      transport: route.transport,
      accountId: normalizeRequiredString(route.accountId, "accountId"),
      peerId: normalizeRequiredString(route.peerId, "peerId"),
      threadId: normalizeNullableString(route.threadId),
    };
    const normalizedTarget: ChannelDispatchTarget = {
      agentId: normalizeNullableString(target.agentId),
      teamId: normalizeNullableString(target.teamId),
    };
    if (!normalizedTarget.agentId && !normalizedTarget.teamId) {
      throw new Error(
        "Route-target verification requires at least one of agentId or teamId.",
      );
    }
    return this.provider.isRouteBoundToTarget(normalizedRoute, normalizedTarget);
  }
}

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
