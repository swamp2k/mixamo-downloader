import fs from "node:fs/promises";
import path from "node:path";

const STATE_VERSION = 1;

function freshState() {
  return {
    version: STATE_VERSION,
    completed: {},
    failures: [],
    updatedAt: null,
  };
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  const data = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(tempPath, data, "utf8");
  await fs.rename(tempPath, filePath);
}

export function createStateStore(outputDir) {
  const statePath = path.join(outputDir, ".mixamo-state.json");
  const failuresPath = path.join(outputDir, ".mixamo-failures.json");
  let state = freshState();

  async function load({ reset = false } = {}) {
    await fs.mkdir(outputDir, { recursive: true });

    if (reset) {
      await Promise.allSettled([
        fs.rm(statePath, { force: true }),
        fs.rm(failuresPath, { force: true }),
      ]);
      state = freshState();
      return state;
    }

    try {
      const raw = await fs.readFile(statePath, "utf8");
      const parsed = JSON.parse(raw);
      state = {
        version: STATE_VERSION,
        completed:
          parsed && typeof parsed.completed === "object" && parsed.completed !== null
            ? parsed.completed
            : {},
        failures: Array.isArray(parsed?.failures) ? parsed.failures : [],
        updatedAt: parsed?.updatedAt ?? null,
      };
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error(`Could not read state file ${statePath}: ${error.message}`);
      }
      state = freshState();
    }

    return state;
  }

  async function save() {
    state.updatedAt = new Date().toISOString();
    await atomicWriteJson(statePath, state);
    await atomicWriteJson(failuresPath, state.failures);
  }

  function isCompleted(itemId) {
    return Boolean(state.completed[itemId]);
  }

  async function recordSuccess(item, result) {
    state.completed[item.itemId] = {
      itemId: item.itemId,
      name: item.name,
      page: item.page,
      type: item.isPack ? "animation-pack" : "animation",
      file: result.file,
      bytes: result.bytes,
      completedAt: new Date().toISOString(),
    };

    state.failures = state.failures.filter(
      (failure) => failure.itemId !== item.itemId,
    );

    await save();
  }

  async function recordFailure(item, error, attempts) {
    state.failures = state.failures.filter(
      (failure) => failure.itemId !== item.itemId,
    );

    state.failures.push({
      itemId: item.itemId,
      name: item.name,
      page: item.page,
      index: item.index,
      type: item.isPack ? "animation-pack" : "animation",
      attempts,
      error: String(error?.message ?? error),
      failedAt: new Date().toISOString(),
    });

    await save();
  }

  function getFailures() {
    return [...state.failures];
  }

  function getCompletedCount() {
    return Object.keys(state.completed).length;
  }

  return {
    statePath,
    failuresPath,
    load,
    save,
    isCompleted,
    recordSuccess,
    recordFailure,
    getFailures,
    getCompletedCount,
  };
}
