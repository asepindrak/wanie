#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const dotenv = require("dotenv");
const { startWanie } = require("../server");
const authService = require("../server/services/auth-service");
const {
  storageDir,
  ensureRuntimeDirs,
  rootDir,
} = require("../server/utils/paths");

const args = process.argv.slice(2);
const dev = args.includes("--dev");

function getOptionValue(optionName) {
  const exact = args.find((arg) => arg.startsWith(`${optionName}=`));
  if (exact) {
    return exact.slice(optionName.length + 1);
  }

  const index = args.indexOf(optionName);
  if (index !== -1 && index + 1 < args.length) {
    return args[index + 1];
  }

  return null;
}

const hostArg = getOptionValue("--host");
if (hostArg) {
  process.env.HOST = hostArg;
}

const filteredArgs = [];
let skipNext = false;
for (const arg of args) {
  if (skipNext) {
    skipNext = false;
    continue;
  }

  if (arg === "--dev" || arg === "--host" || arg.startsWith("--host=")) {
    if (arg === "--host") {
      skipNext = true;
    }
    continue;
  }

  filteredArgs.push(arg);
}

const command = filteredArgs[0];

async function askQuestion(prompt, { mask = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    if (mask) {
      const write = rl._writeToOutput;
      rl._writeToOutput = function (stringToWrite) {
        if (rl.stdoutMuted) {
          rl.output.write("*");
        } else {
          write.call(rl, stringToWrite);
        }
      };
      rl.stdoutMuted = true;
    }

    rl.question(prompt, (answer) => {
      if (mask) rl.output.write("\n");
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function resetPasswordFlow() {
  console.log("\n[Wanie] Reset Password\n");
  const email = await askQuestion("Enter the user email: ");
  if (!email) {
    console.log("Email is required.");
    process.exit(1);
  }

  const password = await askQuestion("New password: ", { mask: true });
  if (!password) {
    console.log("Password cannot be empty.");
    process.exit(1);
  }

  try {
    await authService.resetPassword({ email, password });
    console.log("Password reset successfully for user:", email);
  } catch (error) {
    console.error("Failed to reset password:", error.message);
    process.exit(1);
  }
}

async function ensureJwtSecret() {
  if (
    (process.env.WANIE_JWT_SECRET && process.env.WANIE_JWT_SECRET.trim()) ||
    (process.env.OPENWA_JWT_SECRET && process.env.OPENWA_JWT_SECRET.trim())
  ) {
    return;
  }

  const envPath = path.join(rootDir, ".env");
  let envContents = "";
  let parsed = {};

  if (fs.existsSync(envPath)) {
    envContents = fs.readFileSync(envPath, "utf8");
    try {
      parsed = dotenv.parse(envContents);
    } catch (err) {
      parsed = {};
    }
  }

  const existingSecret = parsed.WANIE_JWT_SECRET || parsed.OPENWA_JWT_SECRET;
  if (existingSecret && String(existingSecret).trim()) {
    process.env.WANIE_JWT_SECRET = String(existingSecret).trim();
    return;
  }

  console.log("\n[Wanie] WANIE_JWT_SECRET is not set.");
  console.log(
    "A secret is required to protect dashboard authentication and API tokens.",
  );
  const secret = await askQuestion("Enter a value for WANIE_JWT_SECRET: ");
  if (!secret) {
    console.log("WANIE_JWT_SECRET is required.");
    process.exit(1);
  }

  let newContents = envContents.trimEnd();
  if (newContents.length > 0 && !newContents.endsWith("\n")) {
    newContents += "\n";
  }
  newContents += `WANIE_JWT_SECRET=${secret}\n`;
  fs.writeFileSync(envPath, newContents, { encoding: "utf8", mode: 0o600 });
  process.env.WANIE_JWT_SECRET = secret;
  console.log(`[Wanie] Saved WANIE_JWT_SECRET to ${envPath}`);
}

async function resetAllDataFlow() {
  console.log("\n[Wanie] Reset All Data\n");
  console.log(`This will permanently delete all Wanie data in ${storageDir}`);
  const confirm = await askQuestion("Type YES to confirm: ");
  if (confirm !== "YES") {
    console.log("Reset cancelled.");
    process.exit(0);
  }

  try {
    if (fs.existsSync(storageDir)) {
      fs.rmSync(storageDir, { recursive: true, force: true });
    }
    ensureRuntimeDirs();
    console.log("All Wanie data has been reset. You can start Wanie again.");
  } catch (error) {
    console.error("Failed to reset all data:", error.message);
    process.exit(1);
  }
}

async function handleResetCommand() {
  console.log("\n[Wanie] Reset command\n");
  console.log("1) Reset Password");
  console.log("2) Reset All Data");

  const choice = await askQuestion("Select an option (1 or 2): ");
  if (choice === "1") {
    await resetPasswordFlow();
  } else if (choice === "2") {
    await resetAllDataFlow();
  } else {
    console.log("Invalid choice. Exiting.");
    process.exit(1);
  }
}

console.log("\x1b[36m[Wanie]\x1b[0m Initializing... Please wait.");

// Friendly Windows startup hint about shell quoting issues
if (process.platform === "win32") {
  console.log(
    "\x1b[33m[Wanie]\x1b[0m Running on Windows — if you see PowerShell quoting errors, try using Git Bash or run commands in a bash-compatible shell.",
  );
  console.log(
    "\x1b[33m[Wanie]\x1b[0m For npm script environment variables use 'cross-env' for cross-platform compatibility.",
  );
}

if (command === "reset") {
  handleResetCommand().catch((error) => {
    console.error("Failed to execute reset command.", error);
    process.exit(1);
  });
} else {
  ensureJwtSecret()
    .then(() => startWanie({ dev }))
    .catch((error) => {
      console.error("Failed to start Wanie.", error);
      process.exit(1);
    });
}
