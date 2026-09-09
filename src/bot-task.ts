import { ChannelType, MessageType, type BotMessage } from "./types.js";
import type { BotEvent } from "./card-action.js";

export interface BotTask {
  eventId: number;
  source: string;
  taskType: string;
  idempotencyKey: string;
  botUid: string;
  actorUid: string;
  sessionKey: string;
  prompt: string;
  context: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  enqueuedAt?: number;
}

const MAX_PROMPT_LENGTH = 24 * 1024;
const MAX_CONTEXT_LENGTH = 24 * 1024;
const MAX_METADATA_LENGTH = 8 * 1024;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_TASK_TYPE_LENGTH = 128;
// The server contract uses Unix epoch seconds. Keep a generous upper bound
// (year 3000) while rejecting millisecond timestamps and non-positive values.
const MAX_ENQUEUED_AT_SECONDS = 32_503_680_000;

export type BotTaskParseResult =
  | { ok: true; task: BotTask }
  | { ok: false; reason: string };

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function jsonByteLength(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? Buffer.byteLength(serialized, "utf8") : null;
  } catch {
    // JSON.parse accepts nesting depths that JSON.stringify may reject with a
    // RangeError. Treat every serialization failure as an invalid envelope;
    // callers must never lose the event-drain loop to an untrusted payload.
    return null;
  }
}

/** Parse only the stable transport schema. source/taskType remain opaque. */
export function parseBotTaskResult(event: BotEvent): BotTaskParseResult {
  if (!Number.isSafeInteger(event.event_id) || event.event_id < 0 || event.event_type !== "bot_task") {
    return { ok: false, reason: "invalid event envelope" };
  }
  const data = objectValue(event.event_data);
  if (!data) return { ok: false, reason: "event_data must be an object" };
  const context = data.context == null ? {} : objectValue(data.context);
  const source = stringValue(data.source);
  const taskType = stringValue(data.task_type);
  const idempotencyKey = stringValue(data.idempotency_key);
  const botUid = stringValue(data.bot_uid);
  const actorUid = stringValue(data.actor_uid);
  const sessionKey = stringValue(data.session_key);
  const prompt = typeof data.prompt === "string" ? data.prompt : "";
  if (!source) return { ok: false, reason: "source must be a non-empty string" };
  if (!taskType) return { ok: false, reason: "task_type must be a non-empty string" };
  if (!idempotencyKey) return { ok: false, reason: "idempotency_key must be a non-empty string" };
  if (!botUid) return { ok: false, reason: "bot_uid must be a non-empty string" };
  if (!actorUid) return { ok: false, reason: "actor_uid must be a non-empty string" };
  if (!sessionKey) return { ok: false, reason: "session_key must be a non-empty string" };
  for (const [name, value, max] of [
    ["source", source, MAX_IDENTIFIER_LENGTH],
    ["task_type", taskType, MAX_TASK_TYPE_LENGTH],
    ["idempotency_key", idempotencyKey, MAX_IDENTIFIER_LENGTH],
    ["bot_uid", botUid, MAX_IDENTIFIER_LENGTH],
    ["actor_uid", actorUid, MAX_IDENTIFIER_LENGTH],
    ["session_key", sessionKey, MAX_IDENTIFIER_LENGTH],
  ] as const) {
    if (Buffer.byteLength(value, "utf8") > max) {
      return { ok: false, reason: `${name} exceeds ${max} bytes` };
    }
  }
  if (!prompt.trim()) return { ok: false, reason: "prompt must be a non-empty string" };
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_LENGTH) {
    return { ok: false, reason: `prompt exceeds ${MAX_PROMPT_LENGTH} bytes` };
  }
  if (!context) return { ok: false, reason: "context must be an object" };
  const contextBytes = jsonByteLength(context);
  if (contextBytes === null) return { ok: false, reason: "context must be JSON-serializable" };
  if (contextBytes > MAX_CONTEXT_LENGTH) {
    return { ok: false, reason: `context exceeds ${MAX_CONTEXT_LENGTH} bytes` };
  }
  const task: BotTask = {
    eventId: event.event_id,
    source,
    taskType,
    idempotencyKey,
    botUid,
    actorUid,
    sessionKey,
    prompt,
    context,
  };
  if (data.metadata != null) {
    const metadata = objectValue(data.metadata);
    if (!metadata) return { ok: false, reason: "metadata must be an object" };
    const metadataBytes = jsonByteLength(metadata);
    if (metadataBytes === null) return { ok: false, reason: "metadata must be JSON-serializable" };
    if (metadataBytes > MAX_METADATA_LENGTH) {
      return { ok: false, reason: `metadata exceeds ${MAX_METADATA_LENGTH} bytes` };
    }
    task.metadata = metadata;
  }
  if (data.enqueued_at != null) {
    if (
      !Number.isSafeInteger(data.enqueued_at) ||
      (data.enqueued_at as number) <= 0 ||
      (data.enqueued_at as number) > MAX_ENQUEUED_AT_SECONDS
    ) {
      return { ok: false, reason: "enqueued_at must be a positive Unix timestamp in seconds" };
    }
    task.enqueuedAt = data.enqueued_at as number;
  }
  return { ok: true, task };
}

export function parseBotTask(event: BotEvent): BotTask | null {
  const result = parseBotTaskResult(event);
  return result.ok ? result.task : null;
}

function escapeScope(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

export function botTaskSessionScope(task: BotTask): string {
  return `octo:bot-task:${escapeScope(task.botUid)}:${escapeScope(task.source)}:${escapeScope(task.sessionKey)}`;
}

/** The server scopes idempotency by source + bot + key; account storage already scopes by bot. */
export function botTaskDedupeKey(task: BotTask): string {
  return JSON.stringify([task.source, task.idempotencyKey]);
}

export function formatBotTaskText(task: BotTask, attempt = 1): string {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  return [
    "[Octo bot task]",
    `source=${JSON.stringify(task.source)}`,
    `task_type=${JSON.stringify(task.taskType)}`,
    `idempotency_key=${JSON.stringify(task.idempotencyKey)}`,
    `attempt=${normalizedAttempt}`,
    `context=${JSON.stringify(task.context)}`,
    ...(task.metadata === undefined ? [] : [`metadata=${JSON.stringify(task.metadata)}`]),
    "",
    task.prompt,
    "",
    "This is an external business task. When business data must be read or changed, use the source-specific octo-cli commands.",
    "If the task requires a business-facing reply, send it through the source-specific octo-cli command.",
    "Do not send the result to an Octo IM conversation; reply through octo-cli exactly as instructed above.",
    "After all required octo-cli actions succeed, end the turn with exactly NO_REPLY and no other final text.",
  ].join("\n");
}

export function synthesizeBotTaskMessage(
  task: BotTask,
  botUid: string,
  attempt = 1,
): BotMessage {
  return {
    // OpenClaw has its own inbound-message dedupe. Transport retries must use a
    // distinct delivery id or attempts 2..N are dropped before the Agent runs.
    // The task idempotency key remains stable in BotTaskStateStore.
    message_id: `bot_task:${task.eventId}:attempt:${Math.max(1, Math.floor(attempt))}`,
    message_seq: 0,
    from_uid: task.actorUid,
    channel_id: task.actorUid,
    channel_type: ChannelType.DM,
    timestamp: task.enqueuedAt ?? Math.floor(Date.now() / 1000),
    payload: {
      type: MessageType.Text,
      content: formatBotTaskText(task, attempt),
      mention: { uids: [botUid] },
    },
  };
}
