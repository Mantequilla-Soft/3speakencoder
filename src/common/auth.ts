import { createHash, timingSafeEqual } from 'crypto';

/** Constant-time string comparison (hashing first hides length differences too). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
