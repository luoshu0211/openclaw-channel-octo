import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createBotTaskHandler } from "./bot-task-handler.js";
import { createFileBotTaskStateStore, type BotTaskStateStore } from "./bot-task-store.js";
import {
  botTaskDedupeKey,
  botTaskSessionScope,
  formatBotTaskText,
  parseBotTask,
  parseBotTaskResult,
  type BotTask,
} from "./bot-task.js";

function task(overrides: Partial<BotTask> = {}): BotTask {
  return {
    eventId: 41,
    source: "loop",
    taskType: "loop_issue_comment_mention",
    idempotencyKey: "comment-1:bot-1",
    botUid: "bot-1",
    actorUid: "user-1",
    sessionKey: "issue:1:thread:2",
    prompt: "Review the issue and reply if needed.",
    context: { issue_id: "1" },
    ...overrides,
  };
}

function stateStore(overrides: Partial<BotTaskStateStore> = {}): BotTaskStateStore {
  return {
    begin: vi.fn().mockResolvedValue({ skip: false, attemptCount: 1 }),
    started: vi.fn().mockResolvedValue(undefined),
    finish: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("bot task contract", () => {
  it("parses the stable envelope and keeps business fields opaque", () => {
    const parsed = parseBotTask({
      event_id: 41,
      event_type: "bot_task",
      event_data: {
        source: " loop ",
        task_type: "custom_workflow",
        idempotency_key: "key-1",
        bot_uid: "bot-1",
        actor_uid: "user-1",
        session_key: "thread-1",
        prompt: "do the work",
        context: { arbitrary: true },
        enqueued_at: 1_788_768_000,
      },
    });
    expect(parsed).toMatchObject({
      source: "loop",
      taskType: "custom_workflow",
      context: { arbitrary: true },
    });
  });

  it("rejects malformed payloads and scopes sessions by bot, source, and session key", () => {
    expect(parseBotTask({ event_id: 41, event_type: "bot_task", event_data: { prompt: "x" } })).toBeNull();
    expect(botTaskSessionScope(task())).toBe("octo:bot-task:bot-1:loop:issue\\:1\\:thread\\:2");
    expect(botTaskDedupeKey(task({ source: "loop" }))).not.toBe(botTaskDedupeKey(task({ source: "doc" })));
  });

  it("rejects millisecond enqueued_at with an actionable parse reason", () => {
    const parsed = parseBotTaskResult({
      event_id: 41,
      event_type: "bot_task",
      event_data: {
        source: "loop",
        task_type: "custom_workflow",
        idempotency_key: "key-1",
        bot_uid: "bot-1",
        actor_uid: "user-1",
        session_key: "thread-1",
        prompt: "do the work",
        context: {},
        enqueued_at: 1_788_768_000_000,
      },
    });
    expect(parsed).toEqual({
      ok: false,
      reason: "enqueued_at must be a positive Unix timestamp in seconds",
    });
  });

  it("treats omitted or null optional payload fields as absent", () => {
    const base = {
      source: "loop",
      task_type: "custom_workflow",
      idempotency_key: "key-1",
      bot_uid: "bot-1",
      actor_uid: "user-1",
      session_key: "thread-1",
      prompt: "do the work",
    };
    expect(parseBotTask({ event_id: 41, event_type: "bot_task", event_data: base })).toMatchObject({ context: {} });
    const nullable = parseBotTask({
      event_id: 42,
      event_type: "bot_task",
      event_data: { ...base, context: null, metadata: null, enqueued_at: null },
    });
    expect(nullable).toMatchObject({ context: {} });
    expect(nullable).not.toHaveProperty("metadata");
    expect(nullable).not.toHaveProperty("enqueuedAt");
  });

  it("rejects deeply nested context without throwing", () => {
    let context: Record<string, unknown> = {};
    for (let depth = 0; depth < 6_000; depth += 1) context = { nested: context };
    const parsed = parseBotTaskResult({
      event_id: 43,
      event_type: "bot_task",
      event_data: {
        source: "loop",
        task_type: "custom_workflow",
        idempotency_key: "key-deep",
        bot_uid: "bot-1",
        actor_uid: "user-1",
        session_key: "thread-deep",
        prompt: "do the work",
        context,
      },
    });
    expect(parsed.ok).toBe(false);
  });
});

describe("bot task handler", () => {
  it("passes an opaque prompt to an isolated, IM-suppressed Agent turn", async () => {
    const store = stateStore();
    const dispatch = vi.fn().mockImplementation(async (_message, _route, extra) => {
      await extra.docTask.onAgentTurnStarted();
      return "completed" as const;
    });
    const handle = createBotTaskHandler({ botUid: "bot-1", store, dispatch });

    await handle(task());

    const [message, route, extra] = dispatch.mock.calls[0];
    expect(route).toBeUndefined();
    expect(message.payload.content).toContain("Review the issue and reply if needed.");
    expect(message.payload.content).toContain('idempotency_key="comment-1:bot-1"');
    expect(message.message_id).toBe("bot_task:41:attempt:1");
    expect(extra.queueScope).toBe("octo:bot-task:bot-1:loop:issue\\:1\\:thread\\:2");
    expect(extra.docTask.abortOnTimeout).toBe(true);
    expect(store.started).toHaveBeenCalledWith(41, botTaskDedupeKey(task()));
    await expect(extra.docTask.postComment("progress", undefined, "progress")).resolves.toBeUndefined();
    expect(store.finish).toHaveBeenCalledWith(41, botTaskDedupeKey(task()), "completed");
  });

  it("accepts a successful turn that does not call any tool", async () => {
    const store = stateStore();
    const dispatch = vi.fn().mockImplementation(async (_message, _route, extra) => {
      await extra.docTask.onAgentTurnStarted();
      extra.docTask.reportTurn({ finalDelivered: false, delivered: false, lost: false, noticed: false });
      return "completed" as const;
    });
    await createBotTaskHandler({ botUid: "bot-1", store, dispatch })(task());

    expect(store.finish).toHaveBeenCalledWith(41, botTaskDedupeKey(task()), "completed");
    expect(store.retry).not.toHaveBeenCalled();
  });

  it("suppresses an Octo channel final and completes without replaying the task", async () => {
    const store = stateStore();
    const dispatch = vi.fn().mockImplementation(async (_message, _route, extra) => {
      await extra.docTask.onAgentTurnStarted();
      await extra.docTask.postComment("wrong destination", undefined, "final");
      return "completed" as const;
    });
    await createBotTaskHandler({ botUid: "bot-1", store, dispatch })(task());

    expect(store.finish).toHaveBeenCalledWith(
      41,
      botTaskDedupeKey(task()),
      "completed",
    );
    expect(store.retry).not.toHaveBeenCalled();
  });

  it("retries a failure before the Agent turn starts", async () => {
    const store = stateStore();
    const dispatch = vi.fn().mockRejectedValue(new Error("route unavailable"));
    const handle = createBotTaskHandler({ botUid: "bot-1", store, dispatch });

    await expect(handle(task())).rejects.toThrow("route unavailable");
    expect(store.retry).toHaveBeenCalledWith(41, botTaskDedupeKey(task()), expect.any(Error));
    expect(store.finish).not.toHaveBeenCalled();
  });

  it("retries when dispatch reports completed before the Agent turn starts", async () => {
    const store = stateStore();
    const dispatch = vi.fn().mockResolvedValue("completed" as const);
    const handle = createBotTaskHandler({ botUid: "bot-1", store, dispatch });

    await expect(handle(task())).rejects.toThrow("completed before Agent turn started");
    expect(store.started).not.toHaveBeenCalled();
    expect(store.retry).toHaveBeenCalledWith(41, botTaskDedupeKey(task()), expect.any(Error));
    expect(store.finish).not.toHaveBeenCalled();
  });

  it("dead-letters a failure after the Agent turn starts", async () => {
    const store = stateStore();
    const dispatch = vi.fn().mockImplementation(async (_message, _route, extra) => {
      await extra.docTask.onAgentTurnStarted();
      throw new Error("runtime failed");
    });
    const handle = createBotTaskHandler({ botUid: "bot-1", store, dispatch });

    await expect(handle(task())).resolves.toBeUndefined();
    expect(store.finish).toHaveBeenCalledWith(
      41,
      botTaskDedupeKey(task()),
      "dead_letter",
      expect.objectContaining({ message: "runtime failed" }),
    );
    expect(store.retry).not.toHaveBeenCalled();
  });

  it("continues the Agent handoff when the started-boundary state write fails", async () => {
    const errors: string[] = [];
    const store = stateStore({
      started: vi.fn().mockRejectedValue(new Error("state file temporarily unreadable")),
    });
    const runtimeDispatch = vi.fn().mockResolvedValue(undefined);
    const dispatch = vi.fn().mockImplementation(async (_message, _route, extra) => {
      await extra.docTask.onAgentTurnStarted();
      await runtimeDispatch();
      return "completed" as const;
    });
    const handle = createBotTaskHandler({
      botUid: "bot-1",
      store,
      dispatch,
      log: { error: (message) => errors.push(message) },
    });

    await expect(handle(task())).resolves.toBeUndefined();
    await expect(handle(task())).resolves.toBeUndefined();

    expect(runtimeDispatch).toHaveBeenCalledOnce();
    expect(store.retry).not.toHaveBeenCalled();
    expect(store.finish).toHaveBeenCalledWith(41, botTaskDedupeKey(task()), "completed");
    expect(errors.some((message) => message.includes("started-boundary state write failed"))).toBe(true);
  });

  it("dead-letters the final pre-start retry without dispatching again", async () => {
    const store = stateStore({
      begin: vi.fn().mockResolvedValue({ skip: false, attemptCount: 3 }),
    });
    const dispatch = vi.fn().mockRejectedValue(new Error("runtime unavailable"));
    const handle = createBotTaskHandler({ botUid: "bot-1", store, dispatch, maxAttempts: 3 });

    await expect(handle(task())).resolves.toBeUndefined();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(store.finish).toHaveBeenCalledWith(41, botTaskDedupeKey(task()), "dead_letter", expect.any(Error));
  });

  it("does not dispatch an attempt already beyond the retry limit", async () => {
    const store = stateStore({ begin: vi.fn().mockResolvedValue({ skip: false, attemptCount: 4 }) });
    const dispatch = vi.fn();
    await createBotTaskHandler({ botUid: "bot-1", store, dispatch, maxAttempts: 3 })(task());
    expect(dispatch).not.toHaveBeenCalled();
    expect(store.finish).toHaveBeenCalledWith(41, botTaskDedupeKey(task()), "dead_letter", expect.any(Error));
  });

  it("continues with bounded memory state when persistence is unavailable", async () => {
    const errors: string[] = [];
    const store = stateStore({
      begin: vi.fn().mockRejectedValue(new Error("read-only filesystem")),
      finish: vi.fn().mockRejectedValue(new Error("read-only filesystem")),
    });
    const dispatch = vi.fn().mockImplementation(async (_message, _route, extra) => {
      await extra.docTask.onAgentTurnStarted();
      return "completed" as const;
    });
    const handle = createBotTaskHandler({
      botUid: "bot-1",
      store,
      dispatch,
      log: { error: (message) => errors.push(message) },
    });

    await expect(handle(task())).resolves.toBeUndefined();
    await expect(handle(task())).resolves.toBeUndefined();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(errors.some((message) => message.includes("memory-only attempt"))).toBe(true);
  });

  it("does not let a mismatched bot consume a valid task key", async () => {
    const store = stateStore();
    const dispatch = vi.fn().mockImplementation(async (_message, _route, extra) => {
      await extra.docTask.onAgentTurnStarted();
      return "completed" as const;
    });
    const handle = createBotTaskHandler({ botUid: "bot-1", store, dispatch });

    await handle(task({ botUid: "bot-2" }));
    await handle(task());
    expect(store.begin).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("keeps source-defined workflow and makes octo-cli conditional", () => {
    const text = formatBotTaskText(task({ metadata: { anchor: "comment-9" } }));
    expect(text).toContain('metadata={"anchor":"comment-9"}');
    expect(text).toContain("When business data must be read or changed");
    expect(text).toContain("If the task requires a business-facing reply");
    expect(text).not.toContain("previous attempt already committed");
  });
});

describe("bot task state store", () => {
  it("persists terminal state and does not collide across sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "octo-bot-task-"));
    try {
      const first = createFileBotTaskStateStore({ accountId: "Bot-1", baseDir: root });
      const loopKey = botTaskDedupeKey(task({ source: "loop" }));
      const docKey = botTaskDedupeKey(task({ source: "doc" }));
      expect(await first.begin(1, loopKey)).toEqual({ skip: false, attemptCount: 1 });
      await first.finish(1, loopKey, "completed");

      const reopened = createFileBotTaskStateStore({ accountId: "bot-1", baseDir: root });
      expect(await reopened.begin(2, loopKey)).toEqual({ skip: true, attemptCount: 1 });
      expect(await reopened.begin(3, docKey)).toEqual({ skip: false, attemptCount: 1 });
      const raw = JSON.parse(await readFile(join(root, "bot-1", "bot-tasks.state.json"), "utf8"));
      expect(raw.records).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists the Agent-start boundary so a redelivery cannot run it again", async () => {
    const root = await mkdtemp(join(tmpdir(), "octo-bot-task-started-"));
    try {
      const key = botTaskDedupeKey(task());
      const first = createFileBotTaskStateStore({ accountId: "bot-1", baseDir: root });
      expect(await first.begin(1, key)).toEqual({ skip: false, attemptCount: 1 });
      await first.started(1, key);

      const reopened = createFileBotTaskStateStore({ accountId: "bot-1", baseDir: root });
      expect(await reopened.begin(1, key)).toEqual({ skip: true, attemptCount: 1 });
      const raw = JSON.parse(await readFile(join(root, "bot-1", "bot-tasks.state.json"), "utf8"));
      expect(raw.records[0]).toMatchObject({ status: "dead_letter", attemptCount: 1 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("quarantines unreadable state and recovers with an empty store", async () => {
    const root = await mkdtemp(join(tmpdir(), "octo-bot-task-bad-"));
    try {
      const dir = join(root, "bot-1");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "bot-tasks.state.json"), "not-json", "utf8");
      const errors: string[] = [];
      const store = createFileBotTaskStateStore({
        accountId: "bot-1",
        baseDir: root,
        log: { error: (message) => errors.push(message) },
      });
      await expect(store.begin(1, "key")).resolves.toEqual({ skip: false, attemptCount: 1 });
      expect(errors.some((message) => message.includes("starting empty"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["null root", null],
    ["null record", { records: [null] }],
    ["non-array records", { records: {} }],
    ["unknown status", { records: [{ eventId: 1, dedupeKey: "key", status: "bogus", attemptCount: 1, updatedAt: new Date(0).toISOString() }] }],
  ])("quarantines structurally corrupt state with %s", async (_name, payload) => {
    const root = await mkdtemp(join(tmpdir(), "octo-bot-task-structural-"));
    try {
      const dir = join(root, "bot-1");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "bot-tasks.state.json"), `${JSON.stringify(payload)}\n`, "utf8");
      const errors: string[] = [];
      const store = createFileBotTaskStateStore({
        accountId: "bot-1",
        baseDir: root,
        log: { error: (message) => errors.push(message) },
      });
      await expect(store.begin(2, "key")).resolves.toEqual({ skip: false, attemptCount: 1 });
      expect(errors.some((message) => message.includes("starting empty"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
