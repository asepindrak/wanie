const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const chatService = require("./chat-service");
const crmService = require("./crm-service");
const knowledgeService = require("./knowledge-service");
const llmService = require("./llm-service");
const outboundDeliveryService = require("./outbound-delivery-service");
const transcriptionService = require("./transcription-service");
const { knowledgeDir, mediaDir } = require("../utils/paths");

const generationRetryDelaysMs = [0, 1000, 2500];
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

function isNoInboundTextError(error) {
  return /No inbound customer message found/i.test(String(error?.message || ""));
}

function normalizeConversationCue(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isClosingOrAcknowledgement(text) {
  const normalized = normalizeConversationCue(text);
  if (!normalized) return false;

  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length > 6) return false;

  const blockingQuestionTerms =
    /\b(harga|price|biaya|tarif|qris|bayar|payment|alamat|jadwal|booking|order|pesan|berapa|kapan|dimana|di mana|apa|gimana|bagaimana)\b/i;

  return (
    /^(ok|okay|oke|okey|sip|siap|baik|noted|noted kak|noted ya|thanks|thank you|thx|ty|makasih|terima kasih|trimakasih|thanks kak|makasih kak|oke kak|ok kak|sip kak|siap kak|baik kak|mantap|done|clear|understood|no|nope|nothing|nothing else|no thanks|no thank you|that is all|thats all|all good|tidak|tidak kak|tidak ada|tidak ada kak|tidak ada lagi|tidak ada lagi kak|nggak|ngga|gak|ga|enggak|engga|nggak kak|ngga kak|gak kak|ga kak|enggak kak|engga kak|gak ada|ga ada|nggak ada|ngga ada|enggak ada|engga ada|gak ada kak|ga ada kak|nggak ada kak|ngga ada kak|enggak ada kak|engga ada kak|gak ada lagi|ga ada lagi|nggak ada lagi|ngga ada lagi|enggak ada lagi|engga ada lagi|gak ada lagi kak|ga ada lagi kak|nggak ada lagi kak|ngga ada lagi kak|enggak ada lagi kak|engga ada lagi kak)$/i.test(
      normalized,
    ) ||
    (/^(ok|oke|okay|sip|siap|baik|thanks|makasih|terima kasih)\b/i.test(
      normalized,
    ) &&
      !blockingQuestionTerms.test(normalized)) ||
    (/^(no|nope|nothing|tidak|nggak|ngga|gak|ga|enggak|engga)\b/i.test(
      normalized,
    ) &&
      !blockingQuestionTerms.test(normalized))
  );
}

function buildClosingAcknowledgement(text) {
  const normalized = normalizeConversationCue(text);
  if (/\b(thanks|thank you|makasih|terima kasih|trimakasih)\b/i.test(normalized)) {
    return "Sama-sama kak.";
  }
  if (
    /\b(no|nope|nothing|tidak|nggak|ngga|gak|ga|enggak|engga)\b/i.test(
      normalized,
    )
  ) {
    return "Baik kak.";
  }
  return "Siap kak.";
}

function parseJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;

  try {
    return JSON.parse(candidate);
  } catch (error) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch (nestedError) {
        return null;
      }
    }
    return null;
  }
}

async function classifyConversationState(userId, latestText, messages, settings) {
  const normalizedLatest = String(latestText || "").trim();
  if (!normalizedLatest || normalizedLatest.length > 220) {
    return { state: "question", confidence: 0, reason: "long_or_empty" };
  }

  const transcript = messages
    .slice(-6)
    .map((message) => {
      const role = message.direction === "outbound" ? "Agent" : "Customer";
      return `${role}: ${message.crmContent || message.body || "[attachment]"}`;
    })
    .join("\n");

  try {
    const result = await llmService.generate(userId, {
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            "Classify the latest customer message in a CRM chat.",
            "Return only a compact JSON object with this exact shape:",
            '{"state":"question|closing|thanks|acknowledgement|booking_intent|handoff_request|unclear","confidence":0.0,"reason":"short reason"}',
            "",
            "Rules:",
            "- Use question when the latest customer message asks for information, price, payment, schedule, address, booking, availability, or asks the business to do something.",
            "- Use closing when the customer declines more help, says there is nothing else, or clearly ends the conversation.",
            "- Use thanks when the customer only thanks the agent.",
            "- Use acknowledgement when the customer only acknowledges the previous message without asking for anything else.",
            "- If ambiguous, use question or unclear, not closing.",
            "- Do not answer the customer.",
            "",
            `Assistant name: ${settings.assistantName || "CRM Assistant"}`,
            "",
            "Recent transcript:",
            transcript,
            "",
            `Latest customer message: ${normalizedLatest}`,
          ].join("\n"),
        },
      ],
    });

    const parsed = parseJsonObject(result?.text);
    const state = String(parsed?.state || "unclear").toLowerCase();
    const confidence = Math.max(
      0,
      Math.min(Number(parsed?.confidence) || 0, 1),
    );

    return {
      state,
      confidence,
      reason: String(parsed?.reason || "").slice(0, 200),
    };
  } catch (error) {
    return {
      state: "question",
      confidence: 0,
      reason: `classification_failed: ${error.message}`,
    };
  }
}

function sanitizeCustomerReply(text) {
  return String(text || "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gi, "$2")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$2")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .trim();
}

function resolveMediaFilePath(mediaFile) {
  const relativePath = String(mediaFile?.relativePath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
  if (!relativePath) return null;

  const normalized = relativePath.startsWith("media/")
    ? relativePath.slice("media/".length)
    : relativePath;
  return path.join(mediaDir, normalized);
}

function isImageMediaFile(mediaFile) {
  return String(mediaFile?.mimeType || "")
    .toLowerCase()
    .startsWith("image/");
}

function truncateText(value, maxLength = 5000) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n[truncated]`;
}

async function extractMediaText(userId, mediaFile, settings) {
  if (!mediaFile || isImageMediaFile(mediaFile)) return "";

  if (transcriptionService.isAudioMediaFile(mediaFile)) {
    try {
      const transcript = await transcriptionService.transcribeMediaFile(
        userId,
        mediaFile,
        {
          providerId: settings.transcriptionProviderId,
          model: settings.transcriptionModel,
          language: "id",
        },
      );
      return transcript ? `Audio transcript:\n${transcript}` : "";
    } catch (error) {
      return `[Audio could not be transcribed: ${mediaFile.originalName || "audio"}; reason: ${error.message}]`;
    }
  }

  const filePath = resolveMediaFilePath(mediaFile);
  if (!filePath || !fs.existsSync(filePath)) {
    return `[Attachment unavailable: ${mediaFile.originalName || "file"}]`;
  }

  try {
    const text = await knowledgeService.extractText({
      path: filePath,
      filename: mediaFile.fileName || mediaFile.originalName || "attachment",
      originalname: mediaFile.originalName || mediaFile.fileName || "attachment",
      mimetype: mediaFile.mimeType || "application/octet-stream",
    });
    return truncateText(text, 6000);
  } catch (error) {
    return `[Attachment could not be extracted: ${mediaFile.originalName || "file"}; mimeType: ${mediaFile.mimeType || "unknown"}; reason: ${error.message}]`;
  }
}

function buildImageBlock(mediaFile) {
  const filePath = resolveMediaFilePath(mediaFile);
  if (!filePath || !fs.existsSync(filePath)) return null;

  const maxInlineBytes = 5 * 1024 * 1024;
  if (mediaFile?.size && Number(mediaFile.size) > maxInlineBytes) {
    return null;
  }

  const base64 = fs.readFileSync(filePath).toString("base64");
  return {
    type: "image_url",
    image_url: {
      url: `data:${mediaFile.mimeType || "image/png"};base64,${base64}`,
    },
  };
}

async function enrichMessagesForAutoReply(userId, messages, settings) {
  const imageBlocks = [];
  const enriched = [];

  for (const message of messages) {
    const mediaFile = message.mediaFile || null;
    let crmContent = String(message.body || "").trim();

    if (mediaFile) {
      const attachmentName =
        mediaFile.originalName || mediaFile.fileName || "file";
      if (isImageMediaFile(mediaFile)) {
        const imageBlock = buildImageBlock(mediaFile);
        crmContent = [
          crmContent,
          imageBlock
            ? `[Image attached: ${attachmentName}. Analyze the attached image directly.]`
            : `[Image attached but too large or unavailable: ${attachmentName}]`,
        ]
          .filter(Boolean)
          .join("\n");
        if (imageBlock && imageBlocks.length < 3) {
          imageBlocks.push(imageBlock);
        }
      } else {
        const extractedText = await extractMediaText(userId, mediaFile, settings);
        crmContent = [
          crmContent,
          `[Attachment: ${attachmentName}; mimeType: ${mediaFile.mimeType || "unknown"}]`,
          extractedText ? `Extracted attachment text:\n${extractedText}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      }
    }

    enriched.push({ ...message, crmContent });
  }

  return { messages: enriched, imageBlocks };
}

function buildPrompt({ chat, messages, snippets, settings }) {
  const channel =
    chat?.contact?.externalId &&
    String(chat.contact.externalId).startsWith("tg:")
      ? "Telegram"
      : "WhatsApp";
  const assistantName =
    String(settings.assistantName || "").trim() || "Wanie CRM Assistant";
  const businessName = String(settings.businessName || "").trim();
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
      return `${role}: ${message.crmContent || message.body || "[attachment]"}`;
    })
    .join("\n");

  return [
    businessName
      ? `You are ${assistantName}, the CRM assistant for ${businessName}, replying to a ${channel} customer in Indonesian.`
      : `You are ${assistantName}, a CRM assistant replying to a ${channel} customer in Indonesian.`,
    `If the customer asks who you are, answer using this assistant identity: ${assistantName}${businessName ? ` from ${businessName}` : ""}.`,
    `Persona and brand voice: ${settings.persona || "Ramah, jelas, profesional, dan membantu."}`,
    `Agent behavior and SOP: ${settings.agentInstructions || "Pahami kebutuhan customer, jawab ringkas dan membantu, gunakan knowledge base bila tersedia, dan arahkan ke admin bila informasi tidak cukup."}`,
    "Answer only using the provided knowledge snippets and conversation context.",
    "If the latest customer message is only an acknowledgement, thanks, or closing phrase such as ok, okay, noted, thanks, sip, siap, or baik, do not introduce prices, product details, payment details, or new knowledge. Reply with a short acknowledgement only.",
    "If the knowledge is insufficient, use the fallback message and do not invent details.",
    "Do not use Markdown formatting in the final reply.",
    "For links, write the plain URL only. Never use Markdown link syntax like [text](https://example.com).",
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

function isImageKnowledgeSource(source) {
  return (
    source?.metadata?.mediaType === "image" ||
    String(source?.mimeType || source?.metadata?.mimeType || "")
      .toLowerCase()
      .startsWith("image/")
  );
}

function imageKnowledgeSources(sources = []) {
  const seen = new Set();
  return sources.filter((source) => {
    if (!isImageKnowledgeSource(source)) return false;
    if (source.searchMode !== "image-intent") return false;
    const key = source.documentId || source.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 1);
}

function latestMessageAllowsImageAttachment(text) {
  const normalized = String(text || "").toLowerCase();
  return /\b(qris|qr|bayar|pembayaran|payment|transfer|rekening|metode\s+bayar|metode\s+pembayaran|price|pricelist|harga|tarif|biaya|paket|rate|rates|berapa|menu|katalog|catalog|brosur|brochure|gambar|image|foto|photo)\b/i.test(
    normalized,
  );
}

async function createMediaFileFromKnowledgeSource(userId, source) {
  const relativePath = String(source?.metadata?.relativePath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim();
  if (!relativePath) return null;

  const knowledgeRoot = path.resolve(knowledgeDir);
  const sourcePath = path.resolve(knowledgeDir, relativePath);
  if (
    !sourcePath.startsWith(`${knowledgeRoot}${path.sep}`) ||
    !fs.existsSync(sourcePath)
  ) {
    return null;
  }

  const ext = path.extname(source.fileName || relativePath) || ".png";
  const filename = `${crypto.randomUUID()}${ext}`;
  const targetPath = path.join(mediaDir, filename);
  if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
  }
  fs.copyFileSync(sourcePath, targetPath);
  const stat = fs.statSync(targetPath);

  return chatService.createMediaFile(userId, {
    filename,
    originalname: source.fileName || path.basename(relativePath),
    mimetype:
      source.mimeType ||
      source.metadata?.mimeType ||
      "application/octet-stream",
    size: stat.size,
  });
}

async function deliverOutgoingMessageWithRetry({
  userId,
  outgoing,
  sessionManager,
  io,
}) {
  const message = outgoing?.message;
  if (!message) return false;

  const deliveryJob = await outboundDeliveryService.enqueueMessage({
    userId,
    messageId: message.id,
    sessionManager,
    io,
  });

  return deliveryJob?.status === "delivered";
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
    skipCrmAutoPause: true,
  });

  if (io && userRoom) {
    io.to(userRoom(userId)).emit("new_message", outgoing.message);
    io.to(userRoom(userId)).emit("contact_list_update", outgoing.chat);
  }

  await deliverOutgoingMessageWithRetry({
    userId,
    outgoing,
    sessionManager,
    io,
  });

  return outgoing;
}

async function generateDraft(userId, chatId, { inboundMessage } = {}) {
  const chat = await chatService.getChatWithContact(userId, chatId);
  if (!chat) throw new Error("Chat not found.");

  const settings = await crmService.getSettings(userId);
  const messageResult = await chatService.listMessages(userId, chatId, {
    take: 12,
  });
  const messages = messageResult.messages || [];
  const inboundMessageInHistory =
    inboundMessage?.id &&
    messages.some((message) => message.id === inboundMessage.id);
  const contextMessages =
    inboundMessage && !inboundMessageInHistory
      ? [...messages, inboundMessage]
      : messages;
  const enrichedContext = await enrichMessagesForAutoReply(
    userId,
    contextMessages,
    settings,
  );
  const contextMessagesForPrompt = enrichedContext.messages;
  const lastInbound = [...contextMessagesForPrompt]
    .reverse()
    .find(
      (message) =>
        isInbound(message) &&
        String(message.crmContent || message.body || "").trim(),
    );

  if (!String(lastInbound?.crmContent || lastInbound?.body || "").trim()) {
    throw new Error("No inbound customer message found for this chat.");
  }

  const lastInboundText = String(lastInbound.crmContent || lastInbound.body || "");
  if (isClosingOrAcknowledgement(lastInboundText)) {
    return {
      draft: buildClosingAcknowledgement(lastInboundText),
      sources: [],
      mediaSources: [],
      conversationState: "closing_acknowledgement",
    };
  }

  const conversationState = await classifyConversationState(
    userId,
    lastInboundText,
    contextMessagesForPrompt,
    settings,
  );
  if (
    ["closing", "thanks", "acknowledgement"].includes(
      conversationState.state,
    ) &&
    conversationState.confidence >= 0.72
  ) {
    return {
      draft: buildClosingAcknowledgement(lastInboundText),
      sources: [],
      mediaSources: [],
      conversationState: conversationState.state,
      conversationStateReason: conversationState.reason,
    };
  }

  const knowledgeQuery =
    contextMessagesForPrompt
      .filter(
        (message) => isInbound(message) && (message.crmContent || message.body),
      )
      .slice(-4)
      .map((message) => message.crmContent || message.body)
      .join("\n") ||
    lastInbound.crmContent ||
    lastInbound.body;

  const snippets = await knowledgeService.searchChunks(userId, knowledgeQuery, {
    limit: settings.maxChunks,
    intentQuery: lastInboundText,
  });
  const prompt = buildPrompt({
    chat,
    messages: contextMessagesForPrompt,
    snippets,
    settings,
  });
  const userContent = enrichedContext.imageBlocks.length
    ? [
        { type: "text", text: prompt },
        ...enrichedContext.imageBlocks,
      ]
    : prompt;
  const result = await llmService.generate(userId, {
    messages: [
      {
        role: "user",
        content: userContent,
      },
    ],
  });

  return {
    draft: sanitizeCustomerReply(result?.text || settings.fallbackMessage),
    sources: snippets,
    mediaSources: latestMessageAllowsImageAttachment(lastInboundText)
      ? imageKnowledgeSources(snippets)
      : [],
  };
}

async function generateDraftWithRetry(userId, chatId, options = {}) {
  return retryOperation(() => generateDraft(userId, chatId, options), {
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
          `Assistant identity: ${settings.assistantName || "Wanie CRM Assistant"}${settings.businessName ? ` for ${settings.businessName}` : ""}.`,
          `Persona and brand voice: ${settings.persona || "Ramah, jelas, profesional, dan membantu."}`,
          `Agent behavior and SOP: ${settings.agentInstructions || "Pahami kebutuhan customer, jawab ringkas dan membantu, gunakan knowledge base bila tersedia, dan arahkan ke admin bila informasi tidak cukup."}`,
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
    mediaSources: imageKnowledgeSources(snippets),
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
      const result = await generateDraftWithRetry(userId, chat.id, {
        inboundMessage,
      });
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
      if (isNoInboundTextError(error)) {
        await crmService.createAutomationLog(userId, {
          chatId: chat.id,
          mode,
          action: "skipped",
          reason: "no-inbound-text",
          inboundMessageId: inboundMessage?.id,
        });
        return { skipped: true, mode, reason: "no-inbound-text" };
      }

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
  const pause = await crmService.getChatPause(userId, chat.id);
  if (pause) {
    await crmService.createAutomationLog(userId, {
      chatId: chat.id,
      mode,
      action: "skipped",
      reason: "admin-paused",
      inboundMessageId: inboundMessage?.id,
      metadata: {
        pausedUntil: pause.pausedUntil,
        pauseReason: pause.reason,
      },
    });

    if (io && userRoom) {
      io.to(userRoom(userId)).emit("crm_activity_update", {
        chatId: chat.id,
        action: "skipped",
      });
    }

    return {
      skipped: true,
      mode,
      reason: "admin-paused",
      pausedUntil: pause.pausedUntil,
    };
  }

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
    result = await generateDraftWithRetry(userId, chat.id, { inboundMessage });
  } catch (error) {
    if (isNoInboundTextError(error)) {
      await crmService.createAutomationLog(userId, {
        chatId: chat.id,
        mode,
        action: "skipped",
        reason: "no-inbound-text",
        inboundMessageId: inboundMessage?.id,
      });
      return { skipped: true, mode, reason: "no-inbound-text" };
    }

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
      draft: sanitizeCustomerReply(fallbackDraft),
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
      metadata: result.conversationState
        ? {
            conversationState: result.conversationState,
            conversationStateReason: result.conversationStateReason || null,
          }
        : undefined,
    });
    return { skipped: true, mode, reason: "empty-draft" };
  }

  const outgoing = await chatService.createOutgoingMessage({
    userId,
    chatId: chat.id,
    body: result.draft,
    type: "text",
    skipCrmAutoPause: true,
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
      io,
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
        retryAttempts: outboundDeliveryService.DEFAULT_MAX_ATTEMPTS,
      },
    });
    throw error;
  }

  if (!delivered) {
    console.warn(
      `[CrmAutoReply] Delivery queued for retry for message ${outgoing.message.id}`,
    );
  }

  const sentMediaMessages = [];
  const mediaSources = (result.mediaSources || []).slice(0, 1);
  for (const source of mediaSources) {
    const mediaFile = await createMediaFileFromKnowledgeSource(userId, source);
    if (!mediaFile) continue;

    const mediaOutgoing = await chatService.createOutgoingMessage({
      userId,
      chatId: chat.id,
      body: source.fileName || "",
      type: "image",
      mediaFileId: mediaFile.id,
      skipCrmAutoPause: true,
    });

    sentMediaMessages.push(mediaOutgoing.message);

    if (io && userRoom) {
      io.to(userRoom(userId)).emit("new_message", mediaOutgoing.message);
      io.to(userRoom(userId)).emit("contact_list_update", mediaOutgoing.chat);
    }

    await deliverOutgoingMessageWithRetry({
      userId,
      outgoing: mediaOutgoing,
      sessionManager,
      io,
    });
  }

  await crmService.createAutomationLog(userId, {
    chatId: chat.id,
    mode,
    action: "auto_sent",
    inboundMessageId: inboundMessage?.id,
    outboundMessageId: outgoing.message.id,
    draft: result.draft,
    sources: result.sources || [],
    metadata:
      result.fallbackReason || result.conversationState
        ? {
            ...(result.fallbackReason
              ? {
                  fallbackReason: result.fallbackReason,
                  retryAttempts: generationRetryDelaysMs.length,
                }
              : {}),
            ...(result.conversationState
              ? {
                  conversationState: result.conversationState,
                  conversationStateReason:
                    result.conversationStateReason || null,
                }
              : {}),
          }
        : undefined,
  });

  if (io && userRoom) {
    io.to(userRoom(userId)).emit("crm_activity_update", {
      chatId: chat.id,
      action: "auto_sent",
    });
  }

  return {
    ok: true,
    mode,
    message: outgoing.message,
    mediaMessages: sentMediaMessages,
    sources: result.sources,
  };
}

module.exports = {
  generateDraft,
  testKnowledgeChat,
  maybeAutoReply,
};
