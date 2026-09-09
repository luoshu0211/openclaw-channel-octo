import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  writeFile: vi.fn(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: fsMocks.writeFile };
});

import { createFileBotTaskStateStore } from "./bot-task-store.js";

describe("bot task state store write failure", () => {
  it("keeps claims, attempt bounds, and terminal state in memory", async () => {
    const root = await mkdtemp(join(tmpdir(), "octo-bot-task-memory-only-"));
    const errors: string[] = [];
    fsMocks.writeFile.mockRejectedValue(new Error("disk full"));
    try {
      const store = createFileBotTaskStateStore({
        accountId: "bot-1",
        baseDir: root,
        log: { error: (message) => errors.push(message) },
      });

      await expect(store.begin(1, "key-1")).resolves.toEqual({
        skip: false,
        attemptCount: 1,
      });
      await expect(store.begin(1, "key-1")).resolves.toEqual({
        skip: false,
        attemptCount: 2,
      });
      await expect(store.finish(1, "key-1", "dead_letter", "failed")).resolves.toBeUndefined();
      await expect(store.begin(1, "key-1")).resolves.toEqual({
        skip: true,
        attemptCount: 2,
      });
      expect(errors.some((message) => message.includes("continuing memory-only"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
