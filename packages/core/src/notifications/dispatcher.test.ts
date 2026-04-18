/**
 * Tests for the notification dispatcher.
 *
 * We replace the built-in channel registry with mock channels for the
 * duration of each test to avoid actually beeping or shelling out to
 * osascript/notify-send.
 */

import { describe, test, expect } from "bun:test";
import { dispatch, makeEvent } from "./dispatcher.js";
import { channelRegistry } from "./channels/index.js";
import type { NotificationChannel } from "./types.js";
import type {
  NotificationChannelName,
  NotificationConfig,
  NotificationEvent,
} from "../types.js";

function withMockChannels<T>(
  mocks: Record<NotificationChannelName, NotificationChannel>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const originals: Partial<Record<NotificationChannelName, NotificationChannel>> = {};
  for (const name of Object.keys(mocks) as NotificationChannelName[]) {
    originals[name] = channelRegistry[name];
    channelRegistry[name] = mocks[name];
  }
  return Promise.resolve(fn()).finally(() => {
    for (const name of Object.keys(originals) as NotificationChannelName[]) {
      channelRegistry[name] = originals[name]!;
    }
  });
}

function makeMockChannel(name: NotificationChannelName): NotificationChannel & {
  calls: NotificationEvent[];
} {
  const channel: NotificationChannel & { calls: NotificationEvent[] } = {
    name,
    calls: [],
    async deliver(event) {
      this.calls.push(event);
    },
  };
  return channel;
}

function makeTestEvent(type: "loop.paused" | "loop.completed" | "agent.failed" = "loop.paused"): NotificationEvent {
  return makeEvent({
    type,
    title: "Test",
    message: "Test message",
    projectId: "p1",
    projectName: "test-project",
  });
}

describe("notification dispatcher", () => {
  test("dispatches to all configured channels", async () => {
    const bell = makeMockChannel("terminal-bell");
    const macos = makeMockChannel("macos");
    const log = makeMockChannel("log");

    await withMockChannels(
      { "terminal-bell": bell, macos, log } as any,
      async () => {
        const config: NotificationConfig = {
          enabled: true,
          events: {
            "loop.paused": ["terminal-bell", "macos", "log"],
          },
        };
        await dispatch(makeTestEvent("loop.paused"), config);
      },
    );

    expect(bell.calls).toHaveLength(1);
    expect(macos.calls).toHaveLength(1);
    expect(log.calls).toHaveLength(1);
  });

  test("skips channels not in the event's channel list", async () => {
    const bell = makeMockChannel("terminal-bell");
    const macos = makeMockChannel("macos");

    await withMockChannels(
      { "terminal-bell": bell, macos } as any,
      async () => {
        const config: NotificationConfig = {
          enabled: true,
          events: {
            "loop.paused": ["terminal-bell"], // only bell
          },
        };
        await dispatch(makeTestEvent("loop.paused"), config);
      },
    );

    expect(bell.calls).toHaveLength(1);
    expect(macos.calls).toHaveLength(0);
  });

  test("does nothing when notifications are disabled", async () => {
    const bell = makeMockChannel("terminal-bell");

    await withMockChannels({ "terminal-bell": bell } as any, async () => {
      const config: NotificationConfig = {
        enabled: false,
        events: {
          "loop.paused": ["terminal-bell"],
        },
      };
      await dispatch(makeTestEvent("loop.paused"), config);
    });

    expect(bell.calls).toHaveLength(0);
  });

  test("does nothing when config is undefined", async () => {
    const bell = makeMockChannel("terminal-bell");

    await withMockChannels({ "terminal-bell": bell } as any, async () => {
      await dispatch(makeTestEvent("loop.paused"), undefined);
    });

    expect(bell.calls).toHaveLength(0);
  });

  test("skips events with no channel mapping", async () => {
    const bell = makeMockChannel("terminal-bell");

    await withMockChannels({ "terminal-bell": bell } as any, async () => {
      const config: NotificationConfig = {
        enabled: true,
        events: {
          "loop.paused": ["terminal-bell"],
          // "loop.completed" not configured
        },
      };
      await dispatch(makeTestEvent("loop.completed"), config);
    });

    expect(bell.calls).toHaveLength(0);
  });

  test("a failing channel does not prevent others from firing", async () => {
    const failing: NotificationChannel = {
      name: "macos",
      async deliver() {
        throw new Error("boom");
      },
    };
    const good = makeMockChannel("terminal-bell");

    await withMockChannels({ macos: failing, "terminal-bell": good } as any, async () => {
      const config: NotificationConfig = {
        enabled: true,
        events: {
          "loop.paused": ["macos", "terminal-bell"],
        },
      };
      await dispatch(makeTestEvent("loop.paused"), config);
    });

    expect(good.calls).toHaveLength(1);
  });

  test("makeEvent populates timestamp and project fields", () => {
    const event = makeEvent({
      type: "loop.completed",
      title: "Done",
      message: "All done",
      projectId: "abc",
      projectName: "xyz",
      details: { outcome: "success" },
    });
    expect(event.type).toBe("loop.completed");
    expect(event.project.id).toBe("abc");
    expect(event.project.name).toBe("xyz");
    expect(event.details?.outcome).toBe("success");
    expect(typeof event.timestamp).toBe("string");
    expect(new Date(event.timestamp).getTime()).toBeGreaterThan(0);
  });
});
