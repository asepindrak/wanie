const { prisma } = require("../database/client");
const chatService = require("./chat-service");
const TelegramService = require("./telegram-service");
const WhatsAppMetaService = require("./whatsapp-meta-service");

const DEFAULT_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.OUTBOUND_DELIVERY_MAX_ATTEMPTS || 5),
);
const DEFAULT_WORKER_INTERVAL_MS = Math.max(
  1000,
  Number(process.env.OUTBOUND_DELIVERY_WORKER_INTERVAL_MS || 5000),
);
const BACKOFF_MS = String(
  process.env.OUTBOUND_DELIVERY_BACKOFF_MS || "10000,30000,60000,180000,300000",
)
  .split(",")
  .map((item) => Number(item.trim()))
  .filter((item) => Number.isFinite(item) && item >= 0);
const activeJobs = new Set();

let workerTimer = null;
let workerContext = null;
let cleanupTimer = null;

function userRoom(userId) {
  return `user:${userId}`;
}

function serializeJob(job) {
  if (!job) return null;
  const serialized = {
    id: job.id,
    userId: job.userId,
    messageId: job.messageId,
    transport: job.transport,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    nextAttemptAt: job.nextAttemptAt,
    lastError: job.lastError,
    deliveredAt: job.deliveredAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };

  if (Object.prototype.hasOwnProperty.call(job, "message")) {
    serialized.message = job.message
      ? {
          id: job.message.id,
          chatId: job.message.chatId,
          receiver: job.message.receiver,
          body: job.message.body,
          type: job.message.type,
          createdAt: job.message.createdAt,
          chat: job.message.chat
            ? {
                id: job.message.chat.id,
                title: job.message.chat.title,
                contact: job.message.chat.contact
                  ? {
                      displayName: job.message.chat.contact.displayName,
                      externalId: job.message.chat.contact.externalId,
                    }
                  : null,
              }
            : null,
        }
      : null;
  }

  return serialized;
}

function emitJobUpdate(io, job) {
  if (!io || !job?.userId) return;
  io.to(userRoom(job.userId)).emit("outbound_delivery_update", {
    delivery: serializeJob(job),
  });
}

function resolveTransport(message) {
  if (message?.session?.transportType === "whatsapp_cloud") return "whatsapp_cloud";
  if (message?.sessionId) return "whatsapp";
  if (String(message?.receiver || "").startsWith("tg:")) return "telegram";
  return "unknown";
}

function getBackoffMs(attempts) {
  if (!BACKOFF_MS.length) return 30000;
  const index = Math.max(0, Math.min(attempts - 1, BACKOFF_MS.length - 1));
  return BACKOFF_MS[index];
}

async function loadMessageForUser(userId, messageId) {
  return prisma.message.findFirst({
    where: {
      id: messageId,
      direction: "outbound",
      chat: { userId },
    },
    include: {
      session: true,
      mediaFile: true,
      statuses: true,
      chat: {
        include: {
          contact: true,
        },
      },
    },
  });
}

async function markDelivered(messageId) {
  const existing = await prisma.messageStatus.findFirst({
    where: {
      messageId,
      status: "delivered",
    },
  });
  if (existing) return existing;
  return chatService.addMessageStatus(messageId, "delivered");
}

async function deliverMessage({ message, sessionManager }) {
  const transport = resolveTransport(message);

  if (transport === "whatsapp") {
    if (!sessionManager?.sendMessage) {
      throw new Error("WhatsApp session manager is not available.");
    }
    return sessionManager.sendMessage(message.sessionId, {
      recipient: message.receiver,
      body: message.body,
      mediaFileId: message.mediaFileId,
      mediaPath: message.mediaFile?.relativePath || null,
    });
  }

  if (transport === "telegram") {
    const telegramId = TelegramService.extractTelegramId(message.receiver);
    if (!telegramId) {
      throw new Error("Invalid Telegram receiver.");
    }

    const sent = message.mediaFile
      ? await TelegramService.sendMedia(
          message.chat.userId,
          telegramId,
          message.mediaFile,
          message.body || "",
        )
      : await TelegramService.sendMessage(
          message.chat.userId,
          telegramId,
          message.body || "",
        );

    if (!sent) {
      throw new Error("Telegram bot is not running.");
    }
    return { externalMessageId: null };
  }

  if (transport === "whatsapp_cloud") {
    return WhatsAppMetaService.sendMessage(message);
  }

  throw new Error("No outbound transport is available for this message.");
}

async function processJob(jobOrId, { sessionManager, io } = {}) {
  const jobId = typeof jobOrId === "string" ? jobOrId : jobOrId?.id;
  if (!jobId || activeJobs.has(jobId)) return null;

  activeJobs.add(jobId);
  try {
    const job = await prisma.outboundDeliveryJob.findUnique({
      where: { id: jobId },
      include: {
        message: {
          include: {
          mediaFile: true,
          session: true,
          statuses: true,
            chat: true,
          },
        },
      },
    });

    if (
      !job ||
      job.status === "delivered" ||
      job.status === "failed" ||
      job.status === "canceled"
    ) {
      return job;
    }

    const claimed = await prisma.outboundDeliveryJob.updateMany({
      where: {
        id: job.id,
        status: { in: ["queued", "sending"] },
      },
      data: { status: "sending" },
    });
    if (!claimed.count) return job;

    const sendingJob = await prisma.outboundDeliveryJob.findUnique({
      where: { id: job.id },
    });
    emitJobUpdate(io, sendingJob);

    try {
      const deliveryResult = await deliverMessage({
        message: job.message,
        sessionManager,
      });
      if (deliveryResult?.externalMessageId) {
        await prisma.message.updateMany({
          where: {
            id: job.messageId,
            externalMessageId: null,
          },
          data: {
            externalMessageId: deliveryResult.externalMessageId,
          },
        });
      }
      await markDelivered(job.messageId);
      const deliveredJob = await prisma.outboundDeliveryJob.update({
        where: { id: job.id },
        data: {
          status: "delivered",
          attempts: { increment: 1 },
          lastError: null,
          deliveredAt: new Date(),
        },
      });
      if (io) {
        io.to(userRoom(job.userId)).emit("message_status_update", {
          messageId: job.messageId,
          status: "delivered",
        });
      }
      emitJobUpdate(io, deliveredJob);
      return deliveredJob;
    } catch (error) {
      const nextAttempts = job.attempts + 1;
      const finalFailure = nextAttempts >= job.maxAttempts;
      const latest = await prisma.outboundDeliveryJob.findUnique({
        where: { id: job.id },
      });
      if (latest?.status === "canceled") {
        emitJobUpdate(io, latest);
        return latest;
      }
      const failedJob = await prisma.outboundDeliveryJob.update({
        where: { id: job.id },
        data: {
          status: finalFailure ? "failed" : "queued",
          attempts: nextAttempts,
          lastError: error.message,
          nextAttemptAt: finalFailure
            ? new Date()
            : new Date(Date.now() + getBackoffMs(nextAttempts)),
        },
      });
      emitJobUpdate(io, failedJob);
      return failedJob;
    }
  } finally {
    activeJobs.delete(jobId);
  }
}

async function enqueueMessage({
  userId,
  messageId,
  sessionManager,
  io,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  processNow = true,
} = {}) {
  const message = await loadMessageForUser(userId, messageId);
  if (!message) {
    throw new Error("Outbound message was not found.");
  }

  const transport = resolveTransport(message);
  const job = await prisma.outboundDeliveryJob.upsert({
    where: { messageId },
    create: {
      userId,
      messageId,
      transport,
      maxAttempts,
      status: "queued",
      nextAttemptAt: new Date(),
    },
    update: {
      transport,
      maxAttempts,
      status: { set: "queued" },
      nextAttemptAt: new Date(),
    },
  });

  emitJobUpdate(io, job);
  if (!processNow) return job;
  return processJob(job.id, { sessionManager, io });
}

async function processDueJobs({ sessionManager, io, limit = 25, userId } = {}) {
  const jobs = await prisma.outboundDeliveryJob.findMany({
    where: {
      status: "queued",
      nextAttemptAt: { lte: new Date() },
      ...(userId ? { userId } : {}),
    },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
    take: limit,
  });

  const results = [];
  for (const job of jobs) {
    results.push(await processJob(job.id, { sessionManager, io }));
  }
  return results.filter(Boolean);
}

function startWorker({
  sessionManager,
  io,
  intervalMs = DEFAULT_WORKER_INTERVAL_MS,
} = {}) {
  workerContext = { sessionManager, io };
  if (workerTimer) return;

  workerTimer = setInterval(() => {
    processDueJobs(workerContext).catch((error) => {
      console.error("Outbound delivery worker failed:", error);
    });
  }, intervalMs);

  if (workerTimer.unref) workerTimer.unref();
}

function stopWorker() {
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
  workerContext = null;
}

async function listJobs(userId, { status, chatId, limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  return prisma.outboundDeliveryJob.findMany({
    where: {
      userId,
      ...(status ? { status } : {}),
      ...(chatId ? { message: { chatId } } : {}),
    },
    include: {
      message: {
        include: {
          mediaFile: true,
          chat: {
            include: { contact: true },
          },
        },
      },
    },
    orderBy: [{ updatedAt: "desc" }],
    take: safeLimit,
  });
}

async function retryJob(userId, jobId, { sessionManager, io } = {}) {
  const job = await prisma.outboundDeliveryJob.findFirst({
    where: { id: jobId, userId },
  });
  if (!job) {
    throw new Error("Outbound delivery job was not found.");
  }
  if (job.status === "delivered") {
    throw new Error("Delivered messages cannot be retried.");
  }

  const resetJob = await prisma.outboundDeliveryJob.update({
    where: { id: job.id },
    data: {
      status: "queued",
      attempts: 0,
      lastError: null,
      deliveredAt: null,
      nextAttemptAt: new Date(),
    },
  });
  emitJobUpdate(io, resetJob);
  return processJob(resetJob.id, { sessionManager, io });
}

async function cancelJob(userId, jobId, { io } = {}) {
  const job = await prisma.outboundDeliveryJob.findFirst({
    where: { id: jobId, userId },
  });
  if (!job) {
    throw new Error("Outbound delivery job was not found.");
  }
  if (job.status === "delivered") {
    throw new Error("Delivered messages cannot be canceled.");
  }

  const canceled = await prisma.outboundDeliveryJob.update({
    where: { id: job.id },
    data: {
      status: "canceled",
      lastError: null,
      nextAttemptAt: new Date(),
    },
  });
  emitJobUpdate(io, canceled);
  return canceled;
}

async function cleanupOldJobs({
  deliveredRetentionDays = Number(
    process.env.OUTBOUND_DELIVERY_DELIVERED_RETENTION_DAYS || 30,
  ),
  terminalRetentionDays = Number(
    process.env.OUTBOUND_DELIVERY_TERMINAL_RETENTION_DAYS || 90,
  ),
} = {}) {
  const now = Date.now();
  const deliveredCutoff = new Date(
    now - Math.max(1, deliveredRetentionDays) * 24 * 60 * 60 * 1000,
  );
  const terminalCutoff = new Date(
    now - Math.max(1, terminalRetentionDays) * 24 * 60 * 60 * 1000,
  );

  const [delivered, terminal] = await Promise.all([
    prisma.outboundDeliveryJob.deleteMany({
      where: {
        status: "delivered",
        updatedAt: { lt: deliveredCutoff },
      },
    }),
    prisma.outboundDeliveryJob.deleteMany({
      where: {
        status: { in: ["failed", "canceled"] },
        updatedAt: { lt: terminalCutoff },
      },
    }),
  ]);

  return {
    delivered: delivered.count,
    terminal: terminal.count,
  };
}

function startCleanupWorker() {
  if (cleanupTimer) return;
  cleanupOldJobs().catch((error) => {
    console.error("Outbound delivery cleanup failed:", error);
  });
  cleanupTimer = setInterval(() => {
    cleanupOldJobs().catch((error) => {
      console.error("Outbound delivery cleanup failed:", error);
    });
  }, 60 * 60 * 1000);
  if (cleanupTimer.unref) cleanupTimer.unref();
}

function stopCleanupWorker() {
  if (!cleanupTimer) return;
  clearInterval(cleanupTimer);
  cleanupTimer = null;
}

module.exports = {
  DEFAULT_MAX_ATTEMPTS,
  enqueueMessage,
  processDueJobs,
  processJob,
  startWorker,
  stopWorker,
  listJobs,
  retryJob,
  cancelJob,
  cleanupOldJobs,
  startCleanupWorker,
  stopCleanupWorker,
  serializeJob,
};
