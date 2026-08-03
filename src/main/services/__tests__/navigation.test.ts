import { describe, expect, it } from "vitest";

import { decideNavigation, originOf } from "../navigation.ts";

describe("decideNavigation", () => {
  const dev = "http://localhost:5173";

  it("allows same-origin dev-server navigation", () => {
    expect(decideNavigation("http://localhost:5173/", dev)).toBe("allow");
    expect(decideNavigation("http://localhost:5173/index.html", dev)).toBe(
      "allow",
    );
  });

  it("does not treat userinfo-prefixed URLs as the dev origin (startsWith bypass)", () => {
    // `http://localhost:5173@evil.example` の origin は evil.example。
    // prefix 比較なら "allow" になってしまうが、 origin 比較では external。
    const crafted = "http://localhost:5173@evil.example/path";
    expect(decideNavigation(crafted, dev)).toBe("external");
  });

  it("routes http/https/mailto to the default browser", () => {
    expect(decideNavigation("https://example.com/docs", dev)).toBe("external");
    expect(decideNavigation("http://example.com", null)).toBe("external");
    expect(decideNavigation("mailto:user@example.com", null)).toBe("external");
  });

  it("denies file:, custom schemes, and malformed URLs", () => {
    expect(decideNavigation("file:///etc/passwd", null)).toBe("deny");
    expect(decideNavigation("smb://server/share", null)).toBe("deny");
    expect(decideNavigation("not a url", null)).toBe("deny");
    expect(decideNavigation("", null)).toBe("deny");
  });

  it("never allows same-origin when no dev origin is configured (production)", () => {
    expect(decideNavigation("http://localhost:5173/", null)).toBe("external");
  });
});

describe("originOf", () => {
  it("returns the origin for valid URLs", () => {
    expect(originOf("http://localhost:5173/")).toBe("http://localhost:5173");
  });
  it("returns null for unset or malformed values", () => {
    expect(originOf(undefined)).toBeNull();
    expect(originOf("")).toBeNull();
    expect(originOf("not a url")).toBeNull();
  });
});
