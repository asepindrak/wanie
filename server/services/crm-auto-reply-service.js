const chatService = require("./chat-service");
const crmService = require("./crm-service");
const knowledgeService = require("./knowledge-service");
const llmService = require("./llm-service");

function isInbound(message) {
  return message?.direction === "inbound" || message?.direction === "incoming";
}

function buildPrompt({ chat, messages, snippets, settings }) {
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
    "You are a CRM assistant replying to a WhatsApp customer in Indonesian.",
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

  const snippets = await knowledgeService.searchChunks(userId, lastInbound.body, {
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
      const result = await generateDraft(userId, chat.id);
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

  const guard = await crmService.getAutoReplyGuard(userId, chat.id, settings);
  if (!guard.allowed) {
    await crmService.createAutomationLog(userId, {
      chatId: chat.id,
      mode,
      action: "skipped",
      reason: guard.reason,
      inboundMessageId: inboundMessage?.id,
      metadata: guard.metadata,
    });
    return { skipped: true, mode, reason: guard.reason };
  }

  let result;
  try {
    result = await generateDraft(userId, chat.id);
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

  if (outgoing.message.sessionId) {
    await sessionManager.sendMessage(outgoing.message.sessionId, {
      recipient: outgoing.message.receiver,
      body: outgoing.message.body,
    });

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
