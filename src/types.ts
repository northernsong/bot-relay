export type BotKind = 'relay' | 'a2a';

export type Bot = {
  id: string;
  displayName: string;
  webhookUrl: string | null;
  authHeaderName: string | null;
  authHeaderValueEnc: string | null;
  tokenHash: string;
  /** null means any registered bot may send. An empty array means nobody may send. */
  allowlist: string[] | null;
  kind: BotKind;
  a2aCardUrl: string | null;
  a2aEndpoint: string | null;
  a2aInboundTokenHash: string | null;
  acceptA2a: boolean;
  /** Where the stored outbound credential is attached. */
  a2aAuthIn: 'header' | 'query' | null;
  a2aTenant: string | null;
  createdAt: number;
  updatedAt: number;
};

export type MessageStatus = 'pending' | 'delivering' | 'delivered' | 'failed' | 'inbox';

export type Message = {
  id: string;
  fromId: string;
  toId: string;
  threadId: string;
  replyTo: string | null;
  body: string;
  metadata: unknown | null;
  hop: number;
  status: MessageStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: number | null;
  createdAt: number;
  deliveredAt: number | null;
  inboxAckedAt: number | null;
};

export type NewMessage = {
  id: string;
  fromId: string;
  toId: string;
  threadId: string;
  replyTo: string | null;
  body: string;
  metadata: unknown | null;
  hop: number;
  status: 'pending' | 'inbox';
  nextAttemptAt: number | null;
  createdAt: number;
};

export type DeliveryAttempt = {
  attempt: number;
  statusCode: number | null;
  error: string | null;
  createdAt: number;
};

export type SendInput = {
  to: string;
  body: string;
  threadId: string | null;
  replyTo: string | null;
  metadata: unknown | null;
};

export type IdempotencyRecord = {
  messageId: string;
  requestHash: string;
};

export type NewBot = {
  id: string;
  displayName: string;
  webhookUrl: string | null;
  authHeaderName: string | null;
  authHeaderValueEnc: string | null;
  tokenHash: string;
  allowlist: string[] | null;
  kind: BotKind;
  a2aCardUrl: string | null;
  a2aEndpoint: string | null;
  a2aInboundTokenHash: string | null;
  acceptA2a: boolean;
  a2aAuthIn: 'header' | 'query' | null;
  a2aTenant: string | null;
  createdAt: number;
  updatedAt: number;
};

export type BotPatch = {
  displayName?: string;
  webhookUrl?: string | null;
  authHeaderName?: string | null;
  authHeaderValueEnc?: string | null;
  allowlist?: string[] | null;
  tokenHash?: string;
  acceptA2a?: boolean;
  a2aInboundTokenHash?: string | null;
};

export type A2aDirection = 'inbound' | 'outbound';

export type A2aTask = {
  id: string;
  direction: A2aDirection;
  botId: string;
  contextId: string | null;
  threadId: string;
  relayMessageId: string | null;
  state: string;
  remoteMessageId: string | null;
  requestText: string;
  responseText: string | null;
  history: unknown[];
  createdAt: number;
  updatedAt: number;
};

export type NewA2aTask = {
  id: string;
  direction: A2aDirection;
  botId: string;
  contextId: string | null;
  threadId: string;
  relayMessageId: string | null;
  state: string;
  remoteMessageId: string | null;
  requestText: string;
  responseText: string | null;
  history: unknown[];
  createdAt: number;
};
