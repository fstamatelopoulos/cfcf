import { describe, expect, test } from "bun:test";
import { formatBannerLine } from "./update-banner.js";

const argvFor = (verb: string, ...rest: string[]) => ["bun", "cfcf", verb, ...rest];

describe("formatBannerLine -- lifecycle gating", () => {
  test("prints on `cfcf init`", () => {
    const line = formatBannerLine(argvFor("init"), { latestVersion: "0.18.0" }, "0.17.1", false);
    expect(line).toContain("v0.18.0");
    expect(line).toContain("self-update --yes");
  });

  test("prints on `cfcf server start`", () => {
    const line = formatBannerLine(argvFor("server", "start"), { latestVersion: "0.18.0" }, "0.17.1", false);
    expect(line).not.toBeNull();
  });

  test("prints on `cfcf status`", () => {
    expect(formatBannerLine(argvFor("status"), { latestVersion: "0.18.0" }, "0.17.1", false)).not.toBeNull();
  });

  test("prints on `cfcf doctor`", () => {
    expect(formatBannerLine(argvFor("doctor"), { latestVersion: "0.18.0" }, "0.17.1", false)).not.toBeNull();
  });

  test("prints on `cfcf self-update --check`", () => {
    expect(formatBannerLine(argvFor("self-update", "--check"), { latestVersion: "0.18.0" }, "0.17.1", false))
      .not.toBeNull();
  });

  test("does NOT print on bare `cfcf self-update`", () => {
    // The command's own latest-vs-current diff already covers this; no duplicate banner.
    expect(formatBannerLine(argvFor("self-update"), { latestVersion: "0.18.0" }, "0.17.1", false)).toBeNull();
  });

  test("does NOT print on non-lifecycle verbs (`run`, `clio`, `workspace`, …)", () => {
    for (const verb of ["run", "clio", "workspace", "review", "reflect", "document", "config", "help"]) {
      const line = formatBannerLine(argvFor(verb), { latestVersion: "0.18.0" }, "0.17.1", false);
      expect(line).toBeNull();
    }
  });

  test("does NOT print when no verb (bare `cfcf`)", () => {
    expect(formatBannerLine(["bun", "cfcf"], { latestVersion: "0.18.0" }, "0.17.1", false)).toBeNull();
  });
});

describe("formatBannerLine -- suppression knobs", () => {
  test("opted-out users see no banner even on lifecycle verbs", () => {
    expect(formatBannerLine(argvFor("init"), { latestVersion: "0.18.0" }, "0.17.1", true)).toBeNull();
  });

  test("returns null when no flag file is present", () => {
    expect(formatBannerLine(argvFor("init"), null, "0.17.1", false)).toBeNull();
  });

  test("returns null when latest <= running (stale flag race after upgrade)", () => {
    expect(formatBannerLine(argvFor("init"), { latestVersion: "0.17.0" }, "0.17.1", false)).toBeNull();
    expect(formatBannerLine(argvFor("init"), { latestVersion: "0.17.1" }, "0.17.1", false)).toBeNull();
  });
});
