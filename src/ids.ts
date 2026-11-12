import { randomBytes } from 'node:crypto';

export function newMessageId(): string {
  return `msg_${randomBytes(16).toString('base64url')}`;
}

export function newThreadId(): string {
  return `thr_${randomBytes(16).toString('base64url')}`;
}
