const { getUserFromToken } = require("../services/auth-service");
const chatService = require("../services/chat-service");

function userRoom(userId) {
  return `user:${userId}`;
}

function isAssistantExternalId(externalId) {
  return (
    externalId &&
    (externalId === "openwa:assistant" ||
      String(externalId).startsWith("openwa:assistant") ||
      String(externalId).endsWith(":assistant"))
  );
}

async function deliverTelegramMessage(userId, message) {
  if (!String(message?.receiver || "").startsWith("tg:")) return false;

  const TelegramService = require("../services/telegram-service");
  const telegramId = TelegramService.extractTelegramId(message.receiver);
  if (!telegramId) return false;

  if (message.mediaFileId) {
    return TelegramService.sendMedia(
      userId,
      telegramId,
      message.mediaFile,
      message.body,
    );
  }

  return TelegramService.sendMessage(userId, telegramId, message.body || "");
}

function registerSocketHandlers({ io, config, sessionManager }) {
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const user = await getUserFromToken(token, config);

      if (!user) {
        return next(new Error("Unauthorized"));
      }

      socket.user = user;
      return next();
    } catch (error) {
      return next(error);
    }
  });

  io.on("connection", (socket) => {
    socket.join(userRoom(socket.user.id));

    socket.on("send_message", async (payload = {}, ack) => {
      try {
        // If this is an assistant chat, route to agent service
        const agentService = require("../services/agent-service");
        const chat = await chatService.getChatWithContact(
          socket.user.id,
          payload.chatId,
        );
        const externalId = chat?.contact?.externalId || null;

        const normalizedBody = String(payload.body || "").trim();
        if (
          isAssistantExternalId(externalId) &&
          normalizedBody.toLowerCase() === "/new"
        ) {
          const newChat = await chatService.createAssistantConversation(
            socket.user.id,
            {},
          );
          io.to(userRoom(socket.user.id)).emit("contact_list_update", newChat);
          if (ack) {
            ack({ ok: true, chat: newChat });
          }
        } else if (isAssistantExternalId(externalId)) {
          // store outgoing message and let agent handle reply
          await agentService.handleAssistantMessage(
            socket.user.id,
            payload.chatId,
            {
              body: payload.body,
              type: payload.type || "text",
              mediaFileId: payload.mediaFileId || null,
              replyToId: payload.replyToId || null,
            },
            { config, io, socket, sessionManager },
          );
          if (ack) ack({ ok: true });
        } else {
          const result = await chatService.createOutgoingMessage({
            userId: socket.user.id,
            chatId: payload.chatId,
            body: payload.body,
            type: payload.type || "text",
            mediaFileId: payload.mediaFileId || null,
            replyToId: payload.replyToId || null,
          });

          io.to(userRoom(socket.user.id)).emit("new_message", result.message);
          io.to(userRoom(socket.user.id)).emit(
            "contact_list_update",
            result.chat,
          );

          let delivered = false;
          if (result.message.sessionId) {
            await sessionManager.sendMessage(result.message.sessionId, {
              recipient: result.message.receiver,
              body: result.message.body,
              mediaFileId: result.message.mediaFileId,
              mediaPath: result.message.mediaFile?.relativePath || null,
            });
            delivered = true;
          } else {
            delivered = await deliverTelegramMessage(
              socket.user.id,
              result.message,
            );
          }

          if (delivered) {
            await chatService.addMessageStatus(result.message.id, "delivered");
            io.to(userRoom(socket.user.id)).emit("message_status_update", {
              messageId: result.message.id,
              status: "delivered",
            });
          }

          if (ack) {
            ack({ ok: true, message: result.message });
          }
        }
      } catch (error) {
        if (ack) {
          ack({ ok: false, error: error.message });
        }
      }
    });

    socket.on("send_media", async (payload = {}, ack) => {
      try {
        const agentService = require("../services/agent-service");
        const chat = await chatService.getChatWithContact(
          socket.user.id,
          payload.chatId,
        );
        const externalId = chat?.contact?.externalId || null;

        if (isAssistantExternalId(externalId)) {
          await agentService.handleAssistantMessage(
            socket.user.id,
            payload.chatId,
            {
              body: payload.body,
              type: payload.type || "document",
              mediaFileId: payload.mediaFileId || null,
              replyToId: payload.replyToId || null,
            },
            { config, io, socket, sessionManager },
          );
          if (ack) {
            ack({ ok: true });
          }
          return;
        }

        const result = await chatService.createOutgoingMessage({
          userId: socket.user.id,
          chatId: payload.chatId,
          body: payload.body,
          type: payload.type || "document",
          mediaFileId: payload.mediaFileId,
          replyToId: payload.replyToId || null,
        });

        io.to(userRoom(socket.user.id)).emit("new_message", result.message);
        io.to(userRoom(socket.user.id)).emit(
          "contact_list_update",
          result.chat,
        );

        let delivered = false;
        if (result.message.sessionId) {
          await sessionManager.sendMessage(result.message.sessionId, {
            recipient: result.message.receiver,
            body: result.message.body,
            mediaFileId: result.message.mediaFileId,
            mediaPath: result.message.mediaFile?.relativePath || null,
          });
          delivered = true;
        } else {
          delivered = await deliverTelegramMessage(
            socket.user.id,
            result.message,
          );
        }

        if (delivered) {
          await chatService.addMessageStatus(result.message.id, "delivered");
          io.to(userRoom(socket.user.id)).emit("message_status_update", {
            messageId: result.message.id,
            status: "delivered",
          });
        }

        if (ack) {
          ack({ ok: true, message: result.message });
        }
      } catch (error) {
        if (ack) {
          ack({ ok: false, error: error.message });
        }
      }
    });

    socket.on("typing", (payload = {}) => {
      // Broadcast typing events to other sockets in the same user room
      // but exclude the originating socket so the local client doesn't
      // reflect its own typing as "user is typing".
      socket.broadcast.to(userRoom(socket.user.id)).emit("typing_event", {
        chatId: payload.chatId,
        isTyping: Boolean(payload.isTyping),
        userId: socket.user.id,
        name: socket.user.name,
      });
    });

    socket.on("open_chat", async (payload = {}, ack) => {
      try {
        await chatService.markChatOpened(socket.user.id, payload.chatId);
        if (ack) {
          ack({ ok: true });
        }
      } catch (error) {
        if (ack) {
          ack({ ok: false, error: error.message });
        }
      }
    });
  });
}

module.exports = {
  registerSocketHandlers,
  userRoom,
};
