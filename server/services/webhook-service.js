const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");
const { prisma } = require("../database/client");
const { rootDir } = require("../utils/paths");

const storePath = path.join(rootDir, "storage", "webhooks.json");
const deliveryTimeoutMs = Math.max(
  1000,
  Number(process.env.WEBHOOK_DELIVERY_TIMEOUT_MS || 10000),
);
const defaultMaxAttempts = Math.max(
  1,
  Number(process.env.WEBHOOK_DELIVERY_MAX_ATTEMPTS || 3),
);
const workerIntervalMs = Math.max(
  1000,
  Number(process.env.WEBHOOK_DELIVERY_WORKER_INTERVAL_MS || 5000),
);
const retryDelaysMs = String(
  process.env.WEBHOOK_DELIVERY_BACKOFF_MS || "1000,3000,10000",
)
  .split(",")
  .map((item) => Number(item.trim()))
  .filter((item) => Number.isFinite(item) && item >= 0);
const activeDeliveries = new Set();
const allowedMethods = new Set(["POST", "PUT", "PATCH", "DELETE", "GET"]);

let workerTimer = null;
let cleanupTimer = null;
let socketIo = null;

function userRoom(userId) {
  return `user:${userId}`;
}

function emitDeliveryUpdate(log) {
  if (!socketIo || !log?.userId) return;
  socketIo.to(userRoom(log.userId)).emit("webhook_delivery_update", {
    delivery: sanitizeDeliveryLog(log),
  });
}

function getEncryptionKey() {
  const secret =
    process.env.OPENWA_WEBHOOK_SECRET_KEY ||
    process.env.OPENWA_ENCRYPTION_KEY ||
    process.env.JWT_SECRET ||
    "openwa-local-webhook-secret";
  return crypto.createHash("sha256").update(String(secret)).digest();
}

function encryptSecret(value) {
  const text = String(value || "");
  if (!text) return null;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decryptSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (!text.startsWith("v1:")) return text;

  const [, ivRaw, tagRaw, encryptedRaw] = text.split(":");
  if (!ivRaw || !tagRaw || !encryptedRaw) return "";

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getEncryptionKey(),
    Buffer.from(ivRaw, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function decryptJsonSecret(value, fallback = {}) {
  const raw = decryptSecret(value);
  if (!raw) return fallback;

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : fallback;
  } catch (err) {
    return fallback;
  }
}

function normalizeMethod(value) {
  const method = String(value || "POST").trim().toUpperCase();
  return allowedMethods.has(method) ? method : "POST";
}

function normalizeHeaders(value) {
  if (!value) return {};

  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (err) {
      throw new Error("headers must be a valid JSON object.");
    }
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("headers must be a valid JSON object.");
  }

  return Object.entries(parsed).reduce((acc, [key, headerValue]) => {
    const name = String(key || "").trim();
    if (!name) return acc;
    acc[name] = String(headerValue ?? "");
    return acc;
  }, {});
}

function hasHeader(headers, name) {
  const target = String(name || "").toLowerCase();
  return Object.keys(headers || {}).some(
    (key) => String(key).toLowerCase() === target,
  );
}

function getPathValue(source, pathValue) {
  return String(pathValue || "")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((current, part) => {
      if (current === null || current === undefined) return undefined;
      return current[part];
    }, source);
}

function resolveTemplateValue(expr, payload) {
  const key = String(expr || "").trim();
  if (!key) return "";
  if (key === "payload") return payload || {};
  const value = getPathValue(payload || {}, key);
  return value === undefined || value === null ? "" : value;
}

function renderTextTemplate(template, payload) {
  return String(template || "").replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) => {
    const key = String(expr || "").trim();
    if (!key) return "";
    const value = resolveTemplateValue(key, payload);
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
}

function renderJsonTemplate(template, payload) {
  return String(template || "")
    .replace(/"\{\{\s*([^}]+?)\s*\}\}"/g, (_, expr) =>
      JSON.stringify(resolveTemplateValue(expr, payload)),
    )
    .replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, expr) =>
      JSON.stringify(resolveTemplateValue(expr, payload)),
    );
}

function renderRequestBody(cfg, payload) {
  const template = String(cfg.bodyTemplate || "").trim();
  if (!template) {
    return {
      body: JSON.stringify(payload),
      contentType: "application/json",
    };
  }

  const rendered = renderJsonTemplate(template, payload);
  try {
    return {
      body: JSON.stringify(JSON.parse(rendered)),
      contentType: "application/json",
    };
  } catch (err) {
    return {
      body: renderTextTemplate(template, payload),
      contentType: "text/plain",
    };
  }
}

function readStore() {
  try {
    if (!fs.existsSync(storePath)) return {};
    return JSON.parse(fs.readFileSync(storePath, "utf8") || "{}");
  } catch (err) {
    console.error("Failed to read webhook store:", err);
    return {};
  }
}

function writeStore(data) {
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("Failed to write webhook store:", err);
  }
}

function normalizeConfigForRead(config) {
  if (!config) return null;
  return {
    url: config.url || "",
    enabled: config.enabled !== false,
    method: normalizeMethod(config.method),
    apiKey: config.apiKeyEncrypted
      ? decryptSecret(config.apiKeyEncrypted)
      : config.apiKey || "",
    headers: config.headersEncrypted
      ? decryptJsonSecret(config.headersEncrypted, {})
      : normalizeHeaders(config.headers || {}),
    bodyTemplate: config.bodyTemplate || "",
  };
}

function normalizeConfigForWrite(config = {}) {
  const apiKey = String(config.apiKey || "");
  const headers = normalizeHeaders(config.headers || {});
  return {
    url: String(config.url || "").trim(),
    enabled: config.enabled !== false,
    method: normalizeMethod(config.method),
    apiKeyEncrypted: encryptSecret(apiKey),
    headersEncrypted: encryptSecret(JSON.stringify(headers)),
    bodyTemplate: String(config.bodyTemplate || ""),
  };
}

async function deliver(cfg, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deliveryTimeoutMs);
  const method = normalizeMethod(cfg.method);
  const headers = { ...(cfg.headers || {}) };
  if (cfg.apiKey && !hasHeader(headers, "x-openwa-webhook-key")) {
    headers["x-openwa-webhook-key"] = cfg.apiKey;
  }

  let body;
  if (method !== "GET") {
    const rendered = renderRequestBody(cfg, payload);
    body = rendered.body;
    if (!hasHeader(headers, "content-type")) {
      headers["Content-Type"] = rendered.contentType;
    }
  }

  try {
    const res = await fetch(cfg.url, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    const responseBody = await res.text().catch(() => "");
    if (!res.ok) {
      const error = new Error(`Webhook returned HTTP ${res.status}`);
      error.responseStatus = res.status;
      error.responseBody = responseBody.slice(0, 2000);
      throw error;
    }
    return {
      responseStatus: res.status,
      responseBody: responseBody.slice(0, 2000),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBackoffMs(attempts) {
  if (!retryDelaysMs.length) return 30000;
  const index = Math.max(0, Math.min(attempts - 1, retryDelaysMs.length - 1));
  return retryDelaysMs[index];
}

async function payloadIds(userId, payload = {}) {
  if (payload.test) {
    return { chatId: null, messageId: null };
  }

  const chatId = payload.chat?.id || payload.message?.chatId || null;
  const messageId = payload.message?.id || null;
  const [chat, message] = await Promise.all([
    chatId
      ? prisma.chat.findFirst({
          where: { id: chatId, userId },
          select: { id: true },
        })
      : null,
    messageId
      ? prisma.message.findFirst({
          where: { id: messageId, chat: { userId } },
          select: { id: true },
        })
      : null,
  ]);

  return {
    chatId: chat?.id || null,
    messageId: message?.id || null,
  };
}

async function createDeliveryLog(userId, cfg, payload) {
  const ids = await payloadIds(userId, payload);
  return prisma.webhookDeliveryLog.create({
    data: {
      userId,
      chatId: ids.chatId,
      messageId: ids.messageId,
      url: cfg.url,
      payload,
      status: "pending",
      maxAttempts: defaultMaxAttempts,
      nextAttemptAt: new Date(),
    },
  });
}

function createTestPayload(userId) {
  const now = new Date().toISOString();
  return {
    event: "webhook.test",
    test: true,
    sentAt: now,
    chat: {
      id: `test-chat-${userId}`,
      title: "OpenWA Webhook Test",
      transportType: "whatsapp",
      contact: {
        id: `test-contact-${userId}`,
        displayName: "OpenWA Test Customer",
        externalId: "6281234567890@c.us",
      },
    },
    message: {
      id: `test-message-${Date.now()}`,
      chatId: `test-chat-${userId}`,
      sessionId: "test-session",
      sender: "6281234567890@c.us",
      receiver: `user:${userId}`,
      body: "This is a test webhook from OpenWA. Reply with HTTP 2xx to mark delivery as successful.",
      type: "text",
      direction: "inbound",
      mediaFile: null,
      statuses: [],
      createdAt: now,
      updatedAt: now,
    },
  };
}

async function runDelivery(userId, logId, cfg, payload) {
  if (activeDeliveries.has(logId)) return null;
  activeDeliveries.add(logId);

  try {
    const current = await prisma.webhookDeliveryLog.findFirst({
      where: { id: logId, userId },
    });
    if (!current || current.status === "delivered" || current.status === "failed") {
      return current ? { ok: current.status === "delivered", log: current } : null;
    }

    const sendingLog = await prisma.webhookDeliveryLog.update({
      where: { id: logId },
      data: { status: "sending" },
    });
    emitDeliveryUpdate(sendingLog);

    const nextAttempts = current.attempts + 1;
    try {
      const result = await deliver(cfg, payload);
      const log = await prisma.webhookDeliveryLog.update({
        where: { id: logId },
        data: {
          status: "delivered",
          attempts: nextAttempts,
          responseStatus: result.responseStatus,
          responseBody: result.responseBody || null,
          error: null,
          deliveredAt: new Date(),
        },
      });
      emitDeliveryUpdate(log);
      return { ok: true, attempts: nextAttempts, log };
    } catch (err) {
      const finalFailure = nextAttempts >= current.maxAttempts;
      const log = await prisma.webhookDeliveryLog.update({
        where: { id: logId },
        data: {
          status: finalFailure ? "failed" : "pending",
          attempts: nextAttempts,
          responseStatus: err.responseStatus || null,
          responseBody: err.responseBody || null,
          error: err.message || "Webhook delivery failed",
          nextAttemptAt: finalFailure
            ? new Date()
            : new Date(Date.now() + getBackoffMs(nextAttempts)),
        },
      });
      emitDeliveryUpdate(log);
      if (finalFailure) {
        console.error("Failed to deliver webhook for user", userId, err);
      }
      return { ok: false, error: log.error, log };
    }
  } finally {
    activeDeliveries.delete(logId);
  }
}

function sanitizeDeliveryLog(log) {
  if (!log) return null;
  return {
    id: log.id,
    userId: log.userId,
    chatId: log.chatId,
    messageId: log.messageId,
    url: log.url,
    status: log.status,
    attempts: log.attempts,
    maxAttempts: log.maxAttempts,
    nextAttemptAt: log.nextAttemptAt,
    responseStatus: log.responseStatus,
    responseBody: log.responseBody,
    error: log.error,
    deliveredAt: log.deliveredAt,
    createdAt: log.createdAt,
    updatedAt: log.updatedAt,
  };
}

module.exports = {
  getWebhook: (userId) => {
    const store = readStore();
    return normalizeConfigForRead(store[userId]);
  },

  setIo: (io) => {
    socketIo = io || null;
  },

  setWebhook: (userId, cfg) => {
    const store = readStore();
    store[userId] = normalizeConfigForWrite(cfg);
    writeStore(store);
    return normalizeConfigForRead(store[userId]);
  },

  deleteWebhook: (userId) => {
    const store = readStore();
    delete store[userId];
    writeStore(store);
  },

  notifyWebhook: async (userId, payload) => {
    const cfg = module.exports.getWebhook(userId);
    if (!cfg || !cfg.url || cfg.enabled === false) return null;

    const log = await createDeliveryLog(userId, cfg, payload);
    emitDeliveryUpdate(log);
    return runDelivery(userId, log.id, cfg, payload);
  },

  testWebhook: async (userId) => {
    const cfg = module.exports.getWebhook(userId);
    if (!cfg || !cfg.url) {
      throw new Error("Webhook is not configured.");
    }

    const payload = createTestPayload(userId);
    const log = await createDeliveryLog(userId, cfg, payload);
    emitDeliveryUpdate(log);
    return runDelivery(userId, log.id, cfg, payload);
  },

  listDeliveries: async (userId, { status, chatId, limit = 50 } = {}) => {
    const take = Math.max(1, Math.min(Number(limit) || 50, 200));
    const logs = await prisma.webhookDeliveryLog.findMany({
      where: {
        userId,
        ...(status ? { status: String(status) } : {}),
        ...(chatId ? { chatId: String(chatId) } : {}),
      },
      orderBy: { createdAt: "desc" },
      take,
    });
    return logs.map(sanitizeDeliveryLog);
  },

  retryDelivery: async (userId, deliveryId) => {
    const log = await prisma.webhookDeliveryLog.findFirst({
      where: {
        id: deliveryId,
        userId,
      },
    });
    if (!log) throw new Error("Webhook delivery log not found.");

    const cfg = module.exports.getWebhook(userId);
    if (!cfg || !cfg.url) throw new Error("Webhook is not configured.");

    const resetLog = await prisma.webhookDeliveryLog.update({
      where: { id: log.id },
      data: {
        status: "pending",
        attempts: 0,
        error: null,
        responseStatus: null,
        responseBody: null,
        deliveredAt: null,
        nextAttemptAt: new Date(),
      },
    });
    emitDeliveryUpdate(resetLog);

    return runDelivery(userId, log.id, cfg, log.payload);
  },

  processDueDeliveries: async ({ limit = 25 } = {}) => {
    const logs = await prisma.webhookDeliveryLog.findMany({
      where: {
        status: { in: ["pending", "sending"] },
        nextAttemptAt: { lte: new Date() },
      },
      orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
      take: limit,
    });

    const results = [];
    for (const log of logs) {
      const cfg = module.exports.getWebhook(log.userId);
      if (!cfg || !cfg.url) {
        const failedLog = await prisma.webhookDeliveryLog.update({
            where: { id: log.id },
            data: {
              status: "failed",
              error: "Webhook is not configured.",
            },
          });
        emitDeliveryUpdate(failedLog);
        results.push(failedLog);
        continue;
      }
      results.push(await runDelivery(log.userId, log.id, cfg, log.payload));
    }
    return results.filter(Boolean);
  },

  startWorker: ({ io } = {}) => {
    if (io) module.exports.setIo(io);
    if (workerTimer) return;
    workerTimer = setInterval(() => {
      module.exports.processDueDeliveries().catch((error) => {
        console.error("Webhook delivery worker failed:", error);
      });
    }, workerIntervalMs);
    if (workerTimer.unref) workerTimer.unref();
  },

  stopWorker: () => {
    if (!workerTimer) return;
    clearInterval(workerTimer);
    workerTimer = null;
  },

  cleanupOldDeliveries: async ({
    deliveredRetentionDays = Number(
      process.env.WEBHOOK_DELIVERY_DELIVERED_RETENTION_DAYS || 30,
    ),
    terminalRetentionDays = Number(
      process.env.WEBHOOK_DELIVERY_TERMINAL_RETENTION_DAYS || 90,
    ),
  } = {}) => {
    const now = Date.now();
    const deliveredCutoff = new Date(
      now - Math.max(1, deliveredRetentionDays) * 24 * 60 * 60 * 1000,
    );
    const terminalCutoff = new Date(
      now - Math.max(1, terminalRetentionDays) * 24 * 60 * 60 * 1000,
    );

    const [delivered, terminal] = await Promise.all([
      prisma.webhookDeliveryLog.deleteMany({
        where: {
          status: "delivered",
          updatedAt: { lt: deliveredCutoff },
        },
      }),
      prisma.webhookDeliveryLog.deleteMany({
        where: {
          status: "failed",
          updatedAt: { lt: terminalCutoff },
        },
      }),
    ]);

    return {
      delivered: delivered.count,
      terminal: terminal.count,
    };
  },

  startCleanupWorker: () => {
    if (cleanupTimer) return;
    module.exports.cleanupOldDeliveries().catch((error) => {
      console.error("Webhook delivery cleanup failed:", error);
    });
    cleanupTimer = setInterval(() => {
      module.exports.cleanupOldDeliveries().catch((error) => {
        console.error("Webhook delivery cleanup failed:", error);
      });
    }, 60 * 60 * 1000);
    if (cleanupTimer.unref) cleanupTimer.unref();
  },

  stopCleanupWorker: () => {
    if (!cleanupTimer) return;
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  },
};
