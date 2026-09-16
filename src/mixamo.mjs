import fs from "node:fs/promises";
import path from "node:path";

export const CARD_SELECTOR = [
  ".product-results-holder .product-list .product-animation",
  ".product-results-holder .product-list .product-animation-pack",
].join(", ");

const MODAL_SELECTOR = [
  ".static-modal .modal:visible",
  ".modal.in:visible",
  ".modal[role='dialog']:visible",
  ".static-modal:visible",
].join(", ");

export function catalogUrl(pageNumber, limit = 96) {
  return `https://www.mixamo.com/#/?page=${pageNumber}&type=Motion%2CMotionPack&limit=${limit}`;
}

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFilename(value) {
  const cleaned = String(value ?? "download")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  return cleaned || "download";
}

async function uniqueDestination(directory, suggestedFilename) {
  await fs.mkdir(directory, { recursive: true });
  const parsed = path.parse(sanitizeFilename(suggestedFilename));
  let candidate = path.join(directory, `${parsed.name}${parsed.ext}`);
  let counter = 2;

  while (true) {
    try {
      await fs.access(candidate);
      candidate = path.join(
        directory,
        `${parsed.name} (${counter})${parsed.ext}`,
      );
      counter += 1;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return candidate;
      }
      throw error;
    }
  }
}

export async function waitForCatalog(page, timeoutMs = 30000) {
  await page.locator(CARD_SELECTOR).first().waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
}

export async function getCatalogItems(page, pageNumber) {
  return page.locator(CARD_SELECTOR).evaluateAll((cards, currentPage) => {
    const normalize = (value) =>
      String(value ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();

    return cards.map((card, index) => {
      const image = card.querySelector(".product-image img");
      const name =
        card.querySelector(".product-info p")?.textContent?.trim() ||
        `Mixamo Item ${index + 1}`;
      const description =
        card.querySelector(".product-metadata li")?.textContent?.trim() || "";
      const thumbnailUrl = image?.src || "";
      const isPack = card.classList.contains("product-animation-pack");
      const motionMatch = thumbnailUrl.match(
        /\/motions\/([^/]+)\/animated\.(?:gif|png|jpg|jpeg)/i,
      );
      const packMatch = thumbnailUrl.match(
        /\/motion_packs\/([^/]+)\/animated\.(?:gif|png|jpg|jpeg)/i,
      );
      const animationCount = isPack
        ? Number.parseInt(
            card.querySelector(".product-count")?.textContent?.trim() || "",
            10,
          ) || null
        : 1;

      let itemId;
      if (isPack) {
        itemId = `pack:${packMatch?.[1] || normalize(name)}`;
      } else if (motionMatch?.[1]) {
        itemId = `motion:${motionMatch[1]}`;
      } else if (thumbnailUrl) {
        itemId = `motion-url:${thumbnailUrl}`;
      } else {
        itemId = `item:${currentPage}:${index}:${normalize(name)}`;
      }

      return {
        page: currentPage,
        index,
        itemId,
        isPack,
        animationCount,
        name,
        description,
        thumbnailUrl,
      };
    });
  }, pageNumber);
}

async function selectedItemName(page) {
  return (
    (await page
      .locator(".product-preview-holder .product-nav h2")
      .first()
      .textContent()
      .catch(() => "")) || ""
  ).trim();
}

async function findLiveItemIndex(page, itemId, pageNumber) {
  const items = await getCatalogItems(page, pageNumber);
  return items.findIndex((candidate) => candidate.itemId === itemId);
}

async function mainDownloadButton(page) {
  const preview = page.locator(".product-preview-holder");
  const exact = preview.getByRole("button", { name: "Download", exact: true });
  if ((await exact.count()) > 0) {
    return exact.first();
  }

  const buttons = preview.locator(".editor-sidebar .sidebar-header button");
  const count = await buttons.count();
  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    if (normalizeText(await button.textContent()) === "download") {
      return button;
    }
  }

  return null;
}

export async function selectCatalogItem(page, item, options = {}) {
  const selectionTimeoutMs = options.selectionTimeoutMs ?? 30000;
  const liveIndex = await findLiveItemIndex(page, item.itemId, item.page);
  if (liveIndex < 0) {
    throw new Error(`Could not re-find "${item.name}" in the current catalog.`);
  }

  const card = page.locator(CARD_SELECTOR).nth(liveIndex);
  await card.scrollIntoViewIfNeeded();
  await delay(350);

  const previousName = await selectedItemName(page);
  const previousNormalized = normalizeText(previousName);
  const expectedNormalized = normalizeText(item.name);

  const targetSelectors = [
    ".product-image",
    ".product-overlay",
    ".product-description",
  ];

  let clicked = false;
  for (const selector of targetSelectors) {
    const target = card.locator(selector).first();
    if ((await target.count()) === 0) {
      continue;
    }

    try {
      await target.click({ timeout: 5000 });
      clicked = true;
      break;
    } catch {
      // Try the next live click target after React has had a chance to rerender.
    }
  }

  if (!clicked) {
    await card.click({ force: true, timeout: 5000 });
  }

  await page.waitForFunction(
    ({ expected, previous }) => {
      const title = document
        .querySelector(".product-preview-holder .product-nav h2")
        ?.textContent?.replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (!title || title === "default character") {
        return false;
      }

      const buttons = [
        ...document.querySelectorAll(
          ".product-preview-holder .editor-sidebar .sidebar-header button",
        ),
      ];
      const hasDownload = buttons.some(
        (button) =>
          button.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ===
          "download",
      );
      if (!hasDownload) {
        return false;
      }

      const exact = title === expected;
      const partial = title.includes(expected) || expected.includes(title);
      const changed = Boolean(previous) && title !== previous;
      return exact || partial || changed;
    },
    { expected: expectedNormalized, previous: previousNormalized },
    { timeout: selectionTimeoutMs },
  );

  await delay(700);
}

export async function ensureInPlace(page, desiredState, options = {}) {
  const attempts = options.checkboxAttempts ?? 5;
  const verifyTimeoutMs = options.checkboxTimeoutMs ?? 10000;
  const backoffBaseMs = options.retryDelayMs ?? 1500;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const checkbox = page.locator('input[name="inplace"]').first();
    if ((await checkbox.count()) === 0) {
      return { available: false, value: null };
    }

    if ((await checkbox.isChecked().catch(() => !desiredState)) === desiredState) {
      return { available: true, value: desiredState };
    }

    try {
      if (desiredState) {
        await checkbox.check({ force: true, timeout: 5000 });
      } else {
        await checkbox.uncheck({ force: true, timeout: 5000 });
      }

      await page.waitForFunction(
        (desired) => {
          const live = document.querySelector('input[name="inplace"]');
          return Boolean(live) && live.checked === desired;
        },
        desiredState,
        { timeout: verifyTimeoutMs },
      );

      return { available: true, value: desiredState };
    } catch (firstError) {
      try {
        await page.evaluate((desired) => {
          const live = document.querySelector('input[name="inplace"]');
          if (!live || live.checked === desired) {
            return;
          }
          live.click();
        }, desiredState);

        await page.waitForFunction(
          (desired) => {
            const live = document.querySelector('input[name="inplace"]');
            return Boolean(live) && live.checked === desired;
          },
          desiredState,
          { timeout: Math.min(verifyTimeoutMs, 5000) },
        );

        return { available: true, value: desiredState };
      } catch {
        if (attempt === attempts) {
          throw new Error(
            `In Place did not become ${desiredState} after ${attempts} attempts: ${firstError.message}`,
          );
        }
      }
    }

    await delay(Math.min(backoffBaseMs * attempt, 8000));
  }

  throw new Error(`Could not set In Place=${desiredState}.`);
}

async function visibleModal(page, timeoutMs = 20000) {
  const modal = page.locator(MODAL_SELECTOR).first();
  await modal.waitFor({ state: "visible", timeout: timeoutMs });
  return modal;
}

async function openDownloadModal(page, timeoutMs = 20000) {
  const button = await mainDownloadButton(page);
  if (!button) {
    throw new Error("Could not find the main preview Download button.");
  }

  await button.click({ timeout: timeoutMs });
  return visibleModal(page, timeoutMs);
}

async function findSelectByHints(modal, hints) {
  const wanted = hints.map(normalizeText);
  const selects = modal.locator("select");
  const count = await selects.count();

  for (let index = 0; index < count; index += 1) {
    const select = selects.nth(index);
    const optionTexts = (await select.locator("option").allTextContents()).map(
      normalizeText,
    );
    if (
      wanted.some((wantedText) =>
        optionTexts.some((available) => available.includes(wantedText)),
      )
    ) {
      return select;
    }
  }

  return null;
}

async function chooseOption(select, desiredTexts, settingName) {
  if (!select) {
    console.log(`  ${settingName}: control unavailable; keeping current value`);
    return false;
  }

  const desired = desiredTexts.map(normalizeText);
  const options = await select.locator("option").evaluateAll((nodes) =>
    nodes.map((node) => ({
      text: node.textContent?.trim() || "",
      value: node.value,
    })),
  );

  const match = options.find((option) => {
    const optionText = normalizeText(option.text);
    return desired.some(
      (wanted) =>
        optionText === wanted ||
        optionText.includes(wanted) ||
        wanted.includes(optionText),
    );
  });

  if (!match) {
    console.log(
      `  ${settingName}: requested value unavailable; keeping current value (${options
        .map((option) => option.text)
        .join(" | ")})`,
    );
    return false;
  }

  await select.selectOption({ value: match.value });
  await delay(450);
  console.log(`  ${settingName}: ${match.text}`);
  return true;
}

async function configureDownloadModal(page, config) {
  let modal = await visibleModal(page, config.modalTimeoutMs);
  await chooseOption(
    await findSelectByHints(modal, ["fbx binary", "fbx", "collada", "dae"]),
    [config.format],
    "Format",
  );

  modal = await visibleModal(page, config.modalTimeoutMs);
  await chooseOption(
    await findSelectByHints(modal, ["with skin", "without skin"]),
    config.withSkin ? ["With Skin"] : ["Without Skin"],
    "Skin",
  );

  modal = await visibleModal(page, config.modalTimeoutMs);
  await chooseOption(
    await findSelectByHints(modal, [
      "24 fps",
      "30 fps",
      "60 fps",
      "frames per second",
    ]),
    [`${config.fps} FPS`, String(config.fps)],
    "Frames per Second",
  );

  const reductionOptions = {
    none: ["None", "No Keyframe Reduction"],
    uniform: ["Uniform"],
    "non-uniform": ["Non-uniform", "Non Uniform"],
  };

  modal = await visibleModal(page, config.modalTimeoutMs);
  await chooseOption(
    await findSelectByHints(modal, [
      "no keyframe reduction",
      "keyframe reduction",
      "uniform",
      "non-uniform",
      "non uniform",
      "none",
    ]),
    reductionOptions[config.keyframeReduction] ?? reductionOptions.none,
    "Keyframe Reduction",
  );
}

async function finalDownloadButton(page, timeoutMs) {
  const modal = await visibleModal(page, timeoutMs);
  const buttons = modal.locator("button:visible, .btn:visible");
  const count = await buttons.count();

  for (let index = 0; index < count; index += 1) {
    const button = buttons.nth(index);
    const text = normalizeText(await button.textContent());
    if (text === "download" || text.includes("download")) {
      return button;
    }
  }

  const fallback = modal.locator(".modal-footer .btn-primary:visible").first();
  return (await fallback.count()) > 0 ? fallback : null;
}

export async function dismissTransientUi(page) {
  await page.keyboard.press("Escape").catch(() => {});
  await delay(250);
}

export async function downloadItem(page, item, config) {
  await selectCatalogItem(page, item, config);

  const inPlace = await ensureInPlace(page, config.inPlace, config);
  console.log(
    inPlace.available
      ? `  In Place: ${inPlace.value}`
      : "  In Place: unavailable for this item",
  );

  await openDownloadModal(page, config.modalTimeoutMs);
  await configureDownloadModal(page, config);

  const button = await finalDownloadButton(page, config.modalTimeoutMs);
  if (!button) {
    throw new Error(`Could not find the final Download button for "${item.name}".`);
  }

  const downloadPromise = page.waitForEvent("download", {
    timeout: config.downloadTimeoutMs,
  });

  await button.click({ timeout: config.modalTimeoutMs });
  const download = await downloadPromise;
  const browserError = await download.failure();
  if (browserError) {
    throw new Error(`Browser download failed: ${browserError}`);
  }

  const destination = await uniqueDestination(
    config.downloadDir,
    download.suggestedFilename(),
  );
  await download.saveAs(destination);

  const stat = await fs.stat(destination);
  if (!stat.isFile() || stat.size <= 0) {
    throw new Error(`Downloaded file is empty: ${destination}`);
  }

  return {
    file: path.relative(config.outputDir, destination),
    absoluteFile: destination,
    bytes: stat.size,
  };
}

export async function resetToCatalogPage(page, pageNumber, limit, timeoutMs) {
  await dismissTransientUi(page);
  await page.goto(catalogUrl(pageNumber, limit), {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await waitForCatalog(page, timeoutMs);
}

export async function backoff(attempt, baseMs = 1500) {
  await delay(Math.min(baseMs * attempt, 10000));
}
