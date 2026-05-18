const { prisma } = require("../server/database/client");
const userSettings = require("../server/services/user-settings");

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error("Usage: node scripts/check-terminal.js <terminalCommandId>");
    process.exit(2);
  }

  try {
    const rec = await prisma.terminalCommand.findUnique({ where: { id } });
    console.log("Record:", rec);
    if (!rec) {
      console.log("No record found for id", id);
      process.exit(0);
    }

    console.log("\nUser ID:", rec.userId);
    console.log("ApprovalMode:", rec.approvalMode);
    console.log("Status:", rec.status);
    console.log("RequestedAt:", rec.requestedAt);
    console.log("ExecutedAt:", rec.executedAt);
    console.log("Result:", rec.result);

    try {
      const pref = await userSettings.getSetting(
        rec.userId,
        "autoApproveAllTerminalCommands",
      );
      console.log("\nUser settings autoApproveAllTerminalCommands:", pref);
    } catch (e) {
      console.error("Failed to read userSettings:", e.message || e);
    }

    console.log(
      "\nWANIE_TERMINAL_ALLOWLIST env:",
      process.env.WANIE_TERMINAL_ALLOWLIST || "(none)",
    );
  } catch (err) {
    console.error("Error:", err.message || err);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

main();
