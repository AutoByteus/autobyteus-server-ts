import { NodeType } from "./enums.js";

export class TeamMember {
  memberName: string;
  referenceId: string;
  referenceType: NodeType;
  dependencies: string[];

  constructor(options: {
    memberName: string;
    referenceId: string;
    referenceType: NodeType;
    dependencies?: string[];
  }) {
    this.memberName = options.memberName;
    this.referenceId = options.referenceId;
    this.referenceType = options.referenceType;
    this.dependencies = options.dependencies ?? [];
  }
}

export class AgentTeamDefinition {
  id?: string | null;
  name: string;
  description: string;
  nodes: TeamMember[];
  coordinatorMemberName: string;
  role?: string | null;

  constructor(options: {
    name: string;
    description: string;
    nodes: TeamMember[];
    coordinatorMemberName: string;
    id?: string | null;
    role?: string | null;
  }) {
    this.name = options.name;
    this.description = options.description;
    this.nodes = options.nodes;
    this.coordinatorMemberName = options.coordinatorMemberName;
    this.id = options.id ?? null;
    this.role = options.role ?? null;
  }
}

export class AgentTeamDefinitionUpdate {
  name?: string | null;
  description?: string | null;
  role?: string | null;
  nodes?: TeamMember[] | null;
  coordinatorMemberName?: string | null;

  constructor(options: {
    name?: string | null;
    description?: string | null;
    role?: string | null;
    nodes?: TeamMember[] | null;
    coordinatorMemberName?: string | null;
  } = {}) {
    this.name = options.name ?? null;
    this.description = options.description ?? null;
    this.role = options.role ?? null;
    this.nodes = options.nodes ?? null;
    this.coordinatorMemberName = options.coordinatorMemberName ?? null;
  }
}
