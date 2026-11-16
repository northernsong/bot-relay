import { randomBytes } from 'node:crypto';

/** Authorization inquiry id: `inq_` + 24 random bytes. */
export function newInquiryId(): string {
  return `inq_${randomBytes(24).toString('base64url')}`;
}

/** Grant id: `grt_` + 16 random bytes. */
export function newGrantId(): string {
  return `grt_${randomBytes(16).toString('base64url')}`;
}
