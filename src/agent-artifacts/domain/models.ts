export class AgentArtifact {
  id?: string | null;
  agentId: string;
  path: string;
  type: string;
  workspaceRoot?: string | null;
  url?: string | null;
  createdAt: Date;
  updatedAt: Date;

  constructor(options: {
    agentId: string;
    path: string;
    type: string;
    createdAt: Date;
    updatedAt: Date;
    id?: string | null;
    workspaceRoot?: string | null;
    url?: string | null;
  }) {
    this.id = options.id ?? null;
    this.agentId = options.agentId;
    this.path = options.path;
    this.type = options.type;
    this.workspaceRoot = options.workspaceRoot ?? null;
    this.url = options.url ?? null;
    this.createdAt = options.createdAt;
    this.updatedAt = options.updatedAt;
  }
}
