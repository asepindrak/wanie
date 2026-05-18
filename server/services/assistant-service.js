const { prisma } = require("../database/client");

// Retry helper for SQLite busy errors
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

async function getAssistant(userId) {
  return retryOnSqliteTimeout(() =>
    prisma.contact.findUnique({
      where: {
        userId_externalId: {
          userId,
          externalId: "openwa:assistant",
        },
      },
      select: {
        id: true,
        externalId: true,
        displayName: true,
        avatarUrl: true,
        persona: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  );
}

async function updateAssistant(userId, { displayName, avatarUrl, persona }) {
  // Try update; if not exists, create
  const existing = await retryOnSqliteTimeout(() =>
    prisma.contact.findUnique({
      where: {
        userId_externalId: {
          userId,
          externalId: "openwa:assistant",
        },
      },
    }),
  );

  if (existing) {
    return retryOnSqliteTimeout(() =>
      prisma.contact.update({
        where: { id: existing.id },
        data: {
          displayName: displayName || existing.displayName,
          avatarUrl: avatarUrl !== undefined ? avatarUrl : existing.avatarUrl,
          persona: persona !== undefined ? persona : existing.persona,
        },
      }),
    );
  }

  return retryOnSqliteTimeout(() =>
    prisma.contact.create({
      data: {
        userId,
        externalId: "openwa:assistant",
        displayName: displayName || "Wanie Assistant",
        avatarUrl: avatarUrl || null,
        persona: persona || null,
      },
    }),
  );
}

module.exports = {
  getAssistant,
  updateAssistant,
};
