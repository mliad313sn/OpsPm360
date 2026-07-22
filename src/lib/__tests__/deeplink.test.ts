import { describe, expect, it } from "vitest";
import {
  buildDeepLinkUrl,
  deepLinkTargetPath,
  signDeepLink,
  verifyDeepLink,
} from "@/lib/deeplink";

const SECRET = "test-secret-at-least-32-characters-long!!";

describe("deep links", () => {
  it("round-trips a payload", async () => {
    const token = await signDeepLink(
      { entityType: "BLOCKER", entityId: "b1", projectId: "p1" },
      SECRET
    );
    const payload = await verifyDeepLink(token, SECRET);
    expect(payload).toEqual({ entityType: "BLOCKER", entityId: "b1", projectId: "p1" });
  });

  it("rejects tampered tokens and wrong secrets", async () => {
    const token = await signDeepLink({ entityType: "PROJECT", entityId: "p1" }, SECRET);
    expect(await verifyDeepLink(`${token}x`, SECRET)).toBeNull();
    expect(await verifyDeepLink(token, "another-secret-32-characters-long!!!!")).toBeNull();
  });

  it("rejects expired tokens", async () => {
    const token = await signDeepLink({ entityType: "PROJECT", entityId: "p1" }, SECRET, -10);
    expect(await verifyDeepLink(token, SECRET)).toBeNull();
  });

  it("maps entities to anchored in-app paths", () => {
    expect(deepLinkTargetPath({ entityType: "PROJECT", entityId: "p1" })).toBe("/projects/p1");
    expect(
      deepLinkTargetPath({ entityType: "BLOCKER", entityId: "b1", projectId: "p1" })
    ).toBe("/projects/p1#blocker-b1");
    expect(deepLinkTargetPath({ entityType: "WAR_ROOM", entityId: "any" })).toBe("/meeting");
    // Child entity without a project falls back to a safe page, never a 404.
    expect(deepLinkTargetPath({ entityType: "BLOCKER", entityId: "b1" })).toBe("/meeting");
  });

  it("builds absolute /r URLs", async () => {
    const url = await buildDeepLinkUrl(
      { entityType: "PROJECT", entityId: "p1" },
      SECRET,
      "https://opspm.example.com/"
    );
    expect(url.startsWith("https://opspm.example.com/r?token=")).toBe(true);
  });
});
