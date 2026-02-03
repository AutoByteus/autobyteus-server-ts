export class Message {
  role: string;
  message: string;
  timestamp: Date;
  messageId?: string | null;
  originalMessage?: string | null;
  contextPaths?: string[] | null;
  tokenCount?: number | null;
  cost?: number | null;
  reasoning?: string | null;
  imageUrls?: string[] | null;
  audioUrls?: string[] | null;
  videoUrls?: string[] | null;

  constructor(options: {
    role: string;
    message: string;
    timestamp: Date;
    messageId?: string | null;
    originalMessage?: string | null;
    contextPaths?: string[] | null;
    tokenCount?: number | null;
    cost?: number | null;
    reasoning?: string | null;
    imageUrls?: string[] | null;
    audioUrls?: string[] | null;
    videoUrls?: string[] | null;
  }) {
    this.role = options.role;
    this.message = options.message;
    this.timestamp = options.timestamp;
    this.messageId = options.messageId ?? null;
    this.originalMessage = options.originalMessage ?? null;
    this.contextPaths = options.contextPaths ?? null;
    this.tokenCount = options.tokenCount ?? null;
    this.cost = options.cost ?? null;
    this.reasoning = options.reasoning ?? null;
    this.imageUrls = options.imageUrls ?? null;
    this.audioUrls = options.audioUrls ?? null;
    this.videoUrls = options.videoUrls ?? null;
  }
}

export class AgentConversation {
  agentId: string;
  agentDefinitionId: string;
  createdAt: Date;
  messages: Message[];
  llmModel?: string | null;
  useXmlToolFormat: boolean;

  constructor(options: {
    agentId: string;
    agentDefinitionId: string;
    createdAt: Date;
    messages: Message[];
    llmModel?: string | null;
    useXmlToolFormat?: boolean;
  }) {
    this.agentId = options.agentId;
    this.agentDefinitionId = options.agentDefinitionId;
    this.createdAt = options.createdAt;
    this.messages = options.messages;
    this.llmModel = options.llmModel ?? null;
    this.useXmlToolFormat = options.useXmlToolFormat ?? false;
  }
}

export class PaginatedResult<T> {
  items: T[];
  totalItems: number;
  totalPages: number;
  currentPage: number;

  constructor(options: {
    items: T[];
    totalItems: number;
    totalPages: number;
    currentPage: number;
  }) {
    this.items = options.items;
    this.totalItems = options.totalItems;
    this.totalPages = options.totalPages;
    this.currentPage = options.currentPage;
  }
}

export class ConversationHistory {
  conversations: AgentConversation[];
  totalConversations: number;
  totalPages: number;
  currentPage: number;

  constructor(options: {
    conversations: AgentConversation[];
    totalConversations: number;
    totalPages: number;
    currentPage: number;
  }) {
    this.conversations = options.conversations;
    this.totalConversations = options.totalConversations;
    this.totalPages = options.totalPages;
    this.currentPage = options.currentPage;
  }
}
