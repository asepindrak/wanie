import { create } from "zustand";
import { apiFetch } from "@/lib/api";

function readToken() {
  if (typeof window === "undefined") {
    return null;
  }

  return window.localStorage.getItem("openwa-token");
}

function writeToken(token) {
  if (typeof window === "undefined") {
    return;
  }

  if (token) {
    window.localStorage.setItem("openwa-token", token);
    return;
  }

  window.localStorage.removeItem("openwa-token");
}

function readTerminalAutoApprove() {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem("openwa-terminal-auto-approve") === "1";
}

function writeTerminalAutoApprove(value) {
  if (typeof window === "undefined") return;
  if (value) {
    window.localStorage.setItem("openwa-terminal-auto-approve", "1");
    return;
  }

  window.localStorage.removeItem("openwa-terminal-auto-approve");
}

function readDefaultAiProviderId() {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem("openwa-default-ai-provider-id");
}

function writeDefaultAiProviderId(val) {
  if (typeof window === "undefined") return;
  if (val) {
    window.localStorage.setItem("openwa-default-ai-provider-id", String(val));
    return;
  }
  window.localStorage.removeItem("openwa-default-ai-provider-id");
}

function readDefaultAiModel() {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem("openwa-default-ai-model");
}

function writeDefaultAiModel(val) {
  if (typeof window === "undefined") return;
  if (val) {
    window.localStorage.setItem("openwa-default-ai-model", String(val));
    return;
  }
  window.localStorage.removeItem("openwa-default-ai-model");
}

function recentChatTimestamp(chat) {
  return chat?.contact?.lastMessageAt || chat?.lastMessage?.createdAt || null;
}

function sortChats(chats) {
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

export const useAppStore = create((set, get) => ({
  token: null,
  user: null,
  terminalAutoApproveAll: readTerminalAutoApprove(),
  defaultAiProviderId: readDefaultAiProviderId(),
  defaultAiModel: readDefaultAiModel(),
  sessions: [],
  chats: [],
  activeChatId: null,
  activeSessionId: null,
  messagesByChat: {},
  messageMetaByChat: {},
  terminalRecordsById: {},
  typingByChat: {},
  socket: null,
  hydrateAuth: () => {
    set({ token: readToken() });
  },
  setAuth: ({ token, user }) => {
    writeToken(token);
    set({ token, user });
  },
  logout: () => {
    writeToken(null);
    get().socket?.close();
    set({
      token: null,
      user: null,
      sessions: [],
      chats: [],
      activeChatId: null,
      activeSessionId: null,
      messagesByChat: {},
      messageMetaByChat: {},
      terminalRecordsById: {},
      typingByChat: {},
      socket: null,
    });
  },
  setBootstrapData: (payload = {}) => {
    const sortedChats = sortChats(payload.chats || []);
    const settings = payload.settings || {};

    // Persist client-side copies so UI reflects server state
    try {
      writeTerminalAutoApprove(!!settings.autoApproveAllTerminalCommands);
      writeDefaultAiProviderId(settings.defaultAiProviderId || null);
      writeDefaultAiModel(settings.defaultAiModel || null);
    } catch (e) {
      // ignore storage errors
    }

    set((state) => ({
      user: payload.user,
      sessions: payload.sessions || [],
      chats: sortedChats,
      terminalAutoApproveAll: !!settings.autoApproveAllTerminalCommands,
      defaultAiProviderId: settings.defaultAiProviderId || null,
      defaultAiModel: settings.defaultAiModel || null,
      activeChatId: payload.activeChatId || sortedChats[0]?.id || null,
      activeSessionId: state.activeSessionId || null,
      messagesByChat: payload.activeChatId
        ? {
            ...state.messagesByChat,
            [payload.activeChatId]: payload.messages || [],
          }
        : state.messagesByChat,
      messageMetaByChat: payload.activeChatId
        ? {
            ...state.messageMetaByChat,
            [payload.activeChatId]: {
              hasMore: Boolean(payload.hasMoreMessages),
              nextBefore: payload.nextBefore || null,
            },
          }
        : state.messageMetaByChat,
    }));
  },
  setMessages: (chatId, messages, meta = null) => {
    set((state) => ({
      messagesByChat: {
        ...state.messagesByChat,
        [chatId]: messages,
      },
      messageMetaByChat: meta
        ? {
            ...state.messageMetaByChat,
            [chatId]: meta,
          }
        : state.messageMetaByChat,
    }));
  },
  prependMessages: (chatId, messages, meta) => {
    set((state) => ({
      messagesByChat: {
        ...state.messagesByChat,
        [chatId]: [...messages, ...(state.messagesByChat[chatId] || [])],
      },
      messageMetaByChat: {
        ...state.messageMetaByChat,
        [chatId]: meta,
      },
    }));
  },
  setActiveChat: (chatId) => set({ activeChatId: chatId }),
  setActiveSession: (sessionId) => set({ activeSessionId: sessionId }),
  upsertSession: (session) => {
    set((state) => {
      const normalizedSession = {
        ...session,
        id: session.id || session.sessionId,
      };
      const sessions = state.sessions.some(
        (item) => item.id === normalizedSession.id,
      )
        ? state.sessions.map((item) =>
            item.id === normalizedSession.id
              ? { ...item, ...normalizedSession }
              : item,
          )
        : [normalizedSession, ...state.sessions];

      return {
        sessions,
        activeSessionId: state.activeSessionId || normalizedSession.id || null,
      };
    });
  },
  upsertChat: (chat) => {
    set((state) => {
      const chats = state.chats.some((item) => item.id === chat.id)
        ? state.chats.map((item) =>
            item.id === chat.id ? { ...item, ...chat } : item,
          )
        : [chat, ...state.chats];

      return {
        chats: sortChats(chats),
      };
    });
  },
  addMessage: (message) => {
    if (!message?.chatId) return;
    set((state) => {
      const current = state.messagesByChat[message.chatId] || [];
      const existingIndex = current.findIndex(
        (item) =>
          item.id === message.id ||
          (message.externalMessageId &&
            item.externalMessageId === message.externalMessageId),
      );

      if (existingIndex === -1) {
        return {
          messagesByChat: {
            ...state.messagesByChat,
            [message.chatId]: [...current, message],
          },
        };
      }

      const next = [...current];
      next[existingIndex] = { ...next[existingIndex], ...message };
      return {
        messagesByChat: {
          ...state.messagesByChat,
          [message.chatId]: next,
        },
      };
    });
  },
  updateMessageStatus: (payload = {}) => {
    const { messageId, status } = payload;
    if (!messageId || !status) return;

    set((state) => {
      const nextMessagesByChat = Object.fromEntries(
        Object.entries(state.messagesByChat).map(([chatId, messages]) => [
          chatId,
          messages.map((message) =>
            message.id === messageId
              ? {
                  ...message,
                  statuses: [
                    ...(message.statuses || []),
                    { status, createdAt: new Date().toISOString() },
                  ],
                }
              : message,
          ),
        ]),
      );

      return { messagesByChat: nextMessagesByChat };
    });
  },
  updateMessageDelivery: (delivery = {}) => {
    if (!delivery?.messageId) return;

    set((state) => {
      const nextMessagesByChat = Object.fromEntries(
        Object.entries(state.messagesByChat).map(([chatId, messages]) => [
          chatId,
          messages.map((message) =>
            message.id === delivery.messageId
              ? {
                  ...message,
                  outboundDelivery: {
                    ...(message.outboundDelivery || {}),
                    ...delivery,
                  },
                }
              : message,
          ),
        ]),
      );

      return { messagesByChat: nextMessagesByChat };
    });
  },
  updateMessage: (message) => {
    set((state) => ({
      messagesByChat: Object.fromEntries(
        Object.entries(state.messagesByChat).map(([chatId, messages]) => [
          chatId,
          messages.map((item) =>
            item.id === message.id ? { ...item, ...message } : item,
          ),
        ]),
      ),
    }));
  },
  upsertTerminalRecord: (record) => {
    if (!record?.id) return;
    set((state) => ({
      terminalRecordsById: {
        ...state.terminalRecordsById,
        [record.id]: {
          ...(state.terminalRecordsById[record.id] || {}),
          ...record,
        },
      },
    }));
  },
  setTyping: (payload = {}) => {
    const { chatId, isTyping, name, userId } = payload;
    if (!chatId) return;

    set((state) => ({
      typingByChat: {
        ...state.typingByChat,
        [chatId]: { isTyping, name, userId },
      },
    }));
  },
  setSocket: (socket) => set({ socket }),
  setTerminalAutoApproveAll: async (value) => {
    const previous = !!get().terminalAutoApproveAll;
    writeTerminalAutoApprove(value);
    set({ terminalAutoApproveAll: !!value });
    try {
      const token = get().token;
      if (token) {
        await apiFetch("/api/user/settings", {
          method: "POST",
          token,
          body: { autoApproveAllTerminalCommands: !!value },
        });
      }
    } catch (e) {
      writeTerminalAutoApprove(previous);
      set({ terminalAutoApproveAll: previous });
      throw e;
    }
  },
  setDefaultAiProvider: async (providerId) => {
    writeDefaultAiProviderId(providerId);
    set({ defaultAiProviderId: providerId || null });
    try {
      const token = get().token;
      if (token) {
        await apiFetch("/api/user/settings", {
          method: "POST",
          token,
          body: { defaultAiProviderId: providerId || null },
        });
      }
    } catch (e) {
      // ignore
    }
  },
  setDefaultAiModel: async (model) => {
    writeDefaultAiModel(model);
    set({ defaultAiModel: model || null });
    try {
      const token = get().token;
      if (token) {
        await apiFetch("/api/user/settings", {
          method: "POST",
          token,
          body: { defaultAiModel: model || null },
        });
      }
    } catch (e) {
      // ignore
    }
  },
}));
