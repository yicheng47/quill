import console from "node:console";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

function isNonEmptyString(val) {
  return typeof val === "string" && val.trim().length > 0;
}

function validateFileEntry(entry, label) {
  if (!entry || typeof entry !== "object") {
    throw new Error(`${label}: file entry must be an object`);
  }
  if (!isNonEmptyString(entry.url)) {
    throw new Error(`${label}: file entry missing url`);
  }
  if (!isNonEmptyString(entry.sha512)) {
    throw new Error(`${label}: file entry ${entry.url} missing sha512`);
  }
}

function validateParsedMacUpdate(doc, label) {
  if (!doc || typeof doc !== "object") {
    throw new Error(`${label}: YAML did not parse to an object`);
  }
  if (!isNonEmptyString(doc.version)) {
    throw new Error(`${label}: missing version`);
  }
  if (!Array.isArray(doc.files) || doc.files.length === 0) {
    throw new Error(`${label}: missing non-empty files array`);
  }
  for (const entry of doc.files) {
    validateFileEntry(entry, label);
  }
}

function isZipEntry(entry) {
  return entry.url.toLowerCase().endsWith(".zip");
}

function isArm64Entry(entry) {
  return entry.url.toLowerCase().includes("arm64");
}

function fileSortScore(entry) {
  // Keep zip files first (as electron-updater's updateInfoBuilder expects) and
  // deterministic x64-before-arm64 ordering within each extension group.
  const extScore = isZipEntry(entry) ? 0 : 10;
  const archScore = isArm64Entry(entry) ? 1 : 0;
  return extScore + archScore;
}

export function mergeMacUpdateYml(arm64YamlText, x64YamlText) {
  const arm64Doc = yaml.load(arm64YamlText);
  const x64Doc = yaml.load(x64YamlText);

  validateParsedMacUpdate(arm64Doc, "arm64 latest-mac.yml");
  validateParsedMacUpdate(x64Doc, "x64 latest-mac.yml");

  if (arm64Doc.version !== x64Doc.version) {
    throw new Error(
      `Cannot merge latest-mac.yml with mismatched versions: arm64=${arm64Doc.version}, x64=${x64Doc.version}`,
    );
  }

  const arm64Zips = arm64Doc.files.filter((f) => isZipEntry(f) && isArm64Entry(f));
  if (arm64Zips.length === 0) {
    throw new Error("arm64 latest-mac.yml must include an arm64 .zip entry");
  }

  const x64Zips = x64Doc.files.filter((f) => isZipEntry(f) && !isArm64Entry(f));
  if (x64Zips.length === 0) {
    throw new Error("x64 latest-mac.yml must include a non-arm64 (x64) .zip entry");
  }

  const byUrl = new Map();
  for (const entry of [...x64Doc.files, ...arm64Doc.files]) {
    const existing = byUrl.get(entry.url);
    if (existing) {
      if (existing.sha512 !== entry.sha512) {
        throw new Error(`Conflicting sha512 for duplicate update file ${entry.url}`);
      }
      continue;
    }
    byUrl.set(entry.url, { ...entry });
  }

  const files = Array.from(byUrl.values()).sort((a, b) => {
    const diff = fileSortScore(a) - fileSortScore(b);
    return diff !== 0 ? diff : a.url.localeCompare(b.url);
  });

  const primaryZip = x64Zips[0] ?? files.find(isZipEntry) ?? files[0];
  const merged = {
    version: arm64Doc.version,
    files,
    path: primaryZip.url,
    sha512: primaryZip.sha512,
    releaseDate: pickReleaseDate(arm64Doc.releaseDate, x64Doc.releaseDate),
  };

  for (const optionalKey of ["releaseName", "releaseNotes", "minimumSystemVersion"]) {
    const val = x64Doc[optionalKey] ?? arm64Doc[optionalKey];
    if (val != null) {
      merged[optionalKey] = val;
    }
  }

  return yaml.dump(merged, { lineWidth: -1 });
}

function pickReleaseDate(a, b) {
  if (!isNonEmptyString(a)) return b ?? new Date().toISOString();
  if (!isNonEmptyString(b)) return a;
  return a >= b ? a : b;
}

export function verifyMergedMacUpdateYml(yamlText, expectedVersion) {
  const doc = yaml.load(yamlText);
  validateParsedMacUpdate(doc, "merged latest-mac.yml");
  if (expectedVersion && doc.version !== expectedVersion) {
    throw new Error(
      `Merged latest-mac.yml version ${doc.version} does not match expected ${expectedVersion}`,
    );
  }
  const hasArm64Zip = doc.files.some((f) => isZipEntry(f) && isArm64Entry(f));
  const hasX64Zip = doc.files.some((f) => isZipEntry(f) && !isArm64Entry(f));
  if (!hasArm64Zip || !hasX64Zip) {
    throw new Error("Merged latest-mac.yml must include both arm64 and x64 .zip entries");
  }
  if (!isNonEmptyString(doc.path) || !doc.path.toLowerCase().endsWith(".zip")) {
    throw new Error(`Merged latest-mac.yml path must point to a .zip, got ${doc.path}`);
  }
  return doc;
}

const isEntrypoint =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  const [arm64Path, x64Path, outPath, expectedVersion] = process.argv.slice(2);
  if (!arm64Path || !x64Path || !outPath) {
    console.error(
      "Usage: node scripts/merge-mac-update-yml.mjs <arm64-yml> <x64-yml> <out-yml> [expected-version]",
    );
    process.exit(2);
  }
  const merged = mergeMacUpdateYml(
    fs.readFileSync(arm64Path, "utf8"),
    fs.readFileSync(x64Path, "utf8"),
  );
  verifyMergedMacUpdateYml(merged, expectedVersion);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, merged, "utf8");
}
