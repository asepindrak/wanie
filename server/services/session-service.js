const fs = require("fs");
const path = require("path");
const { sessionsDir } = require("../utils/paths");
async function deleteSession(userId, sessionId) {
  // Hapus dari database
  const result = await prisma.whatsappSession.deleteMany({
    where: { id: sessionId, userId },
  });
  // Hapus folder session di storage/sessions
  const sessionFolder = path.join(sessionsDir, `session-${sessionId}`);
  if (fs.existsSync(sessionFolder)) {
    try {
      fs.rmSync(sessionFolder, { recursive: true, force: true });
    } catch (err) {
      // Log error, tapi jangan gagalkan proses utama
      console.warn(`Gagal hapus folder session: ${sessionFolder}`, err);
    }
  }

  // Jika sudah tidak ada session lagi, hapus semua chat dan contact user
  const remainingSessions = await prisma.whatsappSession.count({
    where: { userId },
  });
  if (remainingSessions === 0) {
    await prisma.chat.deleteMany({ where: { userId } });
    await prisma.contact.deleteMany({ where: { userId } });
  }

  return { deleted: result.count > 0 };
}
const { prisma } = require("../database/client");

async function retryOnSqliteTimeout(operation) {
  let lastError = null;
  for (const delayMs of [0, 100, 250, 500]) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    try {
      return await operation();
    } catch (error) {
      if (error?.code !== "P1008") {
        throw error;
      }

      lastError = error;
    }
  }

  throw lastError;
}

async function listUserSessions(userId) {
  return prisma.whatsappSession.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

async function createUserSession(userId, { name, phoneNumber }) {
  if (!name) {
    throw new Error("Session name is required.");
  }

  return prisma.whatsappSession.create({
    data: {
      userId,
      name: String(name).trim(),
      phoneNumber: phoneNumber ? String(phoneNumber).trim() : null,
      status: "disconnected",
      transportType: "wwebjs",
    },
  });
}

async function getSessionById(userId, sessionId) {
  return prisma.whatsappSession.findFirst({
    where: {
      id: sessionId,
      userId,
    },
  });
}

async function listReconnectableSessions() {
  return prisma.whatsappSession.findMany({
    where: {
      status: {
        in: ["ready", "connecting"],
      },
    },
  });
}

async function touchSessionState(sessionId, data) {
  return retryOnSqliteTimeout(async () => {
    // First verify the session still exists to avoid P2025
    const exists = await prisma.whatsappSession.findUnique({
      where: { id: sessionId },
      select: { id: true },
    });

    if (!exists) {
      console.warn(`[SessionService] Attempted to touch non-existent session: ${sessionId}`);
      return null;
    }

    return prisma.whatsappSession.update({
      where: { id: sessionId },
      data,
    });
  });
}

module.exports = {
  createUserSession,
  getSessionById,
  listReconnectableSessions,
  listUserSessions,
  touchSessionState,
  deleteSession,
};
