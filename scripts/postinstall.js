const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

try {
  const rootDir = path.resolve(__dirname, "..");
  const schemaPath = path.join(rootDir, "prisma", "schema.prisma");
  if (!fs.existsSync(schemaPath)) {
    process.exit(0);
  }

  let prismaCli = null;
  try {
    prismaCli = require.resolve("prisma/build/index.js", { paths: [rootDir, __dirname] });
  } catch (e) {
    try {
      prismaCli = require.resolve("prisma", { paths: [rootDir, __dirname] });
    } catch (e2) {
      process.exit(0);
    }
  }

  spawnSync(process.execPath, [prismaCli, "generate", "--schema", schemaPath], {
    cwd: rootDir,
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL || "file:./storage/database/openwa.db"
    }
  });

  // Always exit 0 during postinstall so npm i -g never fails
  process.exit(0);
} catch (err) {
  // Graceful exit so global installs do not roll back on Windows or constrained environments
  process.exit(0);
}
