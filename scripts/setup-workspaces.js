#!/usr/bin/env node
// Cross-platform helper to create and set permissions for Wanie workspaces
// Usage: node scripts/setup-workspaces.js [username] [group]

const { execSync } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { workspacesDir } = require("../server/utils/paths");

const username = process.argv[2] || os.userInfo().username;
const group = process.argv[3] || username;

const dir = process.env.WANIE_WORKSPACES_DIR || workspacesDir;

console.log("Workspaces dir:", dir);
fs.mkdirSync(dir, { recursive: true });

if (process.platform === "win32") {
  // Use icacls
  const target = `\\"${dir}\\"`;
  const grant = `${username}`;
  const cmd = `icacls ${target} /grant ${grant}:(OI)(CI)F /T`;
  console.log("Running:", cmd);
  try {
    execSync(cmd, { stdio: "inherit", shell: true });
    console.log("ACL update completed");
  } catch (e) {
    console.error("icacls failed:", e.message);
  }
} else {
  // Unix-like: chown + setgid + chmod
  try {
    execSync(`chown -R ${username}:${group} "${dir}"`, { stdio: "inherit" });
  } catch (e) {
    console.error("chown failed (requires sudo):", e.message);
  }
  try {
    execSync(`chmod -R 2770 "${dir}"`, { stdio: "inherit" });
  } catch (e) {
    console.error("chmod failed:", e.message);
  }
  console.log("Permissions set (Unix-like).");
}

console.log(
  "Done. Ensure the Wanie service runs under a user that has access.",
);
