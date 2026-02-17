import { createHash } from "node:crypto";

const normalizeRequiredString = (value: string, fieldName: string): string => {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldName} cannot be empty.`);
  }
  return normalized;
};

export const normalizeMemberRouteKey = (memberRouteKey: string): string => {
  const normalized = normalizeRequiredString(memberRouteKey, "memberRouteKey")
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!normalized) {
    throw new Error("memberRouteKey cannot be empty.");
  }
  return normalized;
};

export const buildTeamMemberAgentId = (teamId: string, memberRouteKey: string): string => {
  const normalizedTeamId = normalizeRequiredString(teamId, "teamId");
  const normalizedRouteKey = normalizeMemberRouteKey(memberRouteKey);
  const hash = createHash("sha256")
    .update(`${normalizedTeamId}::${normalizedRouteKey}`)
    .digest("hex")
    .slice(0, 16);
  return `member_${hash}`;
};
