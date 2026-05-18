const path = require("path");
const { prisma } = require("../database/client");
const { createAvatarDataUrl } = require("../utils/avatar");
const crmService = require("./crm-service");
const { v4: uuidv4 } = require("uuid");

let incomingMessageQueue = Promise.resolve();

// Retry operation with exponential backoff for SQLite "database is busy" errors (P1008).
// This helps handle transient database lock situations that can occur during high concurrency.
// Retries 4 times with delays: 0ms (immediate), 100ms, 250ms, 500ms before giving up.
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

function enqueueIncomingMessage(task) {
  const nextRun = incomingMessageQueue.then(task, task);
  incomingMessageQueue = nextRun.catch(() => {});
  return nextRun;
}

function mapMessage(message) {
  return {
    id: message.id,
    chatId: message.chatId,
    sessionId: message.sessionId,
    mediaFileId: message.mediaFileId,
    replyToId: message.replyToId,
    externalMessageId: message.externalMessageId,
    sender: message.sender,
    receiver: message.receiver,
    body: message.body,
    type: message.type,
    direction: message.direction,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    mediaFile: message.mediaFile || null,
    replyTo: message.replyTo
      ? {
          id: message.replyTo.id,
          body: message.replyTo.body,
          type: message.replyTo.type,
          sender: message.replyTo.sender,
          direction: message.replyTo.direction,
          mediaFile: message.replyTo.mediaFile || null,
        }
      : null,
    statuses: message.statuses || [],
  };
}

function getChatTransportType(contactExternalId) {
  const normalized = String(contactExternalId || "").toLowerCase();
  if (normalized.startsWith("tg:")) return "telegram";
  if (normalized.startsWith("wa:")) return "whatsapp";
  if (
    normalized.endsWith("@c.us") ||
    normalized.endsWith("@g.us") ||
    normalized.endsWith("@lid")
  )
    return "whatsapp";
  return null;
}

function mapChat(chat) {
  const lastMessage = chat.messages?.[0] ? mapMessage(chat.messages[0]) : null;
  const transportType = getChatTransportType(chat.contact.externalId);
  return {
    id: chat.id,
    title: chat.title,
    sessionId: chat.sessionId,
    pinnedAt: chat.pinnedAt || null,
    transportType,
    contact: {
      id: chat.contact.id,
      externalId: chat.contact.externalId,
      persona: chat.contact.persona || null,
      displayName: chat.contact.displayName,
      avatarUrl: chat.contact.avatarUrl,
      unreadCount: chat.contact.unreadCount,
      lastMessagePreview: chat.contact.lastMessagePreview,
      lastMessageAt: chat.contact.lastMessageAt,
    },
    lastMessage,
    updatedAt: chat.updatedAt,
  };
}

function recentChatTimestamp(chat) {
  return chat?.contact?.lastMessageAt || chat?.lastMessage?.createdAt || null;
}

function sortChatsByRecentActivity(chats) {
  return [...chats].sort((left, right) => {
    // Pinned chats first (newest pinned first)
    const leftPinned = left.pinnedAt ? new Date(left.pinnedAt) : null;
    const rightPinned = right.pinnedAt ? new Date(right.pinnedAt) : null;

    if (leftPinned && rightPinned) {
      return rightPinned - leftPinned;
    }

    if (leftPinned) return -1;
    if (rightPinned) return 1;

    const leftRecent = recentChatTimestamp(left);
    const rightRecent = recentChatTimestamp(right);

    if (leftRecent && rightRecent) {
      return new Date(rightRecent) - new Date(leftRecent);
    }

    if (rightRecent) return 1;
    if (leftRecent) return -1;

    return new Date(right.updatedAt) - new Date(left.updatedAt);
  });
}

function escapeLike(value) {
  return String(value).replace(/[%_]/g, (match) => `\\${match}`);
}

function fileLabelForType(type) {
  const labels = {
    image: "Image",
    video: "Video",
    audio: "Audio",
    document: "Document",
    sticker: "Sticker",
  };

  return labels[type] || "Attachment";
}

function sanitizedPreview(body, type) {
  return body || fileLabelForType(type);
}

function isWhatsAppConversationId(externalId) {
  const normalized = String(externalId || "").toLowerCase();
  return (
    normalized.endsWith("@c.us") ||
    normalized.endsWith("@g.us") ||
    normalized.endsWith("@lid")
  );
}

function pickDisplayName(...values) {
  return (
    values.map((value) => String(value || "").trim()).find(Boolean) || "Unknown"
  );
}

function mapImportedMessageType(type) {
  const normalized = String(type || "text").toLowerCase();
  if (normalized === "image") return "image";
  if (normalized === "video") return "video";
  if (normalized === "audio" || normalized === "ptt" || normalized === "voice")
    return "audio";
  if (normalized === "sticker") return "sticker";
  if (normalized === "document") return "document";
  return "text";
}

function importedStatuses(direction, ack) {
  if (direction === "inbound") {
    return [{ status: "delivered" }];
  }

  if (ack >= 3) {
    return [{ status: "sent" }, { status: "delivered" }, { status: "read" }];
  }

  if (ack >= 2) {
    return [{ status: "sent" }, { status: "delivered" }];
  }

  return [{ status: "sent" }];
}

async function loadChatSummary(chatId) {
  const chat = await retryOnSqliteTimeout(() =>
    prisma.chat.findUnique({
      where: { id: chatId },
      include: {
        contact: true,
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: {
            statuses: {
              orderBy: { createdAt: "asc" },
            },
            mediaFile: true,
            replyTo: {
              include: {
                mediaFile: true,
              },
            },
          },
        },
      },
    }),
  );

  return chat ? mapChat(chat) : null;
}

async function getChatWithContact(userId, chatId) {
  return retryOnSqliteTimeout(() =>
    prisma.chat.findFirst({
      where: { id: chatId, userId },
      include: { contact: true },
    }),
  );
}

async function ensureWelcomeWorkspace(userId) {
  const contact = await retryOnSqliteTimeout(() =>
    prisma.contact.upsert({
      where: {
        userId_externalId: {
          userId,
          externalId: "openwa:assistant",
        },
      },
      update: {},
      create: {
        userId,
        externalId: "openwa:assistant",
        displayName: "OpenWA Assistant",
        avatarUrl: createAvatarDataUrl("OpenWA Assistant", "openwa:assistant"),
      },
    }),
  );

  const existingChat = await retryOnSqliteTimeout(() =>
    prisma.chat.findUnique({
      where: {
        userId_contactId: {
          userId,
          contactId: contact.id,
        },
      },
    }),
  );

  if (existingChat) {
    // Ensure assistant chat is pinned so it appears at the top
    if (!existingChat.pinnedAt) {
      const updated = await retryOnSqliteTimeout(() =>
        prisma.chat.update({
          where: { id: existingChat.id },
          data: { pinnedAt: new Date() },
        }),
      );
      return updated;
    }

    return existingChat;
  }

  const chat = await retryOnSqliteTimeout(() =>
    prisma.chat.create({
      data: {
        userId,
        contactId: contact.id,
        title: contact.displayName,
        messages: {
          create: {
            sender: "system",
            receiver: `user:${userId}`,
            body: "Welcome to OpenWA! I'm your AI assistant. I can autonomously set up a new WhatsApp device for you. Shall we add one now?",
            type: "text",
            direction: "inbound",
            statuses: {
              create: [{ status: "delivered" }, { status: "read" }],
            },
          },
        },
      },
    }),
  );

  await retryOnSqliteTimeout(() =>
    prisma.contact.update({
      where: { id: contact.id },
      data: {
        lastMessagePreview:
          "Welcome to OpenWA! I'm your AI assistant. I can autonomously set up a new WhatsApp device for you. Shall we add one now?",
        lastMessageAt: new Date(),
        unreadCount: 0,
      },
    }),
  );

  return chat;
}

async function createSessionCompanionChat(userId, session) {
  const externalId = `session:${session.id}:assistant`;
  const displayName = `${session.name} Assistant`;
  const contact = await retryOnSqliteTimeout(() =>
    prisma.contact.upsert({
      where: {
        userId_externalId: {
          userId,
          externalId,
        },
      },
      update: {
        displayName,
        sessionId: session.id,
        avatarUrl: createAvatarDataUrl(displayName, externalId),
      },
      create: {
        userId,
        sessionId: session.id,
        externalId,
        displayName,
        avatarUrl: createAvatarDataUrl(displayName, externalId),
      },
    }),
  );

  const existingChat = await prisma.chat.findUnique({
    where: {
      userId_contactId: {
        userId,
        contactId: contact.id,
      },
    },
  });

  if (!existingChat) {
    await prisma.chat.create({
      data: {
        userId,
        sessionId: session.id,
        contactId: contact.id,
        title: displayName,
        // Pin session companion chats so AI assistants are grouped at top
        pinnedAt: new Date(),
        messages: {
          create: {
            sender: externalId,
            receiver: `user:${userId}`,
            body: `Session ${session.name} is ready. Would you like me to connect it and generate a QR code for you?`,
            type: "text",
            direction: "inbound",
            statuses: {
              create: [{ status: "delivered" }],
            },
          },
        },
      },
    });

    await prisma.contact.update({
      where: { id: contact.id },
      data: {
        lastMessagePreview: `Session ${session.name} is ready. Would you like me to connect it and generate a QR code for you?`,
        lastMessageAt: new Date(),
      },
    });
  }
}

async function createAssistantConversation(userId, { title } = {}) {
  const externalId = `openwa:assistant:${uuidv4()}`;
  const displayName = title
    ? String(title).trim()
    : `Assistant ${new Date().toLocaleString()}`;

  const contact = await retryOnSqliteTimeout(() =>
    prisma.contact.create({
      data: {
        userId,
        externalId,
        displayName,
        avatarUrl: createAvatarDataUrl(displayName, externalId),
      },
    }),
  );

  const chat = await retryOnSqliteTimeout(() =>
    prisma.chat.create({
      data: {
        userId,
        sessionId: null,
        contactId: contact.id,
        title: displayName,
        pinnedAt: new Date(),
        messages: {
          create: {
            sender: externalId,
            receiver: `user:${userId}`,
            body: "New assistant conversation started. How can I help you today?",
            type: "text",
            direction: "inbound",
            statuses: {
              create: [{ status: "delivered" }],
            },
          },
        },
      },
      include: { contact: true },
    }),
  );

  await retryOnSqliteTimeout(() =>
    prisma.contact.update({
      where: { id: contact.id },
      data: {
        lastMessagePreview:
          "New assistant conversation started. How can I help you today?",
        lastMessageAt: new Date(),
      },
    }),
  );

  return loadChatSummary(chat.id);
}

async function listChats(userId, sessionId, search) {
  const normalizedSearch = String(search || "").trim();
  const chats = await retryOnSqliteTimeout(async () => {
    return prisma.chat.findMany({
      where: {
        userId,
        NOT: {
          contact: {
            externalId: {
              endsWith: "@broadcast",
            },
          },
        },
        ...(sessionId ? { sessionId } : {}),
        ...(normalizedSearch
          ? {
              OR: [
                {
                  title: {
                    contains: normalizedSearch,
                  },
                },
                {
                  contact: {
                    displayName: {
                      contains: normalizedSearch,
                    },
                  },
                },
                {
                  contact: {
                    lastMessagePreview: {
                      contains: normalizedSearch,
                    },
                  },
                },
              ],
            }
          : {}),
      },
      include: {
        contact: true,
        messages: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: {
            statuses: {
              orderBy: { createdAt: "asc" },
            },
            mediaFile: true,
            replyTo: {
              include: {
                mediaFile: true,
              },
            },
          },
        },
      },
      orderBy: { updatedAt: "desc" },
    });
  });

  return sortChatsByRecentActivity(chats.map(mapChat));
}

async function listMessages(userId, chatId, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.take) || 50, 100));
  const search = String(options.search || "").trim();
  const before = options.before ? new Date(options.before) : null;

  const chat = await retryOnSqliteTimeout(() =>
    prisma.chat.findFirst({
      where: {
        id: chatId,
        userId,
      },
    }),
  );

  if (!chat) {
    throw new Error("Chat not found.");
  }

  const where = {
    chatId,
    ...(before && !Number.isNaN(before.getTime())
      ? {
          createdAt: {
            lt: before,
          },
        }
      : {}),
    ...(search
      ? {
          OR: [
            {
              body: {
                contains: search,
              },
            },
            {
              sender: {
                contains: search,
              },
            },
          ],
        }
      : {}),
  };

  const results = await retryOnSqliteTimeout(() =>
    prisma.message.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      include: {
        statuses: {
          orderBy: { createdAt: "asc" },
        },
        mediaFile: true,
        replyTo: {
          include: {
            mediaFile: true,
          },
        },
      },
    }),
  );

  const hasMore = results.length > limit;
  const items = (hasMore ? results.slice(0, limit) : results).reverse();

  return {
    messages: items.map(mapMessage),
    hasMore,
    nextBefore: items.length > 0 ? items[0].createdAt : null,
  };
}

async function createMediaFile(userId, file) {
  return prisma.mediaFile.create({
    data: {
      userId,
      fileName: file.filename,
      originalName: file.originalname,
      mimeType: file.mimetype || "application/octet-stream",
      size: file.size,
      relativePath: path.join("media", file.filename).replaceAll("\\", "/"),
    },
  });
}

async function touchContactPreview(contactId, preview, unreadDelta = 0) {
  return prisma.contact.update({
    where: { id: contactId },
    data: {
      lastMessagePreview: preview,
      lastMessageAt: new Date(),
      unreadCount: unreadDelta > 0 ? { increment: unreadDelta } : undefined,
    },
  });
}

async function createOutgoingMessage({
  userId,
  chatId,
  body,
  type = "text",
  mediaFileId = null,
  replyToId = null,
  skipCrmAutoPause = false,
}) {
  const chat = await retryOnSqliteTimeout(async () => {
    return prisma.chat.findFirst({
      where: { id: chatId, userId },
      include: { contact: true },
    });
  });

  if (!chat) {
    throw new Error("Chat not found.");
  }

  if (replyToId) {
    const replyToMessage = await retryOnSqliteTimeout(async () => {
      return prisma.message.findFirst({
        where: {
          id: replyToId,
          chatId: chat.id,
        },
      });
    });

    if (!replyToMessage) {
      throw new Error("Reply target not found.");
    }
  }

  if (mediaFileId) {
    const mediaFile = await retryOnSqliteTimeout(() =>
      prisma.mediaFile.findFirst({
        where: {
          id: mediaFileId,
          userId,
        },
      }),
    );

    if (!mediaFile) {
      throw new Error("Media file not found.");
    }
  }

  const message = await retryOnSqliteTimeout(async () => {
    return prisma.message.create({
      data: {
        chatId: chat.id,
        sessionId: chat.sessionId,
        mediaFileId,
        replyToId,
        sender: `user:${userId}`,
        receiver: chat.contact.externalId,
        body: body || null,
        type,
        direction: "outbound",
        statuses: {
          create: [{ status: "sent" }],
        },
      },
      include: {
        statuses: {
          orderBy: { createdAt: "asc" },
        },
        mediaFile: true,
        replyTo: {
          include: {
            mediaFile: true,
          },
        },
      },
    });
  });

  await retryOnSqliteTimeout(async () => {
    return prisma.chat.update({
      where: { id: chat.id },
      data: { updatedAt: new Date() },
    });
  });
  await touchContactPreview(chat.contactId, sanitizedPreview(body, type), 0);

  if (!skipCrmAutoPause) {
    await crmService
      .pauseAutoReplyForChat(userId, chat.id, {
        reason: "admin-replied",
      })
      .catch((error) => {
        console.warn(
          `[ChatService] Failed to pause CRM auto-reply for chat ${chat.id}:`,
          error.message,
        );
      });
  }

  return {
    chat: await loadChatSummary(chat.id),
    message: mapMessage(message),
  };
}

async function storeExternalOutgoingMessage({
  userId,
  sessionId,
  receiver,
  body,
  type = "text",
  mediaFileId = null,
  externalMessageId = null,
  displayName = null,
}) {
  const chat = await ensureChatForIncoming({
    userId,
    sessionId,
    externalId: receiver,
    displayName: displayName || receiver,
  });

  const existing = externalMessageId
    ? await retryOnSqliteTimeout(() =>
        prisma.message.findFirst({
          where: {
            chatId: chat.id,
            externalMessageId,
          },
          include: {
            statuses: {
              orderBy: { createdAt: "asc" },
            },
            mediaFile: true,
            replyTo: {
              include: {
                mediaFile: true,
              },
            },
          },
        }),
      )
    : null;

  if (existing) {
    return {
      chat: await loadChatSummary(chat.id),
      message: mapMessage(existing),
      duplicate: true,
    };
  }

  const recentMatching = await retryOnSqliteTimeout(() =>
    prisma.message.findFirst({
      where: {
        chatId: chat.id,
        direction: "outbound",
        body: body || null,
        type,
        createdAt: { gte: new Date(Date.now() - 2 * 60 * 1000) },
      },
      orderBy: { createdAt: "desc" },
      include: {
        statuses: {
          orderBy: { createdAt: "asc" },
        },
        mediaFile: true,
        replyTo: {
          include: {
            mediaFile: true,
          },
        },
      },
    }),
  );

  if (recentMatching) {
    const updated = externalMessageId
      ? await retryOnSqliteTimeout(() =>
          prisma.message.update({
            where: { id: recentMatching.id },
            data: { externalMessageId },
            include: {
              statuses: {
                orderBy: { createdAt: "asc" },
              },
              mediaFile: true,
              replyTo: {
                include: {
                  mediaFile: true,
                },
              },
            },
          }),
        )
      : recentMatching;

    return {
      chat: await loadChatSummary(chat.id),
      message: mapMessage(updated),
      duplicate: true,
    };
  }

  const message = await retryOnSqliteTimeout(() =>
    prisma.message.create({
      data: {
        chatId: chat.id,
        sessionId,
        mediaFileId,
        externalMessageId,
        sender: `user:${userId}`,
        receiver,
        body: body || null,
        type,
        direction: "outbound",
        statuses: {
          create: [{ status: "sent" }, { status: "delivered" }],
        },
      },
      include: {
        statuses: {
          orderBy: { createdAt: "asc" },
        },
        mediaFile: true,
        replyTo: {
          include: {
            mediaFile: true,
          },
        },
      },
    }),
  );

  await retryOnSqliteTimeout(() =>
    prisma.chat.update({
      where: { id: chat.id },
      data: { updatedAt: new Date() },
    }),
  );
  await touchContactPreview(chat.contactId, sanitizedPreview(body, type), 0);
  await crmService.pauseAutoReplyForChat(userId, chat.id, {
    reason: "admin-replied-whatsapp-app",
  });

  return {
    chat: await loadChatSummary(chat.id),
    message: mapMessage(message),
  };
}

async function addMessageStatus(messageId, status) {
  return prisma.messageStatus.create({
    data: {
      messageId,
      status,
    },
  });
}

async function ensureChatForIncoming({
  userId,
  sessionId,
  externalId,
  displayName,
  avatarUrl = null,
}) {
  const contact = await ensureWhatsappContact({
    userId,
    sessionId,
    externalId,
    displayName,
    avatarUrl,
  });

  return ensureChatForContact(userId, contact.id);
}

async function ensureWhatsappContact({
  userId,
  sessionId,
  externalId,
  displayName,
  avatarUrl = null,
}) {
  const resolvedDisplayName = pickDisplayName(displayName, externalId);
  const existing = await retryOnSqliteTimeout(() =>
    prisma.contact.findUnique({
      where: {
        userId_externalId: {
          userId,
          externalId,
        },
      },
    }),
  );
  const nextAvatarUrl =
    avatarUrl ||
    existing?.avatarUrl ||
    createAvatarDataUrl(resolvedDisplayName, externalId);

  if (existing) {
    return retryOnSqliteTimeout(() =>
      prisma.contact.update({
        where: { id: existing.id },
        data: {
          displayName: resolvedDisplayName,
          sessionId,
          avatarUrl: nextAvatarUrl,
        },
      }),
    );
  }

  return retryOnSqliteTimeout(() =>
    prisma.contact.create({
      data: {
        userId,
        sessionId,
        externalId,
        displayName: resolvedDisplayName,
        avatarUrl: nextAvatarUrl,
      },
    }),
  );
}

async function ensureChatForContact(userId, contactId) {
  const contact = await retryOnSqliteTimeout(() =>
    prisma.contact.findFirst({
      where: {
        id: contactId,
        userId,
      },
    }),
  );

  if (!contact) {
    throw new Error("Contact not found.");
  }

  return retryOnSqliteTimeout(() =>
    prisma.chat.upsert({
      where: {
        userId_contactId: {
          userId,
          contactId: contact.id,
        },
      },
      update: {
        sessionId: contact.sessionId,
        title: contact.displayName,
      },
      create: {
        userId,
        sessionId: contact.sessionId,
        contactId: contact.id,
        title: contact.displayName,
      },
      include: {
        contact: true,
      },
    }),
  );
}

async function createIncomingMessageWithRetry(data) {
  return retryOnSqliteTimeout(() => prisma.message.create(data));
}

async function storeIncomingMessageInChat({
  userId,
  chatId,
  sender,
  body,
  type = "text",
  mediaFileId = null,
  externalMessageId = null,
}) {
  const chat = await retryOnSqliteTimeout(() =>
    prisma.chat.findFirst({
      where: { id: chatId, userId },
      include: { contact: true },
    }),
  );

  if (!chat) {
    throw new Error("Chat not found.");
  }

  if (externalMessageId) {
    const existingMessage = await retryOnSqliteTimeout(() =>
      prisma.message.findFirst({
        where: {
          chatId: chat.id,
          externalMessageId,
          direction: "inbound",
        },
        include: {
          statuses: {
            orderBy: { createdAt: "asc" },
          },
          mediaFile: true,
          replyTo: {
            include: {
              mediaFile: true,
            },
          },
        },
      }),
    );

    if (existingMessage) {
      return {
        chat: await loadChatSummary(chat.id),
        message: mapMessage(existingMessage),
      };
    }
  }

  const dataObj = {
    chatId: chat.id,
    sessionId: chat.sessionId,
    sender,
    receiver: `user:${userId}`,
    body,
    type,
    direction: "inbound",
    statuses: {
      create: [{ status: "delivered" }],
    },
  };

  if (mediaFileId) {
    dataObj.mediaFileId = mediaFileId;
  }

  if (externalMessageId) {
    dataObj.externalMessageId = externalMessageId;
  }

  const message = await createIncomingMessageWithRetry({
    data: dataObj,
    include: {
      statuses: {
        orderBy: { createdAt: "asc" },
      },
      mediaFile: true,
      replyTo: {
        include: {
          mediaFile: true,
        },
      },
    },
  });

  await retryOnSqliteTimeout(() =>
    prisma.chat.update({
      where: { id: chat.id },
      data: { updatedAt: new Date() },
    }),
  );

  await retryOnSqliteTimeout(() =>
    touchContactPreview(chat.contactId, sanitizedPreview(body, type), 1),
  );

  return {
    chat: await loadChatSummary(chat.id),
    message: mapMessage(message),
  };
}

async function listContacts(userId, sessionId, search) {
  const normalizedSearch = String(search || "").trim();
  const contacts = await retryOnSqliteTimeout(() =>
    prisma.contact.findMany({
      where: {
        userId,
        ...(sessionId ? { sessionId } : {}),
        AND: [
          {
            OR: [
              { externalId: { endsWith: "@c.us" } },
              { externalId: { endsWith: "@g.us" } },
              { externalId: { endsWith: "@lid" } },
            ],
          },
          ...(normalizedSearch
            ? [
                {
                  OR: [
                    { displayName: { contains: normalizedSearch } },
                    { externalId: { contains: normalizedSearch } },
                  ],
                },
              ]
            : []),
        ],
      },
      include: {
        chats: {
          take: 1,
        },
      },
      orderBy: [{ lastMessageAt: "desc" }, { displayName: "asc" }],
    }),
  );

  return contacts.map((contact) => ({
    id: contact.id,
    externalId: contact.externalId,
    displayName: contact.displayName,
    avatarUrl: contact.avatarUrl,
    lastMessagePreview: contact.lastMessagePreview,
    lastMessageAt: contact.lastMessageAt,
    unreadCount: contact.unreadCount,
    sessionId: contact.sessionId,
    hasChat: contact.chats.length > 0,
    chatId: contact.chats[0]?.id || null,
  }));
}

async function normalizeWhatsappExternalId(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    throw new Error("phoneNumber is required.");
  }

  if (raw.endsWith("@c.us") || raw.endsWith("@g.us") || raw.endsWith("@lid")) {
    return raw;
  }

  const digits = raw.replace(/\D/g, "");
  if (!digits) {
    throw new Error("phoneNumber must contain digits.");
  }

  return `${digits}@c.us`;
}

async function findContactByExternalId(userId, externalId) {
  return retryOnSqliteTimeout(() =>
    prisma.contact.findUnique({
      where: {
        userId_externalId: {
          userId,
          externalId,
        },
      },
    }),
  );
}

async function ensureChatForWhatsappId({
  userId,
  externalId,
  sessionId,
  displayName,
}) {
  let contact = await findContactByExternalId(userId, externalId);

  if (!contact) {
    contact = await ensureWhatsappContact({
      userId,
      sessionId,
      externalId,
      displayName,
    });
  } else if (sessionId && contact.sessionId !== sessionId) {
    contact = await retryOnSqliteTimeout(() =>
      prisma.contact.update({
        where: { id: contact.id },
        data: { sessionId },
      }),
    );
  }

  return openChatForContact(userId, contact.id);
}

async function openChatForContact(userId, contactId) {
  const chat = await ensureChatForContact(userId, contactId);
  return loadChatSummary(chat.id);
}

async function syncWhatsappSnapshot({
  userId,
  sessionId,
  contacts = [],
  chats = [],
}) {
  for (const contactEntry of contacts) {
    if (!isWhatsAppConversationId(contactEntry.externalId)) {
      continue;
    }

    await ensureWhatsappContact({
      userId,
      sessionId,
      externalId: contactEntry.externalId,
      displayName: pickDisplayName(
        contactEntry.name,
        contactEntry.pushname,
        contactEntry.externalId,
      ),
      avatarUrl: contactEntry.avatarUrl || null,
    });
  }

  for (const chatEntry of chats) {
    if (!isWhatsAppConversationId(chatEntry.externalId)) {
      continue;
    }

    const contact = await ensureWhatsappContact({
      userId,
      sessionId,
      externalId: chatEntry.externalId,
      displayName: pickDisplayName(
        chatEntry.name,
        chatEntry.pushname,
        chatEntry.externalId,
      ),
      avatarUrl: chatEntry.avatarUrl || null,
    });

    const chat = await ensureChatForContact(userId, contact.id);
    const sortedMessages = [...(chatEntry.messages || [])].sort(
      (left, right) => new Date(left.createdAt) - new Date(right.createdAt),
    );

    for (const item of sortedMessages) {
      if (!item.externalMessageId) {
        continue;
      }

      const existing = await prisma.message.findFirst({
        where: {
          chatId: chat.id,
          externalMessageId: item.externalMessageId,
        },
      });

      if (existing) {
        continue;
      }

      const direction = item.direction === "outbound" ? "outbound" : "inbound";
      const createdAt = new Date(item.createdAt);
      await prisma.message.create({
        data: {
          chatId: chat.id,
          sessionId,
          externalMessageId: item.externalMessageId,
          sender:
            direction === "outbound"
              ? `user:${userId}`
              : item.sender || chatEntry.externalId,
          receiver:
            direction === "outbound" ? chatEntry.externalId : `user:${userId}`,
          body: item.body || null,
          type: mapImportedMessageType(item.type),
          direction,
          createdAt,
          updatedAt: createdAt,
          statuses: {
            create: importedStatuses(direction, item.ack),
          },
        },
      });
    }

    const latestMessage = await prisma.message.findFirst({
      where: { chatId: chat.id },
      orderBy: { createdAt: "desc" },
    });

    await prisma.chat.update({
      where: { id: chat.id },
      data: {
        updatedAt: latestMessage?.createdAt || new Date(),
      },
    });

    await prisma.contact.update({
      where: { id: contact.id },
      data: {
        lastMessagePreview: latestMessage
          ? sanitizedPreview(latestMessage.body, latestMessage.type)
          : contact.lastMessagePreview,
        lastMessageAt: latestMessage?.createdAt || contact.lastMessageAt,
      },
    });
  }
}

async function storeIncomingMessage({
  userId,
  sessionId,
  sender,
  displayName,
  avatarUrl = null,
  body,
  type = "text",
  mediaFileId = null,
  externalMessageId = null,
}) {
  return enqueueIncomingMessage(async () => {
    const chat = await ensureChatForIncoming({
      userId,
      sessionId,
      externalId: sender,
      displayName: displayName || sender,
      avatarUrl,
    });

    return storeIncomingMessageInChat({
      userId,
      chatId: chat.id,
      sender,
      body,
      type,
      mediaFileId,
      externalMessageId,
    });
  });
}

async function markChatOpened(userId, chatId) {
  const chat = await retryOnSqliteTimeout(() =>
    prisma.chat.findFirst({
      where: { id: chatId, userId },
    }),
  );

  if (!chat) {
    throw new Error("Chat not found.");
  }

  await prisma.contact.update({
    where: { id: chat.contactId },
    data: { unreadCount: 0 },
  });

  const unreadMessages = await prisma.message.findMany({
    where: {
      chatId,
      direction: "inbound",
    },
    select: { id: true },
  });

  await Promise.all(
    unreadMessages.map((message) =>
      prisma.messageStatus.create({
        data: {
          messageId: message.id,
          status: "read",
        },
      }),
    ),
  );
}

async function pinChat(userId, chatId) {
  const chat = await retryOnSqliteTimeout(() =>
    prisma.chat.findFirst({ where: { id: chatId, userId } }),
  );

  if (!chat) {
    throw new Error("Chat not found.");
  }

  await retryOnSqliteTimeout(() =>
    prisma.chat.update({
      where: { id: chat.id },
      data: { pinnedAt: new Date() },
    }),
  );

  return loadChatSummary(chat.id);
}

async function unpinChat(userId, chatId) {
  const chat = await retryOnSqliteTimeout(() =>
    prisma.chat.findFirst({ where: { id: chatId, userId } }),
  );

  if (!chat) {
    throw new Error("Chat not found.");
  }

  await retryOnSqliteTimeout(() =>
    prisma.chat.update({ where: { id: chat.id }, data: { pinnedAt: null } }),
  );

  return loadChatSummary(chat.id);
}

async function deleteMessage(userId, messageId) {
  const message = await retryOnSqliteTimeout(async () => {
    return prisma.message.findFirst({
      where: {
        id: messageId,
        sender: `user:${userId}`,
      },
      include: {
        chat: true,
      },
    });
  });

  if (!message) {
    throw new Error("Message not found or cannot be deleted.");
  }

  const updatedMessage = await retryOnSqliteTimeout(async () => {
    return prisma.message.update({
      where: { id: message.id },
      data: {
        body: "Pesan dihapus",
        mediaFileId: null,
      },
      include: {
        statuses: {
          orderBy: { createdAt: "asc" },
        },
        mediaFile: true,
        replyTo: {
          include: {
            mediaFile: true,
          },
        },
      },
    });
  });

  const latestMessage = await retryOnSqliteTimeout(async () => {
    return prisma.message.findFirst({
      where: { chatId: message.chatId },
      orderBy: { createdAt: "desc" },
    });
  });

  await retryOnSqliteTimeout(async () => {
    return prisma.contact.update({
      where: { id: message.chat.contactId },
      data: {
        lastMessagePreview: latestMessage
          ? sanitizedPreview(latestMessage.body, latestMessage.type)
          : "Belum ada pesan",
        lastMessageAt: latestMessage?.createdAt || null,
      },
    });
  });

  return {
    chat: await loadChatSummary(message.chatId),
    message: mapMessage(updatedMessage),
  };
}

async function forwardMessage(userId, messageId, targetChatId) {
  const sourceMessage = await retryOnSqliteTimeout(async () => {
    return prisma.message.findFirst({
      where: {
        id: messageId,
        chat: {
          userId,
        },
      },
      include: {
        mediaFile: true,
        replyTo: {
          include: {
            mediaFile: true,
          },
        },
      },
    });
  });

  if (!sourceMessage) {
    throw new Error("Source message not found.");
  }

  return createOutgoingMessage({
    userId,
    chatId: targetChatId,
    body: sourceMessage.body,
    type: sourceMessage.type,
    mediaFileId: sourceMessage.mediaFileId || null,
    replyToId: null,
  });
}

async function updateContact(
  userId,
  contactId,
  { displayName, avatarUrl, persona } = {},
) {
  const existing = await retryOnSqliteTimeout(() =>
    prisma.contact.findFirst({ where: { id: contactId, userId } }),
  );

  if (!existing) {
    throw new Error("Contact not found.");
  }

  const data = {};
  if (displayName !== undefined)
    data.displayName = String(displayName).trim() || existing.displayName;
  if (avatarUrl !== undefined) data.avatarUrl = avatarUrl || null;
  if (persona !== undefined) data.persona = persona || null;

  const updated = await retryOnSqliteTimeout(() =>
    prisma.contact.update({ where: { id: contactId }, data }),
  );

  const chat = await retryOnSqliteTimeout(() =>
    prisma.chat.findFirst({ where: { userId, contactId } }),
  );

  if (chat) {
    await retryOnSqliteTimeout(() =>
      prisma.chat.update({
        where: { id: chat.id },
        data: { title: updated.displayName },
      }),
    );
    return loadChatSummary(chat.id);
  }

  return { id: null, contact: updated };
}

async function deleteAssistantConversation(userId, chatId) {
  const chat = await retryOnSqliteTimeout(() =>
    prisma.chat.findFirst({
      where: { id: chatId, userId },
      include: { contact: true },
    }),
  );

  if (!chat) {
    throw new Error("Chat not found.");
  }

  const externalId = chat.contact?.externalId || null;
  const isAssistant =
    externalId &&
    (externalId === "openwa:assistant" ||
      String(externalId).startsWith("openwa:assistant") ||
      String(externalId).endsWith(":assistant"));

  if (!isAssistant) {
    throw new Error("Not an assistant conversation.");
  }

  if (externalId === "openwa:assistant") {
    throw new Error("Cannot delete the default assistant conversation.");
  }

  // Deleting the contact cascades to its chats and messages.
  await retryOnSqliteTimeout(() =>
    prisma.contact.delete({
      where: { id: chat.contactId },
    }),
  );

  return { ok: true };
}

async function deleteChat(userId, chatId) {
  const chat = await retryOnSqliteTimeout(() =>
    prisma.chat.findFirst({
      where: { id: chatId, userId },
      include: { contact: true },
    }),
  );

  if (!chat) {
    throw new Error("Chat not found.");
  }

  // Delete the chat (this will cascade-delete messages)
  await retryOnSqliteTimeout(() =>
    prisma.chat.delete({ where: { id: chat.id } }),
  );

  // Clear contact preview to reflect deleted chat
  await retryOnSqliteTimeout(() =>
    prisma.contact.update({
      where: { id: chat.contactId },
      data: { lastMessagePreview: null, lastMessageAt: null, unreadCount: 0 },
    }),
  );

  return { ok: true };
}

module.exports = {
  addMessageStatus,
  createMediaFile,
  createOutgoingMessage,
  createSessionCompanionChat,
  createAssistantConversation,
  deleteAssistantConversation,
  deleteChat,
  deleteMessage,
  ensureWelcomeWorkspace,
  forwardMessage,
  listContacts,
  listChats,
  listMessages,
  markChatOpened,
  normalizeWhatsappExternalId,
  findContactByExternalId,
  ensureChatForWhatsappId,
  openChatForContact,
  syncWhatsappSnapshot,
  storeIncomingMessage,
  storeIncomingMessageInChat,
  storeExternalOutgoingMessage,
  pinChat,
  unpinChat,
  updateContact,
  getChatWithContact,
};
