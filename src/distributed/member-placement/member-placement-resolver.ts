import type { AgentTeamDefinition } from "../../agent-team-definition/domain/models.js";
import {
  DefaultPlacementPolicy,
  type PlacementCandidateNode,
} from "../policies/default-placement-policy.js";
import { PlacementConstraintPolicy } from "../policies/placement-constraint-policy.js";

const normalizeNodeId = (value: string | null | undefined): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export type MemberPlacementSource = "required" | "home" | "preferred" | "default";

export type MemberPlacement = {
  memberName: string;
  nodeId: string;
  source: MemberPlacementSource;
};

export type PlacementByMember = Record<string, MemberPlacement>;

export type ResolvePlacementInput = {
  teamDefinition: AgentTeamDefinition;
  nodeSnapshots: PlacementCandidateNode[];
  defaultNodeId?: string | null;
};

export class MemberPlacementResolver {
  private readonly placementConstraintPolicy: PlacementConstraintPolicy;
  private readonly defaultPlacementPolicy: DefaultPlacementPolicy;

  constructor(options: {
    placementConstraintPolicy?: PlacementConstraintPolicy;
    defaultPlacementPolicy?: DefaultPlacementPolicy;
  } = {}) {
    this.placementConstraintPolicy =
      options.placementConstraintPolicy ?? new PlacementConstraintPolicy();
    this.defaultPlacementPolicy = options.defaultPlacementPolicy ?? new DefaultPlacementPolicy();
  }

  resolvePlacement(input: ResolvePlacementInput): PlacementByMember {
    const knownNodeIds = new Set(input.nodeSnapshots.map((node) => node.nodeId));
    const availableNodeIds = new Set(
      input.nodeSnapshots
        .filter((node) => node.supportsAgentExecution !== false && node.isHealthy !== false)
        .map((node) => node.nodeId)
    );

    const placementByMember: PlacementByMember = {};

    for (const member of input.teamDefinition.nodes) {
      this.placementConstraintPolicy.validateRequiredAndPreferred(
        member,
        knownNodeIds,
        availableNodeIds
      );

      const requiredNodeId = normalizeNodeId(member.requiredNodeId);
      if (requiredNodeId) {
        placementByMember[member.memberName] = {
          memberName: member.memberName,
          nodeId: requiredNodeId,
          source: "required",
        };
        continue;
      }

      const homeNodeId = normalizeNodeId(member.homeNodeId);
      if (homeNodeId && availableNodeIds.has(homeNodeId)) {
        placementByMember[member.memberName] = {
          memberName: member.memberName,
          nodeId: homeNodeId,
          source: "home",
        };
        continue;
      }

      const preferredNodeId = normalizeNodeId(member.preferredNodeId);
      if (preferredNodeId && availableNodeIds.has(preferredNodeId)) {
        placementByMember[member.memberName] = {
          memberName: member.memberName,
          nodeId: preferredNodeId,
          source: "preferred",
        };
        continue;
      }

      const nodeId = this.defaultPlacementPolicy.assignByCapabilityAndHealth(
        member,
        input.nodeSnapshots,
        input.defaultNodeId
      );

      placementByMember[member.memberName] = {
        memberName: member.memberName,
        nodeId,
        source: "default",
      };
    }

    return placementByMember;
  }
}
