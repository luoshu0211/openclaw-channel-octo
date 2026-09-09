import type { BotMessage } from "./types.js";
import { botTaskDedupeKey, botTaskSessionScope, synthesizeBotTaskMessage, type BotTask } from "./bot-task.js";
import type { BotTaskStateStore } from "./bot-task-store.js";
import type { DocTaskTurnReport } from "./doc-mention-handler.js";

type BotTaskDispatch = (
  message: BotMessage,
  routeOverride: undefined,
  extra: {
    queueScope: string;
    docTask: {
      docId: string;
      threadId: string;
      sessionScope: string;
      abortOnTimeout?: boolean;
      onAgentTurnStarted?: () => void | Promise<void>;
      postComment: (
        text: string,
        signal?: AbortSignal,
        intent?: "progress" | "final" | "notice",
      ) => Promise<void>;
      reportTurn: (report: DocTaskTurnReport) => void;
    };
  },
) => Promise<"completed" | "dropped">;

export class RetryableBotTaskError extends Error {
  readonly attemptCount: number;
  readonly cause: unknown;

  constructor(error: unknown, attemptCount: number) {
    super(error instanceof Error ? error.message : String(error));
    this.name = "RetryableBotTaskError";
    this.attemptCount = attemptCount;
    this.cause = error;
  }
}

export function createBotTaskHandler(deps: {
  botUid: string;
  store: BotTaskStateStore;
  dispatch: BotTaskDispatch;
  maxAttempts?: number;
  memoryStateCapacity?: number;
  log?: { info?: (message: string) => void; error?: (message: string) => void };
}) {
  const maxAttempts = Math.max(1, Math.floor(deps.maxAttempts ?? 3));
  const memoryStateCapacity = Math.max(1, Math.floor(deps.memoryStateCapacity ?? 500));
  // Durable state remains authoritative when available. This floor keeps the
  // retry bound and terminal decisions intact while the state path is
  // temporarily unreadable; it also covers write failures until restart.
  const attemptFloor = new Map<string, number>();
  const terminalFallback = new Set<string>();
  const remember = (key: string, attemptCount: number, terminal = false): void => {
    attemptFloor.delete(key);
    attemptFloor.set(key, attemptCount);
    if (terminal) terminalFallback.add(key);
    while (attemptFloor.size > memoryStateCapacity) {
      const oldest = attemptFloor.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      attemptFloor.delete(oldest);
      terminalFallback.delete(oldest);
    }
  };
  return async (task: BotTask): Promise<void> => {
    const dedupeKey = botTaskDedupeKey(task);
    if (task.botUid !== deps.botUid) {
      deps.log?.error?.(`octo: bot task ${task.eventId} targets ${task.botUid}, current bot is ${deps.botUid}`);
      return;
    }
    if (terminalFallback.has(dedupeKey)) {
      deps.log?.info?.(`octo: bot task ${task.eventId} already terminal in memory, skipped`);
      return;
    }
    let claim: Awaited<ReturnType<BotTaskStateStore["begin"]>>;
    const nextMemoryAttempt = (attemptFloor.get(dedupeKey) ?? 0) + 1;
    try {
      claim = await deps.store.begin(task.eventId, dedupeKey);
    } catch (error) {
      claim = { skip: false, attemptCount: nextMemoryAttempt };
      deps.log?.error?.(
        `octo: bot task ${task.eventId} state begin failed; continuing with memory-only attempt ${claim.attemptCount}: ${String(error)}`,
      );
    }
    if (claim.skip) {
      remember(dedupeKey, claim.attemptCount, true);
      deps.log?.info?.(`octo: bot task ${task.eventId} already terminal, skipped`);
      return;
    }
    claim.attemptCount = Math.max(claim.attemptCount, nextMemoryAttempt);
    remember(dedupeKey, claim.attemptCount);
    if (claim.attemptCount > maxAttempts) {
      const error = new Error(
        `bot task retry limit already exceeded before dispatch (${claim.attemptCount} > ${maxAttempts})`,
      );
      remember(dedupeKey, claim.attemptCount, true);
      try {
        await deps.store.finish(task.eventId, dedupeKey, "dead_letter", error);
      } catch (storeError) {
        deps.log?.error?.(
          `octo: bot task ${task.eventId} over-limit dead-letter state write failed; retained terminally in memory: ${String(storeError)}`,
        );
      }
      return;
    }
    const scope = botTaskSessionScope(task);
    let agentTurnStarted = false;
    let suppressedFinal = false;
    try {
      const result = await deps.dispatch(
        synthesizeBotTaskMessage(task, deps.botUid, claim.attemptCount),
        undefined,
        {
          queueScope: scope,
          // Reuse the external-task egress fence: generated channel text is swallowed.
          // A business-facing reply, when the source prompt requires one, must use that
          // source's octo-cli command instead of leaking into an Octo IM conversation.
          docTask: {
            docId: task.source,
            threadId: task.sessionKey,
            sessionScope: scope,
            abortOnTimeout: true,
            onAgentTurnStarted: async () => {
              // This callback is the at-most-once boundary immediately before
              // inbound invokes the Agent runtime. A transient state-file
              // failure must not turn into an ACKed task that never ran: keep
              // the boundary in memory and continue the handoff. Restarting in
              // this degraded window retains the documented ambiguity risk.
              try {
                await deps.store.started(task.eventId, dedupeKey);
              } catch (error) {
                deps.log?.error?.(
                  `octo: bot task ${task.eventId} started-boundary state write failed; continuing memory-only: ${String(error)}`,
                );
              }
              remember(dedupeKey, claim.attemptCount, true);
              agentTurnStarted = true;
            },
            postComment: async (text, _signal, intent) => {
              if (intent === "final" && text.trim()) suppressedFinal = true;
            },
            reportTurn: () => {},
          },
        },
      );
      if (result !== "completed") throw new Error(`bot task dispatch ${result}`);
      // `handleInboundMessage` can return normally before the Agent runtime is
      // reached (for example when the runtime surface is missing or route
      // resolution fails). The channel wrapper maps every normal return to
      // `completed`, so require our own handoff witness before ACKing success.
      if (!agentTurnStarted) {
        throw new Error("bot task dispatch completed before Agent turn started");
      }
      if (suppressedFinal) {
        deps.log?.error?.(
          `octo: bot task ${task.eventId} emitted a channel final; it was suppressed because business-facing replies must use the source-specific CLI`,
        );
      }

      remember(dedupeKey, claim.attemptCount, true);
      try {
        await deps.store.finish(task.eventId, dedupeKey, "completed");
      } catch (error) {
        deps.log?.error?.(`octo: bot task ${task.eventId} completion state write failed; event will be acknowledged: ${String(error)}`);
        return;
      }
      deps.log?.info?.(
        `octo: bot task ${task.eventId} completed source=${task.source} task_type=${task.taskType}` +
          ` actor=${task.actorUid}`,
      );
    } catch (error) {
      // Once the turn has been handed to the Agent, the plugin cannot know
      // whether a business side effect committed. Never infer that from tool
      // calls or transcript shape and never replay it automatically.
      const terminal = agentTurnStarted || claim.attemptCount >= maxAttempts;
      if (terminal) {
        remember(dedupeKey, claim.attemptCount, true);
        try {
          await deps.store.finish(task.eventId, dedupeKey, "dead_letter", error);
        } catch (storeError) {
          deps.log?.error?.(`octo: bot task ${task.eventId} dead-letter state write failed; event will be acknowledged: ${String(storeError)}`);
          return;
        }
        deps.log?.error?.(
          `octo: bot task ${task.eventId} dead-lettered after ${claim.attemptCount} attempt(s)` +
            ` actor=${task.actorUid}` +
            `${agentTurnStarted ? " (agent turn started; automatic replay disabled)" : " (retry limit reached)"}: ${String(error)}`,
        );
        return;
      }
      try {
        await deps.store.retry(task.eventId, dedupeKey, error);
      } catch (storeError) {
        // begin() has already advanced the in-memory attempt count, so retrying
        // remains bounded even when this diagnostic write fails.
        deps.log?.error?.(`octo: bot task ${task.eventId} retry state write failed; event remains retryable: ${String(storeError)}`);
      }
      throw new RetryableBotTaskError(error, claim.attemptCount);
    }
  };
}
