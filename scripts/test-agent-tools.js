(async () => {
  try {
    // Ensure allowlist fallback if not provided in environment
    process.env.WANIE_TERMINAL_ALLOWLIST =
      process.env.WANIE_TERMINAL_ALLOWLIST || "start,notepad";

    const { prisma } = require("../server/database/client");
    const terminal = require("../server/services/terminal-service");

    // Find or create a user for testing
    let user = await prisma.user.findFirst();
    if (!user) {
      user = await prisma.user.create({
        data: {
          name: "Test User",
          email: `test+${Date.now()}@example.com`,
          passwordHash: "test",
        },
      });
      console.log("Created test user", user.id);
    } else {
      console.log("Using existing user", user.id);
    }

    // Request terminal execution (auto) to open Notepad
    const command =
      process.platform === "win32"
        ? "start notepad"
        : "echo not-supported-on-platform";
    console.log("Requesting terminal exec:", command);
    const termRes = await terminal.requestExecution(
      user.id,
      { command, approvalMode: "auto", timeout: 15000 },
      null,
    );

    console.log(
      "Terminal execution response:",
      JSON.stringify(termRes, null, 2),
    );

    // Create a test message and then search for it
    const contact = await prisma.contact.upsert({
      where: {
        userId_externalId: { userId: user.id, externalId: "test:search" },
      },
      update: { displayName: "Test Search" },
      create: {
        userId: user.id,
        externalId: "test:search",
        displayName: "Test Search",
      },
    });

    let chat = await prisma.chat.findFirst({
      where: { userId: user.id, contactId: contact.id },
    });
    if (!chat) {
      chat = await prisma.chat.create({
        data: {
          userId: user.id,
          contactId: contact.id,
          title: "Test Search Chat",
        },
      });
    }

    const body = `agent-test-${Date.now()}`;
    const msg = await prisma.message.create({
      data: {
        chatId: chat.id,
        sessionId: null,
        sender: `system`,
        receiver: `user:${user.id}`,
        body,
        type: "text",
        direction: "inbound",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    console.log("Created test message:", msg.id, msg.body);

    const found = await prisma.message.findMany({
      where: { body: { contains: body } },
      include: { chat: { include: { contact: true } }, mediaFile: true },
    });

    console.log("Search results count:", found.length);
    for (const f of found) {
      console.log({
        id: f.id,
        body: f.body,
        chatId: f.chatId,
        chatTitle: f.chat?.title,
        contact: f.chat?.contact?.displayName,
      });
    }

    process.exit(0);
  } catch (err) {
    console.error("Test script error:", err);
    process.exit(1);
  }
})();
