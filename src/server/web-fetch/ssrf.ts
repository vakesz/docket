// IP ranges are duplicated here rather than pulled from a package so the
// guard has no runtime dependency that could be silently relaxed by an
// upstream patch — these constants are part of the security boundary.
// Hostname and resolved-IP checks both run as defense-in-depth against
// DNS rebinding (a public+private dual-record attack defeats either alone).

import "server-only";
import { promises as dns } from "node:dns";
import { isIP } from "node:net";

const BLOCKED_HOSTNAMES: ReadonlySet<string> = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata.ec2.internal",
  "metadata.azure.com",
  "instance-data",
]);

const BLOCKED_V4_RANGES: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["255.255.255.255", 32],
];

// IPv6 first-group ranges (inclusive) we always reject. Each entry covers
// a slice of the 0–0xffff hex space the leading group can land in:
//   fc00::/7   — ULA (fc00 .. fdff)
//   fe80::/10  — link-local (fe80 .. febf)
//   fec0::/10  — site-local, deprecated but still seen (fec0 .. feff)
//   ff00::/8   — multicast (ff00 .. ffff)
const BLOCKED_V6_FIRST_GROUP_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0xfc00, 0xfdff],
  [0xfe80, 0xfebf],
  [0xfec0, 0xfeff],
  [0xff00, 0xffff],
];

export type SsrfDenyReason =
  | "denied_scheme"
  | "denied_host_metadata"
  | "denied_host_unresolved"
  | "denied_ip_private"
  | "denied_ip_invalid";

export type SsrfDenial = { ok: false; reason: SsrfDenyReason; detail: string };
export type SsrfAllow = { ok: true; host: string; resolvedIps: readonly string[] };
export type SsrfResult = SsrfAllow | SsrfDenial;

export async function assertFetchTargetSafe(parsed: URL): Promise<SsrfResult> {
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: "denied_scheme",
      detail: `scheme '${parsed.protocol.replace(":", "")}' is not allowed (http/https only)`,
    };
  }
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) {
    return {
      ok: false,
      reason: "denied_host_metadata",
      detail: `hostname '${host}' is a cloud metadata endpoint`,
    };
  }
  const literalFamily = isIP(host);
  if (literalFamily !== 0) {
    if (isPrivateIp(host, literalFamily)) {
      return {
        ok: false,
        reason: "denied_ip_private",
        detail: `IP literal ${host} is in a private/reserved range`,
      };
    }
    return { ok: true, host, resolvedIps: [host] };
  }
  let addresses: { address: string; family: number }[];
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    return {
      ok: false,
      reason: "denied_host_unresolved",
      detail: `DNS lookup failed for '${host}': ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (addresses.length === 0) {
    return {
      ok: false,
      reason: "denied_host_unresolved",
      detail: `DNS lookup returned no addresses for '${host}'`,
    };
  }
  for (const a of addresses) {
    if (isPrivateIp(a.address, a.family)) {
      return {
        ok: false,
        reason: "denied_ip_private",
        detail: `'${host}' resolved to ${a.address}, which is in a private/reserved range`,
      };
    }
  }
  return { ok: true, host, resolvedIps: addresses.map((a) => a.address) };
}

export function isPrivateIp(address: string, family: number): boolean {
  if (family === 4) return isPrivateV4(address);
  if (family === 6) return isPrivateV6(address);
  return true;
}

function isPrivateV4(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) return true;
  const num = parts.map((p) => Number(p)) as [number, number, number, number];
  if (num.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const ipNum = ((num[0] << 24) | (num[1] << 16) | (num[2] << 8) | num[3]) >>> 0;
  for (const [base, bits] of BLOCKED_V4_RANGES) {
    const baseParts = base.split(".").map((p) => Number(p)) as [number, number, number, number];
    const baseNum =
      ((baseParts[0] << 24) | (baseParts[1] << 16) | (baseParts[2] << 8) | baseParts[3]) >>> 0;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((ipNum & mask) === (baseNum & mask)) return true;
  }
  return false;
}

function isPrivateV6(address: string): boolean {
  // Drop scope id (e.g. fe80::1%eth0) before normalising.
  const cleaned = address.split("%")[0]?.toLowerCase() ?? "";
  if (!cleaned) return true;
  // IPv4-mapped IPv6: defer to the v4 check on the trailing dotted-quad.
  if (cleaned.startsWith("::ffff:") && cleaned.includes(".")) {
    const v4 = cleaned.slice("::ffff:".length);
    return isPrivateV4(v4);
  }
  if (cleaned === "::" || cleaned === "::1") return true;
  // Pull the leading 16-bit group. "::xyz" leaves the first group as the
  // empty string (i.e. zero); anything starting with `:` collapses to 0
  // and isn't in any of the blocked ranges. Otherwise parse as hex.
  const firstSegmentRaw = cleaned.startsWith("::") ? "" : (cleaned.split(":")[0] ?? "");
  const firstGroup = firstSegmentRaw === "" ? 0 : Number.parseInt(firstSegmentRaw, 16);
  if (Number.isNaN(firstGroup)) return true;
  for (const [lo, hi] of BLOCKED_V6_FIRST_GROUP_RANGES) {
    if (firstGroup >= lo && firstGroup <= hi) return true;
  }
  return false;
}
