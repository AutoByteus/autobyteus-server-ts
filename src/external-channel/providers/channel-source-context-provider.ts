import type {
  ChannelDispatchTarget,
  ChannelSourceContext,
} from "../domain/models.js";

export interface ChannelSourceContextProvider {
  getLatestSourceByAgentId(agentId: string): Promise<ChannelSourceContext | null>;
  getLatestSourceByDispatchTarget(
    target: ChannelDispatchTarget,
  ): Promise<ChannelSourceContext | null>;
  getSourceByAgentTurn(
    agentId: string,
    turnId: string,
  ): Promise<ChannelSourceContext | null>;
}
