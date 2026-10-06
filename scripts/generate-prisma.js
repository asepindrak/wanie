const { spawnSync } = require("child_process");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const schemaPath = path.join(rootDir, "prisma", "schema.prisma");

let prismaCli = null;
try {
  prismaCli = require.resolve("prisma/build/index.js", { paths: [rootDir, __dirname] });
} catch (e) {
  prismaCli = require.resolve("prisma", { paths: [rootDir, __dirname] });
}

const result = spawnSync(process.execPath, [prismaCli, "generate", "--schema", schemaPath], {
  cwd: rootDir,
  stdio: "inherit",
  env: {
    ...process.env,
    DATABASE_URL: process.env.DATABASE_URL || "file:./storage/database/openwa.db"
  }
});

if (result.status !== 0) {
  process.exit(result.status || 1);
}
