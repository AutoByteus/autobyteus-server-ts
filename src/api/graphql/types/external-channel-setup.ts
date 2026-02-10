import {
  Arg,
  Field,
  InputType,
  Mutation,
  ObjectType,
  Query,
  Resolver,
} from "type-graphql";
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
  ChannelBindingTargetOption,
  ChannelBindingTargetType,
} from "../../../external-channel/domain/models.js";
import { SqlChannelBindingProvider } from "../../../external-channel/providers/sql-channel-binding-provider.js";
import { ChannelBindingService } from "../../../external-channel/services/channel-binding-service.js";
import { ChannelBindingConstraintService } from "../../../external-channel/services/channel-binding-constraint-service.js";
import { ChannelBindingTargetOptionsService } from "../../../external-channel/services/channel-binding-target-options-service.js";

let cachedBindingService: ChannelBindingService | null = null;
let cachedTargetOptionsService: ChannelBindingTargetOptionsService | null = null;
let cachedConstraintService: ChannelBindingConstraintService | null = null;

const getBindingService = (): ChannelBindingService => {
  if (!cachedBindingService) {
    cachedBindingService = new ChannelBindingService(new SqlChannelBindingProvider());
  }
  return cachedBindingService;
};

const getTargetOptionsService = (): ChannelBindingTargetOptionsService => {
  if (!cachedTargetOptionsService) {
    cachedTargetOptionsService = new ChannelBindingTargetOptionsService();
  }
  return cachedTargetOptionsService;
};

const getConstraintService = (): ChannelBindingConstraintService => {
  if (!cachedConstraintService) {
    cachedConstraintService = new ChannelBindingConstraintService();
  }
  return cachedConstraintService;
};

@ObjectType()
export class ExternalChannelCapabilities {
  @Field(() => Boolean)
  bindingCrudEnabled!: boolean;

  @Field(() => String, { nullable: true })
  reason?: string | null;

  @Field(() => [String])
  acceptedProviderTransportPairs!: string[];
}

@ObjectType()
export class ExternalChannelBindingGql {
  @Field(() => String)
  id!: string;

  @Field(() => String)
  provider!: string;

  @Field(() => String)
  transport!: string;

  @Field(() => String)
  accountId!: string;

  @Field(() => String)
  peerId!: string;

  @Field(() => String, { nullable: true })
  threadId?: string | null;

  @Field(() => String)
  targetType!: string;

  @Field(() => String)
  targetId!: string;

  @Field(() => Boolean)
  allowTransportFallback!: boolean;

  @Field(() => Date)
  updatedAt!: Date;
}

@ObjectType()
export class ExternalChannelBindingTargetOptionGql {
  @Field(() => String)
  targetType!: string;

  @Field(() => String)
  targetId!: string;

  @Field(() => String)
  displayName!: string;

  @Field(() => String)
  status!: string;
}

@InputType()
export class UpsertExternalChannelBindingInput {
  @Field(() => String, { nullable: true })
  id?: string | null;

  @Field(() => String)
  provider!: string;

  @Field(() => String)
  transport!: string;

  @Field(() => String)
  accountId!: string;

  @Field(() => String)
  peerId!: string;

  @Field(() => String, { nullable: true })
  threadId?: string | null;

  @Field(() => String)
  targetType!: string;

  @Field(() => String)
  targetId!: string;

  @Field(() => Boolean, { defaultValue: false })
  allowTransportFallback = false;
}

@Resolver()
export class ExternalChannelSetupResolver {
  @Query(() => ExternalChannelCapabilities)
  externalChannelCapabilities(): ExternalChannelCapabilities {
    return {
      bindingCrudEnabled: true,
      reason: null,
      acceptedProviderTransportPairs: getConstraintService().getAcceptedProviderTransportPairs(),
    };
  }

  @Query(() => [ExternalChannelBindingGql])
  async externalChannelBindings(): Promise<ExternalChannelBindingGql[]> {
    const bindings = await getBindingService().listBindings();
    return bindings.map((binding) => toGraphqlBinding(binding));
  }

  @Query(() => [ExternalChannelBindingTargetOptionGql])
  async externalChannelBindingTargetOptions(): Promise<
    ExternalChannelBindingTargetOptionGql[]
  > {
    const options = await getTargetOptionsService().listActiveTargetOptions();
    return options.map((option) => toGraphqlTargetOption(option));
  }

  @Mutation(() => ExternalChannelBindingGql)
  async upsertExternalChannelBinding(
    @Arg("input", () => UpsertExternalChannelBindingInput)
    input: UpsertExternalChannelBindingInput,
  ): Promise<ExternalChannelBindingGql> {
    const provider = parseProvider(input.provider);
    const transport = parseTransport(input.transport);
    getConstraintService().validateProviderTransport(provider, transport);

    const targetType = parseTargetType(input.targetType);
    const targetId = normalizeRequiredString(input.targetId, "targetId");

    const isActiveTarget = await getTargetOptionsService().isActiveTarget(
      targetType,
      targetId,
    );
    if (!isActiveTarget) {
      throw new Error(
        `TARGET_NOT_ACTIVE: selected ${targetType.toLowerCase()} target '${targetId}' is not active.`,
      );
    }

    const binding = await getBindingService().upsertBinding({
      provider,
      transport,
      accountId: normalizeRequiredString(input.accountId, "accountId"),
      peerId: normalizeRequiredString(input.peerId, "peerId"),
      threadId: normalizeOptionalString(input.threadId ?? null),
      targetType,
      agentId: targetType === "AGENT" ? targetId : null,
      teamId: targetType === "TEAM" ? targetId : null,
      targetNodeName: null,
      allowTransportFallback: input.allowTransportFallback,
    });

    return toGraphqlBinding(binding);
  }

  @Mutation(() => Boolean)
  async deleteExternalChannelBinding(
    @Arg("id", () => String) id: string,
  ): Promise<boolean> {
    return getBindingService().deleteBinding(id);
  }
}

const toGraphqlBinding = (binding: ChannelBinding): ExternalChannelBindingGql => ({
  id: binding.id,
  provider: binding.provider,
  transport: binding.transport,
  accountId: binding.accountId,
  peerId: binding.peerId,
  threadId: binding.threadId,
  targetType: binding.targetType,
  targetId: getTargetId(binding),
  allowTransportFallback: binding.allowTransportFallback,
  updatedAt: binding.updatedAt,
});

const toGraphqlTargetOption = (
  option: ChannelBindingTargetOption,
): ExternalChannelBindingTargetOptionGql => ({
  targetType: option.targetType,
  targetId: option.targetId,
  displayName: option.displayName,
  status: option.status,
});

const getTargetId = (binding: ChannelBinding): string => {
  if (binding.targetType === "AGENT") {
    if (!binding.agentId) {
      throw new Error(`Binding ${binding.id} has targetType AGENT but agentId is null.`);
    }
    return binding.agentId;
  }

  if (!binding.teamId) {
    throw new Error(`Binding ${binding.id} has targetType TEAM but teamId is null.`);
  }
  return binding.teamId;
};

const parseTargetType = (value: string): ChannelBindingTargetType => {
  const normalized = normalizeRequiredString(value, "targetType").toUpperCase();
  if (normalized === "AGENT" || normalized === "TEAM") {
    return normalized;
  }
  throw new Error(`Unsupported targetType: ${value}`);
};

const parseProvider = (value: string): ExternalChannelProvider =>
  parseExternalChannelProvider(normalizeRequiredString(value, "provider"));

const parseTransport = (value: string): ExternalChannelTransport =>
  parseExternalChannelTransport(normalizeRequiredString(value, "transport"));

const normalizeRequiredString = (value: string, field: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return normalized;
};

const normalizeOptionalString = (value: string | null): string | null => {
  if (value === null) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
};
