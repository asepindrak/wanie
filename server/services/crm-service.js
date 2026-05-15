const { prisma } = require("../database/client");

const allowedModes = new Set(["inherit", "off", "draft", "auto"]);
const globalModes = new Set(["off", "draft", "auto"]);

const defaultSettings = {
  defaultMode: "draft",
  embeddingProviderId: null,
  embeddingModel: null,
  similarityThreshold: 0.72,
  maxChunks: 6,
  cooldownSeconds: 90,
  maxAutoRepliesPerChatPerDay: 20,
  persona:
    "Ramah, jelas, profesional, dan membantu. Gunakan Bahasa Indonesia natural.",
  fallbackMessage: "Terima kasih, pesan Anda akan dibantu admin kami.",
};

async function retryOnSqliteTimeout(operation) {
  let lastError = null;
  for (const delayMs of [0, 100, 250, 500]) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    try {
      return await operation();
    } catch (error) {
      if (error?.code !== "P1008") throw error;
      lastError = error;
    }
  }

  throw lastError;
}

function normalizeMode(value, { allowInherit = true } = {}) {
  const mode = String(value || "").trim().toLowerCase();
  const allowed = allowInherit ? allowedModes : globalModes;
  if (!allowed.has(mode)) {
    throw new Error(`Invalid CRM automation mode: ${value}`);
  }
  return mode;
}

function clampNumber(value, { min, max, fallback }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}

function serializeSettings(global, sessionRows, chatRows) {
  const sessionModes = {};
  for (const row of sessionRows || []) {
    sessionModes[row.sessionId] = row.mode;
  }

  const chatModes = {};
  for (const row of chatRows || []) {
    chatModes[row.chatId] = row.mode;
  }

  const globalSettings = global
    ? {
        defaultMode: global.defaultMode,
        embeddingProviderId: global.embeddingProviderId,
        embeddingModel: global.embeddingModel,
        similarityThreshold: global.similarityThreshold,
        maxChunks: global.maxChunks,
        cooldownSeconds: global.cooldownSeconds,
        maxAutoRepliesPerChatPerDay: global.maxAutoRepliesPerChatPerDay,
        persona: global.persona,
        fallbackMessage: global.fallbackMessage,
      }
    : {};

  return {
    ...defaultSettings,
    ...globalSettings,
    sessionModes,
    chatModes,
  };
}

async function getSettings(userId) {
  const [global, sessionRows, chatRows] = await retryOnSqliteTimeout(() =>
    Promise.all([
      prisma.crmAiSetting.findUnique({ where: { userId } }),
      prisma.crmSessionAiSetting.findMany({ where: { userId } }),
      prisma.crmChatAiSetting.findMany({ where: { userId } }),
    ]),
  );

  return serializeSettings(global, sessionRows, chatRows);
}

async function updateSettings(userId, payload = {}) {
  const data = {};

  if (payload.defaultMode !== undefined) {
    data.defaultMode = normalizeMode(payload.defaultMode, {
      allowInherit: false,
    });
  }

  if (payload.similarityThreshold !== undefined) {
    data.similarityThreshold = clampNumber(payload.similarityThreshold, {
      min: 0,
      max: 1,
      fallback: defaultSettings.similarityThreshold,
    });
  }

  if (payload.embeddingProviderId !== undefined) {
    data.embeddingProviderId = payload.embeddingProviderId || null;
  }

  if (payload.embeddingModel !== undefined) {
    data.embeddingModel = String(payload.embeddingModel || "").trim() || null;
  }

  if (payload.maxChunks !== undefined) {
    data.maxChunks = Math.round(
      clampNumber(payload.maxChunks, {
        min: 1,
        max: 12,
        fallback: defaultSettings.maxChunks,
      }),
    );
  }

  if (payload.cooldownSeconds !== undefined) {
    data.cooldownSeconds = Math.round(
      clampNumber(payload.cooldownSeconds, {
        min: 0,
        max: 3600,
        fallback: defaultSettings.cooldownSeconds,
      }),
    );
  }

  if (payload.maxAutoRepliesPerChatPerDay !== undefined) {
    data.maxAutoRepliesPerChatPerDay = Math.round(
      clampNumber(payload.maxAutoRepliesPerChatPerDay, {
        min: 1,
        max: 200,
        fallback: defaultSettings.maxAutoRepliesPerChatPerDay,
      }),
    );
  }

  if (payload.fallbackMessage !== undefined) {
    data.fallbackMessage = String(payload.fallbackMessage || "").trim();
  }

  if (payload.persona !== undefined) {
    data.persona = String(payload.persona || "").trim() || null;
  }

  if (Object.keys(data).length > 0) {
    await retryOnSqliteTimeout(() =>
      prisma.crmAiSetting.upsert({
        where: { userId },
        update: data,
        create: { userId, ...defaultSettings, ...data },
      }),
    );
  }

  if (payload.sessionModes && typeof payload.sessionModes === "object") {
    for (const [sessionId, value] of Object.entries(payload.sessionModes)) {
      const mode = normalizeMode(value);
      await setSessionMode(userId, sessionId, mode);
    }
  }

  if (payload.chatModes && typeof payload.chatModes === "object") {
    for (const [chatId, value] of Object.entries(payload.chatModes)) {
      const mode = normalizeMode(value);
      await setChatMode(userId, chatId, mode);
    }
  }

  return getSettings(userId);
}

async function setSessionMode(userId, sessionId, mode) {
  const normalized = normalizeMode(mode);
  const session = await retryOnSqliteTimeout(() =>
    prisma.whatsappSession.findFirst({ where: { id: sessionId, userId } }),
  );
  if (!session) throw new Error("Session not found.");

  if (normalized === "inherit") {
    await retryOnSqliteTimeout(() =>
      prisma.crmSessionAiSetting.deleteMany({ where: { userId, sessionId } }),
    );
    return { ok: true, mode: normalized };
  }

  await retryOnSqliteTimeout(() =>
    prisma.crmSessionAiSetting.upsert({
      where: { userId_sessionId: { userId, sessionId } },
      update: { mode: normalized },
      create: { userId, sessionId, mode: normalized },
    }),
  );
  return { ok: true, mode: normalized };
}

async function setChatMode(userId, chatId, mode) {
  const normalized = normalizeMode(mode);
  const chat = await retryOnSqliteTimeout(() =>
    prisma.chat.findFirst({ where: { id: chatId, userId } }),
  );
  if (!chat) throw new Error("Chat not found.");

  if (normalized === "inherit") {
    await retryOnSqliteTimeout(() =>
      prisma.crmChatAiSetting.deleteMany({ where: { userId, chatId } }),
    );
    return { ok: true, mode: normalized };
  }

  await retryOnSqliteTimeout(() =>
    prisma.crmChatAiSetting.upsert({
      where: { userId_chatId: { userId, chatId } },
      update: { mode: normalized },
      create: { userId, chatId, mode: normalized },
    }),
  );
  return { ok: true, mode: normalized };
}

async function resolveModeForChat(userId, chat) {
  if (!chat) return defaultSettings.defaultMode;
  const settings = await getSettings(userId);
  const chatMode = settings.chatModes?.[chat.id];
  if (chatMode && chatMode !== "inherit") return chatMode;

  const sessionMode = settings.sessionModes?.[chat.sessionId];
  if (sessionMode && sessionMode !== "inherit") return sessionMode;

  return settings.defaultMode || defaultSettings.defaultMode;
}

function sanitizeLog(record) {
  if (!record) return null;
  return {
    id: record.id,
    chatId: record.chatId,
    mode: record.mode,
    action: record.action,
    reason: record.reason,
    inboundMessageId: record.inboundMessageId,
    outboundMessageId: record.outboundMessageId,
    draft: record.draft,
    sources: record.sources,
    metadata: record.metadata,
    createdAt: record.createdAt,
  };
}

async function createAutomationLog(userId, data) {
  const record = await retryOnSqliteTimeout(() =>
    prisma.crmAutomationLog.create({
      data: {
        userId,
        chatId: data.chatId,
        mode: data.mode || "unknown",
        action: data.action,
        reason: data.reason || null,
        inboundMessageId: data.inboundMessageId || null,
        outboundMessageId: data.outboundMessageId || null,
        draft: data.draft || null,
        sources: data.sources || undefined,
        metadata: data.metadata || undefined,
      },
    }),
  );
  return sanitizeLog(record);
}

async function listAutomationLogs(userId, { chatId, limit = 50 } = {}) {
  const take = Math.max(1, Math.min(Number(limit) || 50, 100));
  const rows = await retryOnSqliteTimeout(() =>
    prisma.crmAutomationLog.findMany({
      where: {
        userId,
        ...(chatId ? { chatId } : {}),
      },
      orderBy: { createdAt: "desc" },
      take,
    }),
  );
  return rows.map(sanitizeLog);
}

async function getAutoReplyGuard(userId, chatId, settings) {
  const now = Date.now();
  const cooldownMs = Math.max(0, Number(settings.cooldownSeconds) || 0) * 1000;
  const cooldownSince = new Date(now - cooldownMs);
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  const [recentAutoReply, repliesToday] = await retryOnSqliteTimeout(() =>
    Promise.all([
      cooldownMs
        ? prisma.crmAutomationLog.findFirst({
            where: {
              userId,
              chatId,
              action: "auto_sent",
              createdAt: { gte: cooldownSince },
            },
            orderBy: { createdAt: "desc" },
          })
        : Promise.resolve(null),
      prisma.crmAutomationLog.count({
        where: {
          userId,
          chatId,
          action: "auto_sent",
          createdAt: { gte: dayStart },
        },
      }),
    ]),
  );

  if (recentAutoReply) {
    return {
      allowed: false,
      reason: "cooldown",
      metadata: { cooldownSeconds: settings.cooldownSeconds },
    };
  }

  if (repliesToday >= settings.maxAutoRepliesPerChatPerDay) {
    return {
      allowed: false,
      reason: "daily-limit",
      metadata: {
        maxAutoRepliesPerChatPerDay: settings.maxAutoRepliesPerChatPerDay,
        repliesToday,
      },
    };
  }

  return { allowed: true };
}

module.exports = {
  getSettings,
  updateSettings,
  setSessionMode,
  setChatMode,
  resolveModeForChat,
  createAutomationLog,
  listAutomationLogs,
  getAutoReplyGuard,
  normalizeMode,
};
