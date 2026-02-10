import { AgentInputUserMessage } from "autobyteus-ts";
import { buildAgentExternalSourceMetadata } from "autobyteus-ts/agent/message/external-source-metadata.js";
import type { ExternalMessageEnvelope } from "autobyteus-ts/external-channel/external-message-envelope.js";
import type { ChannelBinding } from "../domain/models.js";
import type { ChannelRuntimeDispatchResult, ChannelRuntimeFacade } from "./channel-runtime-facade.js";

type AgentLike = {
  postUserMessage: (message: AgentInputUserMessage) => Promise<void>;
};

type TeamLike = {
  postMessage: (
    message: AgentInputUserMessage,
    targetNodeName?: string | null,
  ) => Promise<void>;
};

export type AgentInstanceManagerPort = {
  getAgentInstance(agentId: string): AgentLike | null;
};

export type AgentTeamInstanceManagerPort = {
  getTeamInstance(teamId: string): TeamLike | null;
};

export type DefaultChannelRuntimeFacadeDependencies = {
  agentInstanceManager: AgentInstanceManagerPort;
  agentTeamInstanceManager: AgentTeamInstanceManagerPort;
};

export class DefaultChannelRuntimeFacade implements ChannelRuntimeFacade {
  constructor(
    private readonly deps: DefaultChannelRuntimeFacadeDependencies,
  ) {}

  async dispatchToBinding(
    binding: ChannelBinding,
    envelope: ExternalMessageEnvelope,
  ): Promise<ChannelRuntimeDispatchResult> {
    if (binding.targetType === "AGENT") {
      return this.dispatchToAgent(binding, envelope);
    }
    return this.dispatchToTeam(binding, envelope);
  }

  private async dispatchToAgent(
    binding: ChannelBinding,
    envelope: ExternalMessageEnvelope,
  ): Promise<ChannelRuntimeDispatchResult> {
    const agentId = normalizeRequiredString(binding.agentId, "binding.agentId");
    const agent = this.deps.agentInstanceManager.getAgentInstance(agentId);
    if (!agent?.postUserMessage) {
      throw new Error(`Agent instance '${agentId}' not found for channel dispatch.`);
    }

    await agent.postUserMessage(buildAgentInputMessage(envelope));

    return {
      agentId,
      teamId: null,
      dispatchedAt: new Date(),
    };
  }

  private async dispatchToTeam(
    binding: ChannelBinding,
    envelope: ExternalMessageEnvelope,
  ): Promise<ChannelRuntimeDispatchResult> {
    const teamId = normalizeRequiredString(binding.teamId, "binding.teamId");
    const team = this.deps.agentTeamInstanceManager.getTeamInstance(teamId);
    if (!team?.postMessage) {
      throw new Error(`Team instance '${teamId}' not found for channel dispatch.`);
    }

    await team.postMessage(buildAgentInputMessage(envelope), binding.targetNodeName);

    return {
      agentId: null,
      teamId,
      dispatchedAt: new Date(),
    };
  }
}

const buildAgentInputMessage = (
  envelope: ExternalMessageEnvelope,
): AgentInputUserMessage => {
  const externalSource = buildAgentExternalSourceMetadata(envelope);
  const metadata: Record<string, unknown> = {
    ...envelope.metadata,
    externalSource,
  };

  return AgentInputUserMessage.fromDict({
    content: envelope.content,
    context_files: null,
    metadata,
  });
};

const normalizeRequiredString = (
  value: string | null,
  field: string,
): string => {
  if (value === null) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return normalized;
};
