#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { chromium } from "playwright";

import {
  backoff,
  catalogUrl,
  downloadItem,
  getCatalogItems,
  resetToCatalogPage,
  waitForCatalog,
} from "./mixamo.mjs";
import { createStateStore } from "./state.mjs";

function positiveInteger(value, name, fallback) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function nonNegativeInteger(value, name, fallback) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function parseCli() {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
      profile: { type: "string" },
      "start-page": { type: "string" },
      "end-page": { type: "string" },
      limit: { type: "string" },
      "max-items": { type: "string" },
      attempts: { type: "string" },
      "download-timeout-ms": { type: "string" },
      "selection-timeout-ms": { type: "string" },
      "modal-timeout-ms": { type: "string" },
      "checkbox-timeout-ms": { type: "string" },
      "retry-delay-ms": { type: "string" },
      fps: { type: "string" },
      "in-place": { type: "boolean" },
      "no-in-place": { type: "boolean" },
      "with-skin": { type: "boolean" },
      headless: { type: "boolean" },
      "reset-state": { type: "boolean" },
      "no-final-retry": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
    strict: true,
  });

  if (values.help) {
    console.log(`Mixamo Downloader

Usage:
  npm start -- [options]

Options:
  --output <dir>                 Download/state directory
  --profile <dir>                Persistent Chromium profile
  --start-page <n>               First page (default 1)
  --end-page <n>                 Last page (default 26)
  --limit <n>                    Catalog page size (default 96)
  --max-items <n>                Maximum items per page for a smoke test
  --attempts <n>                 Attempts per item (default 5)
  --download-timeout-ms <n>      Download event timeout (default 90000)
  --in-place / --no-in-place     Desired In Place setting
  --with-skin                    Download with skin
  --fps <n>                      Preferred FPS (default 30)
  --headless                     Run browser headless
  --reset-state                  Clear saved completion/failure state
  --no-final-retry               Skip the final failure-only pass
  -h, --help                     Show this help
`);
    return null;
  }

  const startPage = positiveInteger(values["start-page"], "--start-page", 1);
  const endPage = positiveInteger(values["end-page"], "--end-page", 26);
  if (endPage < startPage) {
    throw new Error("--end-page must be greater than or equal to --start-page.");
  }

  const outputDir = path.resolve(values.output ?? "./mixamo-downloads");
  const profileDir = path.resolve(values.profile ?? "./.mixamo-profile");

  return {
    outputDir,
    downloadDir: path.join(outputDir, "animations"),
    profileDir,
    startPage,
    endPage,
    limit: positiveInteger(values.limit, "--limit", 96),
    maxItems:
      values["max-items"] === undefined
        ? null
        : positiveInteger(values["max-items"], "--max-items"),
    attempts: positiveInteger(values.attempts, "--attempts", 5),
    downloadTimeoutMs: positiveInteger(
      values["download-timeout-ms"],
      "--download-timeout-ms",
      90000,
    ),
    selectionTimeoutMs: positiveInteger(
      values["selection-timeout-ms"],
      "--selection-timeout-ms",
      30000,
    ),
    modalTimeoutMs: positiveInteger(
      values["modal-timeout-ms"],
      "--modal-timeout-ms",
      20000,
    ),
    checkboxTimeoutMs: positiveInteger(
      values["checkbox-timeout-ms"],
      "--checkbox-timeout-ms",
      10000,
    ),
    checkboxAttempts: 5,
    retryDelayMs: nonNegativeInteger(
      values["retry-delay-ms"],
      "--retry-delay-ms",
      1500,
    ),
    fps: positiveInteger(values.fps, "--fps", 30),
    inPlace: values["no-in-place"] ? false : true,
    withSkin: Boolean(values["with-skin"]),
    headless: Boolean(values.headless),
    resetState: Boolean(values["reset-state"]),
    finalRetry: !values["no-final-retry"],
    format: "FBX Binary",
    keyframeReduction: "none",
  };
}

async function ensureCatalogReady(page, config) {
  const url = catalogUrl(config.startPage, config.limit);
  console.log(`Opening Mixamo: ${url}`);
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  try {
    await waitForCatalog(page, 15000);
    return;
  } catch {
    if (config.headless) {
      throw new Error(
        "Mixamo catalog did not appear in headless mode. Run once without --headless so you can log in.",
      );
    }
  }

  console.log("\nMixamo is not ready yet.");
  console.log("Log in to Adobe/Mixamo in the opened Chromium window if needed.");
  console.log("Leave the browser open, then return here and press Enter.\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  await rl.question("Press Enter when Mixamo is ready... ");
  rl.close();

  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await waitForCatalog(page, 90000);
}

async function processItem(page, item, config, stateStore, stopRequested) {
  if (stateStore.isCompleted(item.itemId)) {
    console.log(`  skip: ${item.name}`);
    return true;
  }

  let lastError = null;

  for (let attempt = 1; attempt <= config.attempts; attempt += 1) {
    if (stopRequested()) {
      return false;
    }

    console.log(
      `  [${attempt}/${config.attempts}] ${item.isPack ? "pack" : "animation"}: ${item.name}`,
    );

    try {
      if (attempt > 1) {
        await resetToCatalogPage(
          page,
          item.page,
          config.limit,
          config.selectionTimeoutMs,
        );
      }

      const result = await downloadItem(page, item, config);
      await stateStore.recordSuccess(item, result);
      console.log(`  saved: ${result.file} (${result.bytes} bytes)`);
      return true;
    } catch (error) {
      lastError = error;
      console.warn(`  failed attempt ${attempt}: ${error.message}`);

      if (attempt < config.attempts) {
        await backoff(attempt, config.retryDelayMs);
      }
    }
  }

  await stateStore.recordFailure(item, lastError, config.attempts);
  console.warn(`  recorded failure: ${item.name}`);
  return false;
}

async function runCatalogPass(page, config, stateStore, stopRequested) {
  for (
    let pageNumber = config.startPage;
    pageNumber <= config.endPage;
    pageNumber += 1
  ) {
    if (stopRequested()) {
      break;
    }

    console.log(`\n=== Page ${pageNumber}/${config.endPage} ===`);
    await resetToCatalogPage(
      page,
      pageNumber,
      config.limit,
      config.selectionTimeoutMs,
    );

    let items = await getCatalogItems(page, pageNumber);
    if (config.maxItems !== null) {
      items = items.slice(0, config.maxItems);
    }

    console.log(`Found ${items.length} item(s).`);

    for (const item of items) {
      if (stopRequested()) {
        break;
      }
      await processItem(page, item, config, stateStore, stopRequested);
    }
  }
}

async function runFinalFailurePass(page, config, stateStore, stopRequested) {
  const failures = stateStore
    .getFailures()
    .filter((failure) => !stateStore.isCompleted(failure.itemId))
    .sort((a, b) => a.page - b.page || a.index - b.index);

  if (failures.length === 0 || stopRequested()) {
    return;
  }

  console.log(`\n=== Final failure-only pass (${failures.length}) ===`);

  let loadedPage = null;
  for (const failure of failures) {
    if (stopRequested()) {
      break;
    }

    if (loadedPage !== failure.page) {
      await resetToCatalogPage(
        page,
        failure.page,
        config.limit,
        config.selectionTimeoutMs,
      );
      loadedPage = failure.page;
    }

    const items = await getCatalogItems(page, failure.page);
    const item = items.find((candidate) => candidate.itemId === failure.itemId);

    if (!item) {
      console.warn(
        `  failure-pass: could not re-find ${failure.name} (${failure.itemId}) on page ${failure.page}`,
      );
      continue;
    }

    await processItem(page, item, config, stateStore, stopRequested);
  }
}

async function main() {
  const config = parseCli();
  if (!config) {
    return;
  }

  const stateStore = createStateStore(config.outputDir);
  await stateStore.load({ reset: config.resetState });

  console.log("Mixamo Downloader");
  console.log(`Output:  ${config.outputDir}`);
  console.log(`Profile: ${config.profileDir}`);
  console.log(
    `Pages:   ${config.startPage}-${config.endPage}, ${config.limit}/page, ${config.attempts} attempts/item`,
  );
  console.log(`Resume:  ${stateStore.getCompletedCount()} item(s) already complete`);

  const context = await chromium.launchPersistentContext(config.profileDir, {
    headless: config.headless,
    acceptDownloads: true,
    viewport: null,
  });
  const pages = context.pages();
  const page = pages[0] ?? (await context.newPage());

  let stopping = false;
  const requestStop = () => {
    if (!stopping) {
      stopping = true;
      console.log("\nStop requested. Finishing the current safe boundary...");
    }
  };
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);

  try {
    await ensureCatalogReady(page, config);
    await runCatalogPass(page, config, stateStore, () => stopping);

    if (config.finalRetry && !stopping) {
      await runFinalFailurePass(page, config, stateStore, () => stopping);
    }
  } finally {
    await context.close().catch(() => {});
  }

  const remainingFailures = stateStore
    .getFailures()
    .filter((failure) => !stateStore.isCompleted(failure.itemId));

  console.log("\n=== Summary ===");
  console.log(`Completed: ${stateStore.getCompletedCount()}`);
  console.log(`Failures:  ${remainingFailures.length}`);
  console.log(`State:     ${stateStore.statePath}`);
  console.log(`Failures:  ${stateStore.failuresPath}`);

  if (stopping) {
    console.log("Stopped cleanly. Run the same command to resume.");
    return;
  }

  if (remainingFailures.length > 0) {
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(`\nFatal: ${error.stack || error.message || error}`);
  process.exitCode = 1;
});
