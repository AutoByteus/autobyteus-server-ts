import type {
  ChannelBinding,
  ChannelDispatchTarget,
  ChannelBindingLookup,
  ChannelBindingProviderDefaultLookup,
  ChannelSourceRoute,
  UpsertChannelBindingInput,
} from "../domain/models.js";

export interface ChannelBindingProvider {
  findBinding(input: ChannelBindingLookup): Promise<ChannelBinding | null>;
  findProviderDefaultBinding(input: ChannelBindingProviderDefaultLookup): Promise<ChannelBinding | null>;
  findBindingByDispatchTarget(
    target: ChannelDispatchTarget,
  ): Promise<ChannelBinding | null>;
  isRouteBoundToTarget(
    route: ChannelSourceRoute,
    target: ChannelDispatchTarget,
  ): Promise<boolean>;
  listBindings(): Promise<ChannelBinding[]>;
  upsertBinding(input: UpsertChannelBindingInput): Promise<ChannelBinding>;
  upsertBindingAgentId(bindingId: string, agentId: string): Promise<ChannelBinding>;
  deleteBinding(bindingId: string): Promise<boolean>;
}
