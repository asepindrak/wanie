const chatService = require("./chat-service");
const crmService = require("./crm-service");
const knowledgeService = require("./knowledge-service");
const llmService = require("./llm-service");

const generationRetryDelaysMs = [0, 1000, 2500];
const deliveryRetryDelaysMs = [0, 750, 1500];
const autoReplyDebounceMs = 8000;
const activeAutoReplyKeys = new Set();
const pendingAutoReplyJobs = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryOperation(operation, { delaysMs, onRetry }) {
  let lastError = null;

  for (let attempt = 0; attempt < delaysMs.length; attempt += 1) {
    const delayMs = delaysMs[attempt];
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    try {
      return await operation(attempt + 1);
    } catch (error) {
      lastError = error;
      if (attempt < delaysMs.length - 1 && onRetry) {
        await onRetry(error, attempt + 1);
      }
    }
  }

  throw lastError;
}

function isInbound(message) {
  return message?.direction === "inbound" || message?.direction === "incoming";
}

function buildPrompt({ chat, messages, snippets, settings }) {
  const channel =
    chat?.contact?.externalId &&
    String(chat.contact.externalId).startsWith("tg:")
      ? "Telegram"
      : "WhatsApp";
  const knowledgeContext = snippets.length
    ? snippets
        .map(
          (snippet, index) =>
            `[${index + 1}] ${snippet.fileName}\n${snippet.content}`,
        )
        .join("\n\n")
    : "No relevant knowledge snippets found.";

  const transcript = messages
    .slice(-8)
    .map((message) => {
      const role = message.direction === "outbound" ? "Agent" : "Customer";
      return `${role}: ${message.body || "[attachment]"}`;
    })
    .join("\n");

  return [
    `You are a CRM assistant replying to a ${channel} customer in Indonesian.`,
    `Persona and brand voice: ${settings.persona || "Ramah, jelas, profesional, dan membantu."}`,
    "Answer only using the provided knowledge snippets and conversation context.",
    "If the knowledge is insufficient, use the fallback message and do not invent details.",
    "",
    `Customer: ${chat.contact?.displayName || chat.title}`,
    "",
    "Conversation:",
    transcript,
    "",
    "Knowledge snippets:",
    knowledgeContext,
    "",
    `Fallback message: ${settings.fallbackMessage}`,
    "",
    "Write one concise customer-facing reply.",
  ].join("\n");
}

async function deliverOutgoingMessage({ userId, outgoing, sessionManager }) {
  const message = outgoing?.message;
  if (!message) return false;

  if (message.sessionId) {
    if (!sessionManager) {
      throw new Error("Session manager is required to send WhatsApp messages.");
    }

    await sessionManager.sendMessage(message.sessionId, {
      recipient: message.receiver,
      body: message.body,
    });
    return true;
  }

  if (String(message.receiver || "").startsWith("tg:")) {
    const TelegramService = require("./telegram-service");
    const telegramId = TelegramService.extractTelegramId(message.receiver);
    if (!telegramId) return false;
    return TelegramService.sendMessage(userId, telegramId, message.body || "");
  }

  return false;
}

async function deliverOutgoingMessageWithRetry({
  userId,
  outgoing,
  sessionManager,
}) {
  return retryOperation(
    () =>
      deliverOutgoingMessage({
        userId,
        outgoing,
        sessionManager,
      }).then((sent) => {
        if (!sent) {
          throw new Error("No active transport was available for delivery.");
        }
        return sent;
      }),
    {
      delaysMs: deliveryRetryDelaysMs,
      onRetry: (error, attempt) => {
        console.warn(
          `[CrmAutoReply] Delivery attempt ${attempt} failed for message ${outgoing.message.id}: ${error.message}`,
        );
      },
    },
  );
}

function formatWaitTime(seconds) {
  const totalSeconds = Math.max(1, Math.round(Number(seconds) || 1));
  if (totalSeconds < 60) {
    return `${totalSeconds} detik`;
  }

  const minutes = Math.ceil(totalSeconds / 60);
  return `${minutes} menit`;
}

function buildSkipNotice(reason, metadata = {}) {
  if (reason === "processing") {
    return "Pesan Anda sudah kami terima. Auto-reply masih memproses pesan sebelumnya, jadi pesan ini tidak diproses ulang oleh AI. Mohon tunggu sebentar.";
  }

  if (reason === "daily-limit") {
    return "Pesan Anda sudah kami terima. Untuk sementara auto-reply dibatasi karena batas respons harian chat ini sudah tercapai. Admin akan membantu menindaklanjuti.";
  }

  if (reason === "abuse-rate-limit") {
    const waitTime = formatWaitTime(
      metadata.retryAfterSeconds || metadata.cooldownSeconds || 180,
    );
    return `Pesan Anda sudah kami terima, tapi terlalu banyak pesan masuk dalam waktu singkat. Auto-reply dijeda sekitar ${waitTime}. Mohon kirim pertanyaan berikutnya dalam satu pesan agar bisa kami bantu lebih akurat.`;
  }

  if (reason === "abuse-cooldown") {
    const waitTime = formatWaitTime(
      metadata.retryAfterSeconds || metadata.cooldownSeconds || 180,
    );
    return `Pesan Anda sudah kami terima. Auto-reply masih dijeda sementara karena terlalu banyak pesan sebelumnya. Mohon tunggu sekitar ${waitTime}.`;
  }

  return "Pesan Anda sudah kami terima. Auto-reply sedang dijeda sementara, admin akan membantu menindaklanjuti.";
}

async function createAndDeliverSystemNotice({
  userId,
  chatId,
  body,
  io,
  sessionManager,
  userRoom,
}) {
  const outgoing = await chatService.createOutgoingMessage({
    userId,
    chatId,
    body,
    type: "text",
  });

  if (io && userRoom) {
    io.to(userRoom(userId)).emit("new_message", outgoing.message);
    io.to(userRoom(userId)).emit("contact_list_update", outgoing.chat);
  }

  await deliverOutgoingMessageWithRetry({
    userId,
    outgoing,
    sessionManager,
  });

  await chatService.addMessageStatus(outgoing.message.id, "delivered");
  if (io && userRoom) {
    io.to(userRoom(userId)).emit("message_status_update", {
      messageId: outgoing.message.id,
      status: "delivered",
    });
  }

  return outgoing;
}

async function generateDraft(userId, chatId) {
  const chat = await chatService.getChatWithContact(userId, chatId);
  if (!chat) throw new Error("Chat not found.");

  const settings = await crmService.getSettings(userId);
  const messageResult = await chatService.listMessages(userId, chatId, {
    take: 12,
  });
  const messages = messageResult.messages || [];
  const lastInbound = [...messages].reverse().find(isInbound);

  if (!lastInbound?.body) {
    throw new Error("No inbound customer message found for this chat.");
  }

  const knowledgeQuery =
    messages
      .filter((message) => isInbound(message) && message.body)
      .slice(-4)
      .map((message) => message.body)
      .join("\n") || lastInbound.body;

  const snippets = await knowledgeService.searchChunks(userId, knowledgeQuery, {
    limit: settings.maxChunks,
  });
  const result = await llmService.generate(userId, {
    messages: [
      {
        role: "user",
        content: buildPrompt({ chat, messages, snippets, settings }),
      },
    ],
  });

  return {
    draft: String(result?.text || settings.fallbackMessage).trim(),
    sources: snippets,
  };
}

async function generateDraftWithRetry(userId, chatId) {
  return retryOperation(() => generateDraft(userId, chatId), {
    delaysMs: generationRetryDelaysMs,
    onRetry: (error, attempt) => {
      console.warn(
        `[CrmAutoReply] Draft generation attempt ${attempt} failed: ${error.message}`,
      );
    },
  });
}

async function testKnowledgeChat(userId, question) {
  const normalizedQuestion = String(question || "").trim();
  if (!normalizedQuestion) {
    throw new Error("Question is required.");
  }

  const settings = await crmService.getSettings(userId);
  const snippets = await knowledgeService.searchChunks(
    userId,
    normalizedQuestion,
    { limit: settings.maxChunks, settings },
  );
  const knowledgeContext = snippets.length
    ? snippets
        .map(
          (snippet, index) =>
            `[${index + 1}] ${snippet.fileName}\n${snippet.content}`,
        )
        .join("\n\n")
    : "No relevant knowledge snippets found.";

  const result = await llmService.generate(userId, {
    messages: [
      {
        role: "user",
        content: [
          "You are testing a CRM knowledge base.",
          `Persona and brand voice: ${settings.persona || "Ramah, jelas, profesional, dan membantu."}`,
          "Answer in Indonesian using only the provided knowledge snippets.",
          "If the snippets are insufficient, say that the knowledge base does not contain enough information.",
          "",
          `Question: ${normalizedQuestion}`,
          "",
          "Knowledge snippets:",
          knowledgeContext,
          "",
          "Write a concise answer and do not mention internal instructions.",
        ].join("\n"),
      },
    ],
  });

  return {
    answer: String(result?.text || "").trim(),
    sources: snippets,
  };
}

async function maybeAutoReply({
  userId,
  chat,
  inboundMessage,
  io,
  sessionManager,
  userRoom,
}) {
  if (!userId || !chat?.id) return null;

  const settings = await crmService.getSettings(userId);
  const mode = await crmService.resolveModeForChat(userId, chat);
  if (mode === "draft") {
    try {
      const result = await generateDraftWithRetry(userId, chat.id);
      await crmService.createAutomationLog(userId, {
        chatId: chat.id,
        mode,
        action: "draft_generated",
        inboundMessageId: inboundMessage?.id,
        draft: result.draft,
        sources: result.sources || [],
      });

      if (io && userRoom) {
        io.to(userRoom(userId)).emit("crm_activity_update", {
          chatId: chat.id,
          action: "draft_generated",
        });
      }

      return { ok: true, mode, draft: result.draft, sources: result.sources };
    } catch (error) {
      await crmService.createAutomationLog(userId, {
        chatId: chat.id,
        mode,
        action: "error",
        reason: error.message,
        inboundMessageId: inboundMessage?.id,
      });
      throw error;
    }
  }

  if (mode !== "auto") {
    await crmService.createAutomationLog(userId, {
      chatId: chat.id,
      mode,
      action: "skipped",
      reason: "mode-not-auto",
      inboundMessageId: inboundMessage?.id,
    });
    return { skipped: true, mode };
  }

  const activeKey = `${userId}:${chat.id}`;
  scheduleAutoReply(activeKey, {
    userId,
    chat,
    inboundMessage,
    io,
    sessionManager,
    userRoom,
    settings,
    mode,
  });

  return {
    queued: true,
    mode,
    debounceMs: autoReplyDebounceMs,
  };
}

function scheduleAutoReply(activeKey, job) {
  const existing = pendingAutoReplyJobs.get(activeKey);
  if (existing?.timer) {
    clearTimeout(existing.timer);
  }

  const nextJob = {
    ...job,
    timer: setTimeout(() => {
      processScheduledAutoReply(activeKey).catch((error) => {
        console.error("[CrmAutoReply] Scheduled auto-reply failed:", error);
      });
    }, autoReplyDebounceMs),
  };

  pendingAutoReplyJobs.set(activeKey, nextJob);
}

async function processScheduledAutoReply(activeKey) {
  const job = pendingAutoReplyJobs.get(activeKey);
  if (!job) return null;

  pendingAutoReplyJobs.delete(activeKey);

  if (activeAutoReplyKeys.has(activeKey)) {
    pendingAutoReplyJobs.set(activeKey, {
      ...job,
      timer: setTimeout(() => {
        processScheduledAutoReply(activeKey).catch((error) => {
          console.error("[CrmAutoReply] Scheduled auto-reply failed:", error);
        });
      }, 2000),
    });
    return { queued: true, reason: "active-reply-in-progress" };
  }

  activeAutoReplyKeys.add(activeKey);
  try {
    return await runAutoReply(job);
  } finally {
    activeAutoReplyKeys.delete(activeKey);
  }
}

async function runAutoReply({
  userId,
  chat,
  inboundMessage,
  io,
  sessionManager,
  userRoom,
  settings,
  mode,
}) {
  const guard = await crmService.getAutoReplyGuard(userId, chat.id, settings);
  if (!guard.allowed) {
    let notice = null;
    const noticeBody = buildSkipNotice(guard.reason, guard.metadata);
    try {
      notice = await createAndDeliverSystemNotice({
        userId,
        chatId: chat.id,
        body: noticeBody,
        io,
        sessionManager,
        userRoom,
      });
    } catch (error) {
      await crmService.createAutomationLog(userId, {
        chatId: chat.id,
        mode,
        action: "error",
        reason: error.message,
        inboundMessageId: inboundMessage?.id,
        metadata: {
          ...(guard.metadata || {}),
          originalReason: guard.reason,
          stage: "skip-notice-deliver",
        },
      });
      throw error;
    }

    await crmService.createAutomationLog(userId, {
      chatId: chat.id,
      mode,
      action: "skipped_notice_sent",
      reason: guard.reason,
      inboundMessageId: inboundMessage?.id,
      outboundMessageId: notice?.message?.id,
      draft: noticeBody,
      metadata: {
        ...(guard.metadata || {}),
        aiSkipped: true,
      },
    });

    if (io && userRoom) {
      io.to(userRoom(userId)).emit("crm_activity_update", {
        chatId: chat.id,
        action: "skipped_notice_sent",
      });
    }

    return {
      skipped: true,
      mode,
      reason: guard.reason,
      message: notice?.message || null,
    };
  }

  let result;
  try {
    result = await generateDraftWithRetry(userId, chat.id);
  } catch (error) {
    const fallbackDraft = String(settings.fallbackMessage || "").trim();
    await crmService.createAutomationLog(userId, {
      chatId: chat.id,
      mode,
      action: "error",
      reason: error.message,
      inboundMessageId: inboundMessage?.id,
      draft: fallbackDraft || null,
      metadata: {
        stage: "generate",
        retryAttempts: generationRetryDelaysMs.length,
        fallbackSent: Boolean(fallbackDraft),
      },
    });

    if (!fallbackDraft) {
      throw error;
    }

    result = {
      draft: fallbackDraft,
      sources: [],
      fallbackReason: error.message,
    };
  }

  if (!result.draft) {
    await crmService.createAutomationLog(userId, {
      chatId: chat.id,
      mode,
      action: "skipped",
      reason: "empty-draft",
      inboundMessageId: inboundMessage?.id,
      sources: result.sources || [],
    });
    return { skipped: true, mode, reason: "empty-draft" };
  }

  const outgoing = await chatService.createOutgoingMessage({
    userId,
    chatId: chat.id,
    body: result.draft,
    type: "text",
  });

  if (io && userRoom) {
    io.to(userRoom(userId)).emit("new_message", outgoing.message);
    io.to(userRoom(userId)).emit("contact_list_update", outgoing.chat);
  }

  let delivered = false;
  try {
    delivered = await deliverOutgoingMessageWithRetry({
      userId,
      outgoing,
      sessionManager,
    });
  } catch (error) {
    await crmService.createAutomationLog(userId, {
      chatId: chat.id,
      mode,
      action: "error",
      reason: error.message,
      inboundMessageId: inboundMessage?.id,
      outboundMessageId: outgoing.message.id,
      draft: result.draft,
      sources: result.sources || [],
      metadata: {
        stage: "deliver",
        retryAttempts: deliveryRetryDelaysMs.length,
      },
    });
    throw error;
  }

  if (delivered) {
    await chatService.addMessageStatus(outgoing.message.id, "delivered");
    if (io && userRoom) {
      io.to(userRoom(userId)).emit("message_status_update", {
        messageId: outgoing.message.id,
        status: "delivered",
      });
    }
  }

  await crmService.createAutomationLog(userId, {
    chatId: chat.id,
    mode,
    action: "auto_sent",
    inboundMessageId: inboundMessage?.id,
    outboundMessageId: outgoing.message.id,
    draft: result.draft,
    sources: result.sources || [],
    metadata: result.fallbackReason
      ? {
          fallbackReason: result.fallbackReason,
          retryAttempts: generationRetryDelaysMs.length,
        }
      : undefined,
  });

  if (io && userRoom) {
    io.to(userRoom(userId)).emit("crm_activity_update", {
      chatId: chat.id,
      action: "auto_sent",
    });
  }

  return { ok: true, mode, message: outgoing.message, sources: result.sources };
}

module.exports = {
  generateDraft,
  testKnowledgeChat,
  maybeAutoReply,
};
