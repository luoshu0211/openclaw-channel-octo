import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { normalizeAccountId } from "./account-id.js";
import { CHANNEL_ID } from "./constants.js";

export type BotTaskStatus =
  | "retrying"
  | "started"
  | "completed"
  | "dead_letter";
export interface BotTaskState {
  eventId: number;
  dedupeKey: string;
  status: BotTaskStatus;
  attemptCount: number;
  lastError?: string;
  updatedAt: string;
}
export interface BotTaskStateStore {
  begin(eventId: number, dedupeKey: string): Promise<{ skip: boolean; attemptCount: number }>;
  started(eventId: number, dedupeKey: string): Promise<void>;
  finish(
    eventId: number,
    dedupeKey: string,
    status: Exclude<BotTaskStatus, "retrying">,
    error?: unknown,
  ): Promise<void>;
  retry(eventId: number, dedupeKey: string, error: unknown): Promise<void>;
}

const BOT_TASK_STATUSES: ReadonlySet<string> = new Set<BotTaskStatus>([
  "retrying",
  "started",
  "completed",
  "dead_letter",
]);

function parseStateRecord(value: unknown, index: number): BotTaskState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SyntaxError(`bot task state record ${index} must be an object`);
  }
  const record = value as Partial<Record<keyof BotTaskState, unknown>>;
  if (!Number.isSafeInteger(record.eventId) || (record.eventId as number) < 0) {
    throw new SyntaxError(`bot task state record ${index} has invalid eventId`);
  }
  if (typeof record.dedupeKey !== "string" || !record.dedupeKey) {
    throw new SyntaxError(`bot task state record ${index} has invalid dedupeKey`);
  }
  if (typeof record.status !== "string" || !BOT_TASK_STATUSES.has(record.status)) {
    throw new SyntaxError(`bot task state record ${index} has invalid status`);
  }
  if (!Number.isSafeInteger(record.attemptCount) || (record.attemptCount as number) < 1) {
    throw new SyntaxError(`bot task state record ${index} has invalid attemptCount`);
  }
  if (typeof record.updatedAt !== "string" || !record.updatedAt) {
    throw new SyntaxError(`bot task state record ${index} has invalid updatedAt`);
  }
  if (record.lastError !== undefined && typeof record.lastError !== "string") {
    throw new SyntaxError(`bot task state record ${index} has invalid lastError`);
  }
  return record as unknown as BotTaskState;
}

export function createFileBotTaskStateStore(params: {
  accountId: string;
  baseDir?: string;
  capacity?: number;
  log?: { error?: (message: string) => void };
}): BotTaskStateStore {
  const capacity = Math.max(1, Math.floor(params.capacity ?? 500));
  const dir = join(params.baseDir ?? join(homedir(), ".openclaw", "workspace", CHANNEL_ID), normalizeAccountId(params.accountId));
  const file = join(dir, "bot-tasks.state.json");
  let cache: Map<string, BotTaskState> | undefined;
  let tail = Promise.resolve();

  const load = async (): Promise<Map<string, BotTaskState>> => {
    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new SyntaxError("bot task state root must be an object");
      }
      const raw = parsed as { records?: unknown };
      if (raw.records !== undefined && !Array.isArray(raw.records)) {
        throw new SyntaxError("bot task state records must be an array");
      }
      const records = (raw.records ?? []).map(parseStateRecord);
      return new Map(records.map((record) => [record.dedupeKey, record]));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return new Map();
      if (error instanceof SyntaxError) {
        params.log?.error?.(`octo: failed to parse bot task state ${file}; starting empty: ${String(error)}`);
        try {
          await rename(file, `${file}.corrupt-${Date.now()}`);
        } catch (renameError) {
          params.log?.error?.(`octo: failed to quarantine bot task state ${file}: ${String(renameError)}`);
        }
        return new Map();
      }
      // A transient read error does not prove the state is corrupt. Do not
      // rename or overwrite a healthy file; the handler can execute this
      // delivery with its in-process attempt floor and try loading again later.
      params.log?.error?.(`octo: failed to load bot task state ${file}: ${String(error)}`);
      throw error;
    }
  };
  const mutate = async <T>(fn: (records: Map<string, BotTaskState>) => T | Promise<T>): Promise<T> => {
    let result!: T;
    const run = tail.then(async () => {
      cache ??= await load();
      result = await fn(cache);
      const records = [...cache.values()].slice(-capacity);
      // Advance memory before durable I/O on purpose. If the filesystem write
      // fails, this process still retains the attempt count and keeps retries
      // bounded instead of reopening an unbounded side-effect loop.
      cache = new Map(records.map((record) => [record.dedupeKey, record]));
      try {
        await mkdir(dir, { recursive: true });
        const tmp = join(dir, `.bot-tasks.${process.pid}.${randomUUID()}.tmp`);
        let renamed = false;
        try {
          await writeFile(tmp, `${JSON.stringify({ records })}\n`, "utf8");
          await rename(tmp, file);
          renamed = true;
        } finally {
          if (!renamed) await rm(tmp, { force: true }).catch(() => {});
        }
      } catch (error) {
        // The mutation already lives in cache. Keep serving from that
        // in-process state so a full disk cannot either drop the task before
        // dispatch or reopen an unbounded side-effect loop.
        params.log?.error?.(
          `octo: failed to persist bot task state ${file}; continuing memory-only: ${String(error)}`,
        );
      }
    });
    tail = run.then(() => undefined, () => undefined);
    await run;
    return result;
  };
  const state = (eventId: number, dedupeKey: string, status: BotTaskStatus, attemptCount: number, error?: unknown): BotTaskState => ({
    eventId,
    dedupeKey,
    status,
    attemptCount,
    ...(error === undefined ? {} : { lastError: String(error).slice(0, 1000) }),
    updatedAt: new Date().toISOString(),
  });
  const upsert = (records: Map<string, BotTaskState>, key: string, value: BotTaskState): void => {
    // Refresh insertion order so capacity eviction keeps the most recently touched records.
    records.delete(key);
    records.set(key, value);
  };
  return {
    begin: (eventId, dedupeKey) => mutate((records) => {
      const previous = records.get(dedupeKey);
      if (previous?.status === "started") {
        upsert(records, dedupeKey, state(
          eventId,
          dedupeKey,
          "dead_letter",
          previous.attemptCount,
          "recovered a task already handed to the Agent; automatic replay disabled",
        ));
        return { skip: true, attemptCount: previous.attemptCount };
      }
      if (previous && previous.status !== "retrying") {
        return { skip: true, attemptCount: previous.attemptCount };
      }
      const attemptCount = (previous?.attemptCount ?? 0) + 1;
      upsert(records, dedupeKey, state(eventId, dedupeKey, "retrying", attemptCount));
      return { skip: false, attemptCount };
    }),
    started: (eventId, dedupeKey) => mutate((records) => {
      const attempts = records.get(dedupeKey)?.attemptCount ?? 1;
      upsert(records, dedupeKey, state(eventId, dedupeKey, "started", attempts));
    }),
    finish: (eventId, dedupeKey, status, error) => mutate((records) => {
      const attempts = records.get(dedupeKey)?.attemptCount ?? 1;
      upsert(records, dedupeKey, state(eventId, dedupeKey, status, attempts, error));
    }),
    retry: (eventId, dedupeKey, error) => mutate((records) => {
      const attempts = records.get(dedupeKey)?.attemptCount ?? 1;
      upsert(records, dedupeKey, state(eventId, dedupeKey, "retrying", attempts, error));
    }),
  };
}
