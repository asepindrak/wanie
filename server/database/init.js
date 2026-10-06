const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { prisma } = require("./client");
const {
  ensureRuntimeDirs,
  prismaSchemaPath,
  rootDir,
  databasePath,
  getSqliteUrl,
} = require("../utils/paths");

function getPrismaCli() {
  const paths = [rootDir, __dirname, path.join(rootDir, "node_modules")];
  try {
    return require.resolve("prisma/build/index.js", { paths });
  } catch (e1) {
    try {
      return require.resolve("prisma", { paths });
    } catch (e2) {
      const fallback = path.join(
        rootDir,
        "node_modules",
        "prisma",
        "build",
        "index.js",
      );
      if (fs.existsSync(fallback)) return fallback;
      throw new Error(
        "Prisma CLI not found. Please ensure prisma is installed.",
      );
    }
  }
}

function isPrismaClientGenerated() {
  try {
    const paths = [rootDir, __dirname, path.join(rootDir, "node_modules")];
    const clientPkg = require.resolve("@prisma/client", { paths });
    const clientDir = path.dirname(clientPkg);
    const candidatePaths = [
      path.join(clientDir, "..", ".prisma", "client", "schema.prisma"),
      path.join(clientDir, "..", ".prisma", "client", "index.js"),
      path.join(clientDir, ".prisma", "client", "index.js"),
      path.join(rootDir, "node_modules", ".prisma", "client", "schema.prisma"),
      path.join(rootDir, "node_modules", ".prisma", "client", "index.js"),
    ];
    return candidatePaths.some((p) => fs.existsSync(p));
  } catch (e) {
    return false;
  }
}

function runPrismaCommand(args) {
  const prismaCli = getPrismaCli();
  const dbUrl = process.env.DATABASE_URL || getSqliteUrl(databasePath);
  const env = {
    ...process.env,
    DATABASE_URL: dbUrl,
  };

  const result = spawnSync(
    process.execPath,
    [prismaCli, ...args, "--schema", prismaSchemaPath],
    {
      cwd: rootDir,
      encoding: "utf8",
      env,
    },
  );

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(`Prisma command failed: prisma ${args.join(" ")}\n${output}`);
  }
}

async function initializeDatabase() {
  ensureRuntimeDirs();

  // If Prisma Client is already generated, skip prisma generate to avoid
  // slow startup and Windows DLL file-locking errors (EPERM on rename).
  if (!isPrismaClientGenerated()) {
    try {
      runPrismaCommand(["generate"]);
    } catch (err) {
      const isWindowsLockError =
        process.platform === "win32" &&
        (err.message.includes("EPERM") ||
          err.message.includes("EBUSY") ||
          err.message.includes("locked"));
      if (isWindowsLockError && isPrismaClientGenerated()) {
        console.warn(
          "[Wanie] Warning: Prisma Client regeneration skipped due to Windows file lock. Existing client will be used.",
        );
      } else {
        throw err;
      }
    }
  }

  // Push schema to SQLite without triggering generate (avoids DLL renames and locks)
  try {
    runPrismaCommand(["db", "push", "--skip-generate"]);
  } catch (err) {
    if (
      err.message.includes("unknown option") ||
      err.message.includes("unexpected argument")
    ) {
      runPrismaCommand(["db", "push"]);
    } else {
      throw err;
    }
  }

  await prisma.$connect();
}

module.exports = {
  initializeDatabase,
  isPrismaClientGenerated,
  runPrismaCommand,
};
