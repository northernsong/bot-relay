export type IntakeMode = 'open' | 'allowlist' | 'none';

export type Bot = {
  id: string;
  displayName: string;
  /** Free-text capability description shown in the directory. */
  capabilities: string;
  /** Encoded webhook URL (AES-256-GCM). Contact details never appear in plaintext columns. */
  webhookUrlEnc: string;
  webhookAuthName: string;
  /** Encoded webhook auth value (AES-256-GCM). Empty string when no auth header is set. */
  webhookAuthValueEnc: string;
  tokenHash: string;
  tokenSetAt: number;
  /** Non-null marks the access token as revoked; every authenticated call then fails. */
  tokenRevokedAt: number | null;
  disabled: boolean;
  intakeMode: IntakeMode;
  /** Bot ids allowed to open inquiries; only meaningful in allowlist mode. */
  intakeAllowlist: string[] | null;
  /** Bumped whenever webhook_url or webhook_auth_value changes. */
  contactVersion: number;
  webhookSecretSetAt: number;
  createdAt: number;
  updatedAt: number;
  /** Last call that passed token auth, for the admin "recent activity" view. */
  lastSeenAt: number | null;
};

export type NewBot = Omit<Bot, 'contactVersion' | 'webhookSecretSetAt'> & {
  contactVersion?: number;
  webhookSecretSetAt?: number;
};

export type BotPatch = Partial<Omit<Bot, 'id' | 'createdAt'>>;

export type Invite = {
  id: number;
  codePrefix: string;
  label: string | null;
  maxUses: number;
  uses: number;
  expiresAt: number | null;
  revokedAt: number | null;
  createdAt: number;
};

export type InquiryStatus = 'delivering' | 'pending' | 'approved' | 'rejected' | 'expired' | 'undelivered';

export type Inquiry = {
  id: string;
  requesterId: string;
  targetId: string;
  status: InquiryStatus;
  createdAt: number;
  expiresAt: number;
  deliveredAt: number | null;
  decidedAt: number | null;
  deliveryError: string | null;
};

export type Grant = {
  id: string;
  requesterId: string;
  targetId: string;
  inquiryId: string;
  grantedAt: number;
  revokedAt: number | null;
  abandonedAt: number | null;
  refreshedAt: number | null;
  refreshedContactVersion: number | null;
};

export type AuditEvent = {
  id: number;
  at: number;
  actor: string;
  action: string;
  object: string | null;
  detail: string | null;
  source: string | null;
};
