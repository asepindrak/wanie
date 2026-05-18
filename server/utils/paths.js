const fs = require("fs");
const path = require("path");
const os = require("os");

const rootDir = path.resolve(__dirname, "..", "..");

function getDefaultDataDir() {
  // Allow explicit override
  const explicit =
    process.env.WANIE_DATA_DIR ||
    process.env.WANIE_HOME ||
    process.env.OPENWA_DATA_DIR ||
    process.env.OPENWA_HOME;
  if (explicit && String(explicit).trim())
    return path.resolve(String(explicit));

  const home = os.homedir();
  const wanieHome = path.join(home, ".wanie");
  const legacyOpenWaHome = path.join(home, ".openwa");

  // Use a dot-prefixed folder in the user's home directory for all platforms.
  // Existing installs keep using ~/.openwa unless the new ~/.wanie folder exists
  // or neither folder exists yet.
  if (!fs.existsSync(wanieHome) && fs.existsSync(legacyOpenWaHome)) {
    return legacyOpenWaHome;
  }

  return wanieHome;
}

const storageDir = getDefaultDataDir();
const legacyStorageDir = path.join(rootDir, "storage");
// Prefer an explicit env override. When not set, default to the user data
// directory under the user's home (e.g. ~/.wanie/workspaces). This ensures
// agent-run scaffolding targets the per-user data area by default.
const workspacesDir = process.env.WANIE_WORKSPACES_DIR
  ? path.resolve(String(process.env.WANIE_WORKSPACES_DIR))
  : process.env.OPENWA_WORKSPACES_DIR
    ? path.resolve(String(process.env.OPENWA_WORKSPACES_DIR))
  : path.join(storageDir, "workspaces");
const legacyWorkspacesDir = path.join(rootDir, "workspaces");
const sessionsDir = path.join(storageDir, "sessions");
const mediaDir = path.join(storageDir, "media");
const knowledgeDir = path.join(storageDir, "knowledge");
const databaseDir = path.join(storageDir, "database");
const prismaSchemaPath = path.join(rootDir, "prisma", "schema.prisma");
const webDir = path.join(rootDir, "web");

function ensureDir(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (e) {
    // ignore
  }
}

function copyRecursiveSync(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    ensureDir(dest);
    for (const item of fs.readdirSync(src)) {
      const s = path.join(src, item);
      const d = path.join(dest, item);
      copyRecursiveSync(s, d);
    }
  } else {
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
  }
}

function migrateLegacyStorage() {
  try {
    // If a project-local storage folder exists, try to migrate it.
    if (fs.existsSync(legacyStorageDir) && !fs.existsSync(storageDir)) {
      try {
        fs.renameSync(legacyStorageDir, storageDir);
        console.info(
          `migrated legacy storage from ${legacyStorageDir} to ${storageDir}`,
        );
      } catch (e) {
        copyRecursiveSync(legacyStorageDir, storageDir);
        console.info(
          `copied legacy storage from ${legacyStorageDir} to ${storageDir}`,
        );
      }
    }

    // Also migrate a small set of legacy files that were previously stored at project root.
    // These files should be copied into the user data directory, not moved, so the
    // project-local source remains available for repo workflows and resets.
    const legacyFiles = [
      "TOOLS.md",
      "IDENTITY.md",
      "tools_registry.json",
      "tools_credentials.json",
    ];
    for (const fname of legacyFiles) {
      try {
        const src = path.join(rootDir, fname);
        const dest = path.join(storageDir, fname);
        if (fs.existsSync(src) && !fs.existsSync(dest)) {
          ensureDir(storageDir);
          copyRecursiveSync(src, dest);
          console.info(`copied ${fname} from project root to ${dest}`);
        }
      } catch (err) {
        // ignore file-level migration errors
      }
    }
    // Migrate a project-local 'workspaces' folder
    try {
      if (fs.existsSync(legacyWorkspacesDir) && !fs.existsSync(workspacesDir)) {
        try {
          fs.renameSync(legacyWorkspacesDir, workspacesDir);
          console.info(
            `migrated workspaces from ${legacyWorkspacesDir} to ${workspacesDir}`,
          );
        } catch (e) {
          copyRecursiveSync(legacyWorkspacesDir, workspacesDir);
          console.info(
            `copied workspaces from ${legacyWorkspacesDir} to ${workspacesDir}`,
          );
        }
      }
    } catch (err) {
      // ignore
    }
    // Migrate project-level Puppeteer cache used by whatsapp-web.js (.wwebjs_cache)
    try {
      const legacyWweb = path.join(rootDir, ".wwebjs_cache");
      const destWweb = path.join(storageDir, ".wwebjs_cache");
      if (fs.existsSync(legacyWweb) && !fs.existsSync(destWweb)) {
        try {
          fs.renameSync(legacyWweb, destWweb);
          console.info(
            `migrated .wwebjs_cache from ${legacyWweb} to ${destWweb}`,
          );
        } catch (e) {
          // cross-device rename may fail; fallback to copy then remove
          copyRecursiveSync(legacyWweb, destWweb);
          try {
            fs.rmSync(legacyWweb, { recursive: true, force: true });
            console.info(
              `copied and removed legacy .wwebjs_cache at ${legacyWweb}`,
            );
          } catch (rmErr) {
            console.info(
              `copied .wwebjs_cache to ${destWweb} (failed to remove legacy): ${rmErr && rmErr.message}`,
            );
          }
        }
      }
    } catch (err) {
      // ignore
    }
  } catch (e) {
    console.warn(`failed to migrate legacy storage: ${e && e.message}`);
  }
}

function ensureRuntimeDirs() {
  // attempt migration from project-local storage to user data dir
  try {
    migrateLegacyStorage();
  } catch (e) {
    // ignore
  }

  [storageDir, sessionsDir, mediaDir, knowledgeDir, databaseDir, workspacesDir].forEach(
    ensureDir,
  );
}

module.exports = {
  rootDir,
  storageDir,
  sessionsDir,
  mediaDir,
  knowledgeDir,
  databaseDir,
  workspacesDir,
  prismaSchemaPath,
  webDir,
  ensureDir,
  ensureRuntimeDirs,
};
