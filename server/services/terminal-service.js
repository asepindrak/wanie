const { spawn } = require("child_process");
const fs = require("fs");
const { prisma } = require("../database/client");
const { getConfig } = require("../config");
const userSettings = require("./user-settings");
const path = require("path");
const { workspacesDir } = require("../utils/paths");

function runShellCommand(command, timeout = 300000, cwd) {
  return new Promise((resolve) => {
    let child;
    const opts = {
      windowsHide: true,
      cwd: cwd || process.cwd(),
    };

    try {
      if (process.platform === "win32") {
        // Detect PowerShell-specific constructs and run via PowerShell when available
        const psPattern =
          /Out-Null|\bInvoke-|Get-Content|Start-Process|New-Item|Set-Content|Add-Content|Remove-Item|Get-ChildItem|Write-Host|Write-Output|Read-Host|@'|@\"/i;
        // Detect common bash-only constructs and prefer bash when available
        const bashPattern =
          />\/dev\/null|\$\(|sed\s+-i|tail\s+-n|rm\s+-rf|sleep\s+\d+|kill\s+\$\(|\|\s*sed|awk\s+|mkdir\s+-p/i;

        const systemRoot = process.env.SystemRoot || "C:\\Windows";
        const psPath = path.join(
          systemRoot,
          "System32",
          "WindowsPowerShell",
          "v1.0",
          "powershell.exe",
        );
        const possibleBash = [
          path.join("C:", "Program Files", "Git", "bin", "bash.exe"),
          path.join("C:", "Program Files (x86)", "Git", "bin", "bash.exe"),
          path.join("C:", "msys64", "usr", "bin", "bash.exe"),
        ];
        let bashPath = null;
        for (const pth of possibleBash) {
          try {
            if (fs.existsSync(pth)) {
              bashPath = pth;
              break;
            }
          } catch (e) {}
        }

        // Allow an explicit override via WANIE_TERMINAL_SHELL env var.
        const preferredShell = (
          process.env.WANIE_TERMINAL_SHELL ||
          process.env.OPENWA_TERMINAL_SHELL ||
          ""
        ).toLowerCase();
        if (
          (preferredShell === "powershell" || preferredShell === "pwsh") &&
          fs.existsSync(psPath)
        ) {
          child = spawn(
            psPath,
            [
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-Command",
              String(command || ""),
            ],
            opts,
          );
        } else if (preferredShell === "bash" && bashPath) {
          child = spawn(bashPath, ["-lc", String(command || "")], opts);
        } else if (
          psPattern.test(String(command || "")) &&
          fs.existsSync(psPath)
        ) {
          // Spawn PowerShell directly with arguments to avoid cmd.exe parsing
          child = spawn(
            psPath,
            [
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-Command",
              String(command || ""),
            ],
            opts,
          );
        } else if (bashPattern.test(String(command || "")) && bashPath) {
          // Use bash -lc when bash is available (Git Bash / msys)
          child = spawn(bashPath, ["-lc", String(command || "")], opts);
        } else {
          // Default: use cmd /c via shell=true to preserve legacy behavior
          child = spawn(command, { shell: true, ...opts });
        }
      } else {
        // Non-Windows: use the default shell (usually /bin/sh)
        child = spawn(command, { shell: true, ...opts });
      }
    } catch (e) {
      // Fallback to previous behavior
      child = spawn(command, {
        shell: true,
        windowsHide: true,
        cwd: cwd || process.cwd(),
      });
    }
    let stdout = "";
    let stderr = "";
    let finished = false;

    const onFinish = (code) => {
      if (finished) return;
      finished = true;
      resolve({ code, stdout, stderr });
    };

    child.stdout.on("data", (d) => {
      try {
        stdout += String(d || "");
      } catch (e) {}
    });

    child.stderr.on("data", (d) => {
      try {
        stderr += String(d || "");
      } catch (e) {}
    });

    child.on("error", (err) => {
      if (finished) return;
      finished = true;
      resolve({
        code: -1,
        stdout,
        stderr: (stderr || "") + String(err.message || err),
      });
    });

    child.on("close", (code) => onFinish(code));

    if (timeout && timeout > 0) {
      setTimeout(() => {
        try {
          child.kill();
        } catch (e) {}
        if (!finished) {
          finished = true;
          resolve({ code: -1, stdout, stderr: (stderr || "") + "\n<timeout>" });
        }
      }, timeout);
    }
  });
}

async function requestExecution(
  userId,
  {
    command,
    approvalMode = "manual",
    timeout = 300000,
    trustedAuto = false,
    chatId = null,
    cwd,
  } = {},
  io,
) {
  if (!command) throw new Error("command is required");
  // Normalize and resolve cwd: always restrict to workspacesDir
  let effectiveCwd = workspacesDir;
  try {
    if (cwd) {
      // If absolute, resolve; if relative, resolve against workspacesDir
      const resolved = path.resolve(workspacesDir, String(cwd || ""));
      // Ensure resolved path is inside workspacesDir
      const root = path.resolve(workspacesDir);
      if (!resolved.startsWith(root)) {
        throw new Error("cwd outside allowed workspaces directory");
      }
      effectiveCwd = resolved;
    }
  } catch (e) {
    throw new Error(`invalid cwd: ${e && e.message}`);
  }

  console.info(
    `[terminal-service] requestExecution user=${userId} command=${String(command).slice(0, 200)} cwd=${effectiveCwd}`,
  );
  getConfig();
  const allowlist = (
    process.env.WANIE_TERMINAL_ALLOWLIST ||
    process.env.OPENWA_TERMINAL_ALLOWLIST ||
    ""
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Check in-memory per-user setting for bypassing the host allowlist
  let userPrefAuto = false;
  try {
    userPrefAuto = !!(await userSettings.getSetting(
      userId,
      "autoApproveAllTerminalCommands",
    ));
  } catch (e) {
    // ignore
  }

  if (userPrefAuto) {
    approvalMode = "auto";
  }

  const record = await prisma.terminalCommand.create({
    data: {
      userId,
      command,
      approvalMode: approvalMode === "auto" ? "auto" : "manual",
      status: "pending",
      cwd: effectiveCwd || null,
    },
  });

  // Auto-execute when explicitly requested and either the user has enabled
  // bypassing the host allowlist or the command matches the configured allowlist.
  const canAuto =
    approvalMode === "auto" &&
    (trustedAuto ||
      userPrefAuto ||
      (allowlist.length > 0 &&
        allowlist.some((a) => command.trim().startsWith(a))));
  if (canAuto) {
    await prisma.terminalCommand.update({
      where: { id: record.id },
      data: { status: "running" },
    });
    const res = await runShellCommand(command, timeout, effectiveCwd);
    const result = {
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.code,
    };
    await prisma.terminalCommand.update({
      where: { id: record.id },
      data: {
        status: res.code === 0 ? "completed" : "failed",
        result,
        executedAt: new Date(),
      },
    });
    try {
      io &&
        io.to(`user:${userId}`).emit("terminal_result", {
          id: record.id,
          chatId,
          status: res.code === 0 ? "completed" : "failed",
          result,
          command,
          cwd: effectiveCwd,
        });
    } catch (e) {}
    return {
      id: record.id,
      chatId,
      executed: true,
      result,
      command,
      cwd: effectiveCwd,
    };
  }

  // Emit request for manual approval
  try {
    io &&
      io.to(`user:${userId}`).emit("terminal_request", {
        id: record.id,
        chatId,
        userId,
        command,
        approvalMode: record.approvalMode,
        status: record.status,
        requestedAt: record.requestedAt,
      });
  } catch (e) {}

  return { id: record.id, chatId, executed: false, command };
}

async function listPendingRequests(userId) {
  return prisma.terminalCommand.findMany({
    where: { userId, status: "pending" },
    orderBy: { requestedAt: "desc" },
  });
}

async function listHistory(userId, limit = 50) {
  return prisma.terminalCommand.findMany({
    where: { userId },
    orderBy: { requestedAt: "desc" },
    take: Number(limit) || 50,
  });
}

async function getRequestById(id) {
  return prisma.terminalCommand.findUnique({ where: { id } });
}

async function approveRequest(approverId, requestId, approve = true, io) {
  const record = await prisma.terminalCommand.findUnique({
    where: { id: requestId },
  });
  if (!record) throw new Error("Request not found");
  if (record.status !== "pending") throw new Error("Request is not pending");

  if (!approve) {
    await prisma.terminalCommand.update({
      where: { id: requestId },
      data: { status: "denied" },
    });
    try {
      io &&
        io
          .to(`user:${record.userId}`)
          .emit("terminal_result", { id: requestId, status: "denied" });
    } catch (e) {}
    return { ok: true, denied: true };
  }

  await prisma.terminalCommand.update({
    where: { id: requestId },
    data: { status: "running" },
  });
  const res = await runShellCommand(record.command);
  const result = { stdout: res.stdout, stderr: res.stderr, exitCode: res.code };
  await prisma.terminalCommand.update({
    where: { id: requestId },
    data: {
      status: res.code === 0 ? "completed" : "failed",
      result,
      executedAt: new Date(),
    },
  });
  try {
    io &&
      io.to(`user:${record.userId}`).emit("terminal_result", {
        id: requestId,
        status: res.code === 0 ? "completed" : "failed",
        result,
      });
  } catch (e) {}

  return { ok: true, result };
}

module.exports = {
  runShellCommand,
  requestExecution,
  listPendingRequests,
  approveRequest,
  listHistory,
  getRequestById,
};
