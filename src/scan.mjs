#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

function parseCli() {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
      "small-threshold": { type: "string" },
      report: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
    strict: true,
  });

  if (values.help) {
    console.log(`Mixamo Library Scanner\n\nUsage:\n  npm run scan -- --output ./mixamo\n\nOptions:\n  --output <dir>          Downloader output directory (default ./mixamo)\n  --small-threshold <n>   Flag FBX files smaller than n bytes (default 100000)\n  --report <file>         JSON report path (default <output>/mixamo-scan.json)\n  -h, --help              Show help\n`);
    return null;
  }

  const outputDir = path.resolve(values.output ?? "./mixamo");
  const smallThreshold = Number.parseInt(values["small-threshold"] ?? "100000", 10);
  if (!Number.isInteger(smallThreshold) || smallThreshold < 0) {
    throw new Error("--small-threshold must be a non-negative integer.");
  }

  return {
    outputDir,
    animationsDir: path.join(outputDir, "animations"),
    statePath: path.join(outputDir, ".mixamo-state.json"),
    reportPath: path.resolve(values.report ?? path.join(outputDir, "mixamo-scan.json")),
    smallThreshold,
  };
}

function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = "B";
  for (const candidate of units) {
    value /= 1024;
    unit = candidate;
    if (value < 1024) break;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

async function walk(dir) {
  const files = [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function logicalBaseName(filename) {
  const parsed = path.parse(filename);
  return parsed.name.replace(/ \((\d+)\)$/u, "");
}

function rel(outputDir, filePath) {
  return path.relative(outputDir, filePath).split(path.sep).join("/");
}

async function loadState(statePath) {
  try {
    return JSON.parse(await fsp.readFile(statePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Could not read ${statePath}: ${error.message}`);
  }
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

async function main() {
  const config = parseCli();
  if (!config) return;

  console.log("Mixamo Library Scanner");
  console.log(`Output:     ${config.outputDir}`);
  console.log(`Animations: ${config.animationsDir}`);

  const allPaths = await walk(config.animationsDir);
  allPaths.sort((a, b) => a.localeCompare(b));

  const allDiskFiles = [];
  for (const filePath of allPaths) {
    const stat = await fsp.stat(filePath);
    allDiskFiles.push({
      file: rel(config.outputDir, filePath),
      filename: path.basename(filePath),
      extension: path.extname(filePath).toLowerCase(),
      bytes: stat.size,
    });
  }

  const fbxDiskFiles = allDiskFiles.filter((item) => item.extension === ".fbx");
  const zipDiskFiles = allDiskFiles.filter((item) => item.extension === ".zip");

  const records = [];
  let totalBytes = 0;
  for (let index = 0; index < fbxDiskFiles.length; index += 1) {
    const disk = fbxDiskFiles[index];
    const filePath = path.join(config.outputDir, disk.file);
    totalBytes += disk.bytes;
    process.stdout.write(`\rHashing ${index + 1}/${fbxDiskFiles.length}...`);
    records.push({
      ...disk,
      logicalName: logicalBaseName(disk.filename),
      sha256: await hashFile(filePath),
    });
  }
  if (fbxDiskFiles.length > 0) process.stdout.write("\n");

  const zeroByte = records.filter((item) => item.bytes === 0);
  const smallFiles = records.filter((item) => item.bytes > 0 && item.bytes < config.smallThreshold);

  const hashGroups = [...groupBy(records, (item) => item.sha256).entries()]
    .filter(([, items]) => items.length > 1)
    .map(([sha256, items]) => ({ sha256, bytes: items[0].bytes, files: items.map((x) => x.file) }))
    .sort((a, b) => b.files.length - a.files.length || a.files[0].localeCompare(b.files[0]));

  const nameGroups = [...groupBy(records, (item) => item.logicalName.toLowerCase()).entries()]
    .filter(([, items]) => items.length > 1)
    .map(([, items]) => {
      const hashes = new Set(items.map((x) => x.sha256));
      return {
        logicalName: items[0].logicalName,
        files: items.map((x) => x.file),
        uniqueHashes: hashes.size,
        exactDuplicatesOnly: hashes.size === 1,
      };
    })
    .sort((a, b) => b.files.length - a.files.length || a.logicalName.localeCompare(b.logicalName));

  const state = await loadState(config.statePath);
  const completedEntries = state?.completed && typeof state.completed === "object"
    ? Object.values(state.completed)
    : [];

  // State may point to both individual FBX animations and ZIP animation packs.
  // Validate against every downloaded file, not just the FBX subset we hash/analyse.
  const diskByFile = new Map(allDiskFiles.map((item) => [item.file, item]));

  const stateMissingFiles = [];
  const stateSizeMismatches = [];
  for (const entry of completedEntries) {
    const disk = diskByFile.get(entry.file);
    if (!disk) {
      stateMissingFiles.push({ itemId: entry.itemId, name: entry.name, file: entry.file });
      continue;
    }
    if (Number.isFinite(entry.bytes) && entry.bytes !== disk.bytes) {
      stateSizeMismatches.push({
        itemId: entry.itemId,
        name: entry.name,
        file: entry.file,
        stateBytes: entry.bytes,
        diskBytes: disk.bytes,
      });
    }
  }

  const stateFiles = new Set(completedEntries.map((entry) => entry.file));
  const orphanFiles = allDiskFiles
    .filter((item) => !stateFiles.has(item.file))
    .map((item) => item.file);

  const report = {
    generatedAt: new Date().toISOString(),
    outputDir: config.outputDir,
    summary: {
      fbxFiles: records.length,
      zipPacks: zipDiskFiles.length,
      totalDownloadedFiles: allDiskFiles.length,
      totalFbxBytes: totalBytes,
      stateCompleted: completedEntries.length,
      zeroByteFiles: zeroByte.length,
      smallFiles: smallFiles.length,
      exactDuplicateHashGroups: hashGroups.length,
      logicalNameCollisionGroups: nameGroups.length,
      stateMissingFiles: stateMissingFiles.length,
      stateSizeMismatches: stateSizeMismatches.length,
      orphanFiles: orphanFiles.length,
    },
    thresholds: { smallFileBytes: config.smallThreshold },
    zeroByteFiles: zeroByte.map((item) => item.file),
    smallFiles: smallFiles.map((item) => ({ file: item.file, bytes: item.bytes })),
    exactDuplicateHashGroups: hashGroups,
    logicalNameCollisionGroups: nameGroups,
    stateMissingFiles,
    stateSizeMismatches,
    orphanFiles,
    files: records,
    zipPacks: zipDiskFiles,
  };

  await fsp.mkdir(path.dirname(config.reportPath), { recursive: true });
  await fsp.writeFile(config.reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log("\n=== Summary ===");
  console.log(`FBX files:              ${records.length}`);
  console.log(`ZIP packs:              ${zipDiskFiles.length}`);
  console.log(`Downloaded files total: ${allDiskFiles.length}`);
  console.log(`Total FBX size:          ${humanBytes(totalBytes)}`);
  console.log(`State completed:        ${completedEntries.length}`);
  console.log(`0-byte FBX files:       ${zeroByte.length}`);
  console.log(`Small FBX (<${humanBytes(config.smallThreshold)}): ${smallFiles.length}`);
  console.log(`Exact duplicate groups: ${hashGroups.length}`);
  console.log(`Name collision groups:  ${nameGroups.length}`);
  console.log(`State missing files:    ${stateMissingFiles.length}`);
  console.log(`State size mismatches:  ${stateSizeMismatches.length}`);
  console.log(`Orphan downloaded files:${orphanFiles.length}`);
  console.log(`Report:                 ${config.reportPath}`);

  if (hashGroups.length > 0) {
    console.log("\nLargest exact duplicate groups:");
    for (const group of hashGroups.slice(0, 10)) {
      console.log(`  ${group.files.length}x ${humanBytes(group.bytes)}  ${group.files.join(" | ")}`);
    }
  }

  if (nameGroups.length > 0) {
    console.log("\nLargest filename collision groups:");
    for (const group of nameGroups.slice(0, 10)) {
      console.log(
        `  ${group.files.length}x ${group.logicalName} (${group.uniqueHashes} unique content hash${group.uniqueHashes === 1 ? "" : "es"})`,
      );
    }
  }

  const problems = zeroByte.length + stateMissingFiles.length + stateSizeMismatches.length;
  if (problems > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(`\nFatal: ${error.stack || error.message || error}`);
  process.exitCode = 1;
});
