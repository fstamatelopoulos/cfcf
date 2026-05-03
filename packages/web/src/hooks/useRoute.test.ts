import { describe, expect, test } from "bun:test";
import { parseRouteHash } from "./useRoute";

describe("parseRouteHash", () => {
  test("empty hash → dashboard", () => {
    expect(parseRouteHash("")).toEqual({ page: "dashboard" });
    expect(parseRouteHash("/")).toEqual({ page: "dashboard" });
  });

  test("/workspaces/<id> → workspace page", () => {
    expect(parseRouteHash("/workspaces/calc-98c1a7")).toEqual({
      page: "workspace",
      workspaceId: "calc-98c1a7",
    });
  });

  test("/workspaces/<encoded id> → URL-decoded id", () => {
    expect(parseRouteHash("/workspaces/foo%20bar")).toEqual({
      page: "workspace",
      workspaceId: "foo bar",
    });
  });

  test("/help → help page (no topic)", () => {
    expect(parseRouteHash("/help")).toEqual({ page: "help", helpTopic: undefined });
  });

  test("/help/<topic> → help page with topic", () => {
    expect(parseRouteHash("/help/clio")).toEqual({ page: "help", helpTopic: "clio" });
  });

  test("/server → settings page", () => {
    expect(parseRouteHash("/server")).toEqual({ page: "server" });
  });

  test("/memory → memory page (default search tab, no doc)", () => {
    expect(parseRouteHash("/memory")).toEqual({
      page: "memory",
      memoryTab: undefined,
      memoryDocId: undefined,
    });
  });

  test("/memory?tab=search → memory page with tab", () => {
    expect(parseRouteHash("/memory?tab=search")).toEqual({
      page: "memory",
      memoryTab: "search",
      memoryDocId: undefined,
    });
  });

  test("/memory?tab=ingest → memory page with ingest tab", () => {
    expect(parseRouteHash("/memory?tab=ingest")).toEqual({
      page: "memory",
      memoryTab: "ingest",
      memoryDocId: undefined,
    });
  });

  test("invalid tab is dropped (silently falls back to default)", () => {
    expect(parseRouteHash("/memory?tab=nonsense")).toEqual({
      page: "memory",
      memoryTab: undefined,
      memoryDocId: undefined,
    });
  });

  test("/memory?doc=<id> → memory page with doc overlay", () => {
    expect(parseRouteHash("/memory?doc=abc123")).toEqual({
      page: "memory",
      memoryTab: undefined,
      memoryDocId: "abc123",
    });
  });

  test("/memory?tab=audit&doc=abc → both tab + doc preserved", () => {
    expect(parseRouteHash("/memory?tab=audit&doc=abc-def")).toEqual({
      page: "memory",
      memoryTab: "audit",
      memoryDocId: "abc-def",
    });
  });

  test("doc id with URL encoding is decoded", () => {
    expect(parseRouteHash("/memory?tab=browse&doc=foo%2Fbar")).toEqual({
      page: "memory",
      memoryTab: "browse",
      memoryDocId: "foo/bar",
    });
  });
});
