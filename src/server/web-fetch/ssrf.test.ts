import { describe, expect, it } from "vitest";
import { assertFetchTargetSafe, isPrivateIp } from "@/server/web-fetch/ssrf";

describe("isPrivateIp", () => {
  it("flags v4 loopback / link-local / private ranges", () => {
    for (const ip of [
      "0.0.0.0",
      "127.0.0.1",
      "169.254.169.254",
      "10.0.0.1",
      "172.16.5.5",
      "172.31.255.255",
      "192.168.1.1",
      "100.64.0.1",
      "224.0.0.1",
    ]) {
      expect(isPrivateIp(ip, 4)).toBe(true);
    }
  });

  it("allows public v4 addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.63.255.255"]) {
      expect(isPrivateIp(ip, 4)).toBe(false);
    }
  });

  it("flags v6 loopback / link-local / ULA", () => {
    for (const ip of ["::", "::1", "fe80::1", "fc00::1", "fd00:dead:beef::1", "ff02::1"]) {
      expect(isPrivateIp(ip, 6)).toBe(true);
    }
  });

  it("allows public v6 addresses", () => {
    for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888"]) {
      expect(isPrivateIp(ip, 6)).toBe(false);
    }
  });

  it("flags IPv4-mapped IPv6 of private v4", () => {
    expect(isPrivateIp("::ffff:127.0.0.1", 6)).toBe(true);
    expect(isPrivateIp("::ffff:10.0.0.1", 6)).toBe(true);
    expect(isPrivateIp("::ffff:8.8.8.8", 6)).toBe(false);
  });
});

describe("assertFetchTargetSafe", () => {
  it("denies non-http(s) schemes", async () => {
    const r = await assertFetchTargetSafe(new URL("file:///etc/passwd"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("denied_scheme");
  });

  it("denies cloud metadata hostnames by name", async () => {
    const r = await assertFetchTargetSafe(new URL("http://metadata.google.internal/"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("denied_host_metadata");
  });

  it("denies private IP literals without DNS", async () => {
    const r = await assertFetchTargetSafe(new URL("http://127.0.0.1:8080/"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("denied_ip_private");
  });

  it("denies link-local IPv4 metadata literal", async () => {
    const r = await assertFetchTargetSafe(new URL("http://169.254.169.254/latest/meta-data"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("denied_ip_private");
  });

  it("allows a public IPv4 literal", async () => {
    const r = await assertFetchTargetSafe(new URL("https://8.8.8.8/"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.host).toBe("8.8.8.8");
  });
});
