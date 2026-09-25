import fs from "node:fs";
import path from "node:path";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const FRONTEND_ROOTS = ["app/", "pages/", "public/"];
const FRONTEND_FILES = new Set([
  "middleware.ts",
  "next.config.mjs",
  "next-env.d.ts",
  "vercel.json"
]);
const PROJECT_CONFIG_FILES = new Set([
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  ".eslintrc.json"
]);

export function normalizeFile(file) {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function isTestFile(file) {
  const normalized = normalizeFile(file);
  return normalized.startsWith("tests/") || /(?:^|\/)__tests__\//.test(normalized) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(normalized);
}

export function isDocumentationFile(file) {
  const normalized = normalizeFile(file).toLowerCase();
  return normalized === "readme.md" || normalized.startsWith("docs/") || /\.(?:md|mdx|txt)$/.test(normalized);
}

export function buildWorkerFileSet(rootDir, entry = "scripts/marketplace-worker.ts") {
  const result = new Set([normalizeFile(entry), "ecosystem.config.cjs", "scripts/register-server-only.cjs"]);
  const pending = [normalizeFile(entry)];

  while (pending.length) {
    const relativeFile = pending.pop();
    const absoluteFile = path.join(rootDir, relativeFile);
    if (!fs.existsSync(absoluteFile)) continue;
    const source = fs.readFileSync(absoluteFile, "utf8");
    const importPattern = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g;
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2];
      if (!specifier?.startsWith(".")) continue;
      const resolved = resolveLocalImport(rootDir, relativeFile, specifier);
      if (resolved && !result.has(resolved)) {
        result.add(resolved);
        pending.push(resolved);
      }
    }
  }

  return result;
}

function resolveLocalImport(rootDir, importer, specifier) {
  const base = path.resolve(rootDir, path.dirname(importer), specifier);
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => path.join(base, `index${extension}`))
  ];
  const root = path.resolve(rootDir);
  for (const candidate of candidates) {
    if (!candidate.startsWith(root + path.sep) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
    return normalizeFile(path.relative(rootDir, candidate));
  }
  return null;
}

export function classifyChanges(files, { workerFiles = new Set() } = {}) {
  const normalizedFiles = [...new Set(files.map(normalizeFile).filter(Boolean))].sort();
  const productionFiles = normalizedFiles.filter((file) => !isTestFile(file) && !isDocumentationFile(file));
  const dependencies = normalizedFiles.some((file) => file === "package.json" || file === "package-lock.json");
  const migration = normalizedFiles.some((file) => file.startsWith("supabase/migrations/"));
  const worker = dependencies || productionFiles.some((file) => workerFiles.has(file));
  const frontend = dependencies || productionFiles.some((file) =>
    FRONTEND_ROOTS.some((root) => file.startsWith(root)) ||
    FRONTEND_FILES.has(file) ||
    (file.startsWith("lib/") && !file.startsWith("lib/cloudinary-stage2-") && !file.startsWith("lib/cloudinary-orphan-") && !file.startsWith("lib/cloudinary-legacy-"))
  );
  const sourceChanged = productionFiles.some((file) => /\.[cm]?[jt]sx?$/.test(file));
  const configChanged = productionFiles.some((file) => PROJECT_CONFIG_FILES.has(file) || FRONTEND_FILES.has(file));

  return {
    files: normalizedFiles,
    frontend,
    worker,
    dependencies,
    migration,
    documentationOnly: normalizedFiles.length > 0 && productionFiles.length === 0 && normalizedFiles.every((file) => isDocumentationFile(file) || isTestFile(file)),
    typecheck: sourceChanged || dependencies || normalizedFiles.includes("tsconfig.json"),
    build: dependencies || configChanged,
    testFiles: normalizedFiles.filter(isTestFile)
  };
}

export function findRelatedTests(rootDir, changedFiles) {
  const testsDir = path.join(rootDir, "tests");
  if (!fs.existsSync(testsDir)) return [];
  const allTests = fs.readdirSync(testsDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name))
    .map((entry) => normalizeFile(path.relative(rootDir, path.join(entry.parentPath ?? entry.path, entry.name))));
  const explicitTests = changedFiles.map(normalizeFile).filter(isTestFile);
  const sourceStems = changedFiles
    .map(normalizeFile)
    .filter((file) => !isTestFile(file))
    .map((file) => path.posix.basename(file).replace(/\.[^.]+$/, ""));

  return [...new Set([...explicitTests, ...allTests.filter((testFile) => {
    const testSource = fs.readFileSync(path.join(rootDir, testFile), "utf8");
    return sourceStems.some((stem) => stem && (path.posix.basename(testFile).includes(stem) || testSource.includes(`/${stem}`)));
  })])].sort();
}
