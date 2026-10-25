/**
 * Telegram's webhook source ranges, from core.telegram.org/bots/webhooks.
 * Telegram only calls webhooks over IPv4, so anything else is refused.
 */

const TELEGRAM_RANGES: [base: string, bits: number][] = [
  ["149.154.160.0", 20],
  ["91.108.4.0", 22],
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function inRange(ip: number, base: string, bits: number): boolean {
  const start = ipv4ToInt(base)!;
  const size = 2 ** (32 - bits);
  return ip >= start && ip < start + size;
}

export function isTelegramIp(ip: string | null | undefined): boolean {
  if (!ip) return false;
  // An IPv4-mapped IPv6 address is still the IPv4 one.
  const value = ipv4ToInt(ip.trim().replace(/^::ffff:/i, ""));
  if (value === null) return false;
  return TELEGRAM_RANGES.some(([base, bits]) => inRange(value, base, bits));
}
