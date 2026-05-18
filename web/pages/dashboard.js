import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import { AppHead } from "@/components/AppHead";
import { ChatWindow } from "@/components/ChatWindow";
import { ContactList } from "@/components/ContactList";
import { ContactsPanel } from "@/components/ContactsPanel";
import { SettingsModal } from "@/components/SettingsModal";
import { apiFetch } from "@/lib/api";
import { createSocket } from "@/lib/socket";
import { useAppStore } from "@/store/useAppStore";

export default function DashboardPage() {
  const [connectLoading, setConnectLoading] = useState(null);
  const [qrLoading, setQrLoading] = useState(false);
  const router = useRouter();
  const {
    token,
    user,
    hydrateAuth,
    logout,
    setBootstrapData,
    setMessages,
    prependMessages,
    setActiveChat,
    upsertSession,
    upsertChat,
    addMessage,
    updateMessageStatus,
    updateMessageDelivery,
    updateMessage,
    upsertTerminalRecord,
    setSocket,
    socket,
    chats,
    sessions,
    activeChatId,
    activeSessionId,
    setActiveSession,
    messagesByChat,
    messageMetaByChat,
    typingByChat,
  } = useAppStore();

  const [loading, setLoading] = useState(true);
  const [contactsLoading, setContactsLoading] = useState(false);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [syncingWorkspace, setSyncingWorkspace] = useState(false);
  const [error, setError] = useState("");
  const [sessionName, setSessionName] = useState("");
  const [sessionPhone, setSessionPhone] = useState("");
  const [sessionTransport, setSessionTransport] = useState("wwebjs");
  const [metaPhoneNumberId, setMetaPhoneNumberId] = useState("");
  const [metaBusinessAccountId, setMetaBusinessAccountId] = useState("");
  const [metaAccessToken, setMetaAccessToken] = useState("");
  const [metaVerifyToken, setMetaVerifyToken] = useState("");
  const [metaAppSecret, setMetaAppSecret] = useState("");
  const [chatQuery, setChatQuery] = useState("");
  const [contactQuery, setContactQuery] = useState("");
  const [messageQuery, setMessageQuery] = useState("");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [contacts, setContacts] = useState([]);
  const [apiKeys, setApiKeys] = useState([]);
  const [apiKeysLoading, setApiKeysLoading] = useState(false);
  const [apiKeyName, setApiKeyName] = useState("");
  const [apiKeySecret, setApiKeySecret] = useState("");
  const [revokingKeyId, setRevokingKeyId] = useState(null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookEnabled, setWebhookEnabled] = useState(true);
  const [webhookMethod, setWebhookMethod] = useState("POST");
  const [webhookHeaders, setWebhookHeaders] = useState("");
  const [webhookBodyTemplate, setWebhookBodyTemplate] = useState("");
  const [webhookApiKey, setWebhookApiKey] = useState("");
  const [webhookLoading, setWebhookLoading] = useState(false);
  const [startingContactId, setStartingContactId] = useState(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [contactsPanelOpen, setContactsPanelOpen] = useState(false);
  const chatWindowRef = useRef(null);

  const activeChat = useMemo(
    () => chats.find((chat) => chat.id === activeChatId) || null,
    [activeChatId, chats],
  );
  const activeMessages = messagesByChat[activeChatId] || [];
  const activeMeta = messageMetaByChat[activeChatId] || {
    hasMore: false,
    nextBefore: null,
  };
  const activeTyping = typingByChat[activeChatId];
  const readySessions = sessions.filter(
    (session) => session.status === "ready",
  ).length;

  const loadContacts = useCallback(async () => {
    if (!token) {
      return;
    }

    setContactsLoading(true);
    try {
      const data = await apiFetch("/api/contacts", { token });
      setContacts(data.contacts || []);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setContactsLoading(false);
    }
  }, [token]);

  const loadApiKeys = useCallback(async () => {
    if (!token) {
      return;
    }

    setApiKeysLoading(true);
    try {
      const data = await apiFetch("/api/api-keys", { token });
      setApiKeys(data.apiKeys || []);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setApiKeysLoading(false);
    }
  }, [token]);

  const loadWorkspace = useCallback(
    async (showSpinner = false) => {
      if (!token) {
        return;
      }

      if (showSpinner) {
        setLoading(true);
      }

      try {
        const data = await apiFetch("/api/bootstrap", { token });
        setBootstrapData(data);
      } catch (requestError) {
        setError(requestError.message);
        if (requestError.status === 401) {
          logout();
          router.replace("/");
        }
      } finally {
        if (showSpinner) {
          setLoading(false);
        }
      }
    },
    [logout, router, setBootstrapData, token],
  );

  const pollSessionStatus = useCallback(
    async (sessionId) => {
      const deadline = Date.now() + 25000;

      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        if (!token) return null;

        try {
          const data = await apiFetch("/api/sessions", { token });
          const session = data.sessions?.find((item) => item.id === sessionId);
          if (!session) continue;

          upsertSession(session);

          if (
            session.qrCode ||
            session.status === "ready" ||
            session.status === "error" ||
            session.status === "disconnected"
          ) {
            return session;
          }
        } catch (err) {
          // ignore poll errors and retry until timeout
        }
      }

      return null;
    },
    [token, upsertSession],
  );

  useEffect(() => {
    hydrateAuth();
  }, [hydrateAuth]);

  useEffect(() => {
    if (!token) {
      router.replace("/");
      return;
    }

    Promise.all([loadWorkspace(true), loadContacts(), loadApiKeys()]).finally(
      () => {
        setLoading(false);
      },
    );
  }, [loadApiKeys, loadContacts, loadWorkspace, router, token]);

  useEffect(() => {
    if (settingsOpen) {
      // load webhook config when settings open
      (async function load() {
        if (!token) return;
        try {
          const data = await apiFetch("/api/webhook", { token });
          const cfg = data.webhook || {};
          setWebhookUrl(cfg.url || "");
          setWebhookEnabled(cfg.enabled !== false);
          setWebhookMethod(cfg.method || "POST");
          setWebhookHeaders(
            cfg.headers && Object.keys(cfg.headers).length
              ? JSON.stringify(cfg.headers, null, 2)
              : "",
          );
          setWebhookBodyTemplate(cfg.bodyTemplate || "");
          setWebhookApiKey(cfg.apiKey || "");
        } catch (err) {
          // ignore
        }
      })();
    }
  }, [settingsOpen, token]);

  useEffect(() => {
    if (!activeSessionId && sessions[0]?.id) {
      setActiveSession(sessions[0].id);
    }
  }, [activeSessionId, sessions, setActiveSession]);

  useEffect(() => {
    if (!token) {
      return undefined;
    }

    const socketClient = createSocket(token);
    setSocket(socketClient);

    socketClient.on("new_message", (message) => {
      addMessage(message);
    });

    socketClient.on("message_status_update", (payload) => {
      updateMessageStatus(payload);
    });

    socketClient.on("outbound_delivery_update", (payload) => {
      const delivery = payload?.delivery;
      if (delivery?.messageId) {
        updateMessageDelivery(delivery);
      }
      if (delivery?.status === "failed") {
        const target =
          delivery.message?.chat?.contact?.displayName ||
          delivery.message?.chat?.title ||
          delivery.message?.receiver ||
          "message";
        setError(`Delivery failed for ${target}: ${delivery.lastError}`);
      }
    });

    socketClient.on("contact_list_update", (chat) => {
      upsertChat(chat);
      // trigger contacts refresh and show loading badge while fetching
      setContactsLoading(true);
      loadContacts();
    });

    socketClient.on("session_status_update", (session) => {
      upsertSession(session);

      // Only clear connect loading state when it's fully ready, or has an error/disconnected
      if (
        session.status === "ready" ||
        session.status === "error" ||
        session.status === "disconnected"
      ) {
        setConnectLoading(null);
      }

      // Stop QR loading once we have a QR or the session becomes ready/error/disconnected
      if (
        session.qrCode ||
        session.status === "ready" ||
        session.status === "error" ||
        session.status === "disconnected"
      ) {
        setQrLoading(false);
      }

      // If session is connecting, show sync indicator; when ready, refresh workspace
      if (session.status === "connecting") {
        setContactsLoading(true);
      }

      if (session.status === "ready") {
        loadWorkspace();
        loadContacts();
        setContactsLoading(false);
      }
    });

    socketClient.on("workspace_sync_started", (payload) => {
      console.log("[Dashboard] Workspace sync started:", payload);
      setContactsLoading(true);
      setMessagesLoading(true);
      setSyncingWorkspace(true);
    });

    socketClient.on("workspace_synced", (payload) => {
      console.log("[Dashboard] Workspace synced event received:", payload);
      // backend finished workspace sync
      loadWorkspace();
      loadContacts();
      setContactsLoading(false);
      setMessagesLoading(false);
      setSyncingWorkspace(false);

      if (payload.status === "failed") {
        setError(payload.error || "WhatsApp sync failed.");
      }

      // Refresh current chat messages if it's a WhatsApp chat
      const state = useAppStore.getState();
      if (state.activeChatId) {
        apiFetch(`/api/chats/${state.activeChatId}/messages`, { token })
          .then((data) => {
            setMessages(state.activeChatId, data.messages, {
              hasMore: Boolean(data.hasMore),
              nextBefore: data.nextBefore || null,
            });
          })
          .catch(() => {});
      }
    });

    socketClient.on("typing_event", (payload) => {
      // Ignore typing events originating from the current user to avoid echoing
      const state = useAppStore.getState();
      const currentUserId = state.user?.id;
      if (
        payload &&
        payload.userId &&
        currentUserId &&
        payload.userId === currentUserId
      ) {
        return;
      }
      useAppStore.getState().setTyping(payload);
    });

    const refreshTerminalRecord = async (payload) => {
      if (!payload?.id) return;
      const ensureTerminalCardMessage = (record) => {
        const targetChatId = record?.chatId || payload?.chatId || null;
        if (!targetChatId) return;

        const state = useAppStore.getState();
        const existing = (state.messagesByChat[targetChatId] || []).find(
          (message) =>
            message.externalMessageId === `terminal:${record.id}` ||
            message.id === `terminal:${record.id}`,
        );

        if (existing) return;

        const chat = state.chats.find((item) => item.id === targetChatId);
        state.addMessage({
          id: `terminal:${record.id}`,
          chatId: targetChatId,
          sessionId: chat?.sessionId || null,
          mediaFileId: null,
          replyToId: null,
          externalMessageId: `terminal:${record.id}`,
          sender: chat?.contact?.externalId || "openwa:assistant",
          receiver: state.user?.id ? `user:${state.user.id}` : "user",
          body:
            record.status === "pending"
              ? `Terminal command pending approval: ${record.command || "Terminal command"}`
              : `Terminal command finished: ${record.command || "Terminal command"}`,
          type: "text",
          direction: "inbound",
          createdAt: record.requestedAt || new Date().toISOString(),
          updatedAt: record.requestedAt || new Date().toISOString(),
          mediaFile: null,
          replyTo: null,
          statuses: [{ status: "delivered" }],
        });
      };

      try {
        const data = await apiFetch(`/api/terminal/${payload.id}`, { token });
        if (data?.item) {
          upsertTerminalRecord(data.item);
          ensureTerminalCardMessage(data.item);
        }
      } catch (error) {
        if (payload?.id) {
          upsertTerminalRecord(payload);
          ensureTerminalCardMessage(payload);
        }
      }
    };

    socketClient.on("terminal_request", refreshTerminalRecord);
    socketClient.on("terminal_result", refreshTerminalRecord);

    return () => {
      socketClient.off("terminal_request", refreshTerminalRecord);
      socketClient.off("terminal_result", refreshTerminalRecord);
      socketClient.close();
      setSocket(null);
    };
  }, [
    addMessage,
    loadContacts,
    loadWorkspace,
    setSocket,
    token,
    updateMessageDelivery,
    updateMessageStatus,
    upsertTerminalRecord,
    upsertChat,
    upsertSession,
  ]);

  useEffect(() => {
    if (!activeChatId) {
      setMessagesLoading(false);
      return;
    }

    if (messagesByChat[activeChatId]) {
      setMessagesLoading(false);
      return;
    }

    if (!token) {
      return;
    }

    setMessagesLoading(true);
    apiFetch(`/api/chats/${activeChatId}/messages`, { token })
      .then((data) => {
        setMessages(activeChatId, data.messages, {
          hasMore: Boolean(data.hasMore),
          nextBefore: data.nextBefore || null,
        });
      })
      .catch((requestError) => {
        setError(requestError.message);
      })
      .finally(() => {
        setMessagesLoading(false);
      });
  }, [activeChatId, messagesByChat, setMessages, token]);

  const handleCreateSession = async (event) => {
    event.preventDefault();
    setError("");

    try {
      const data = await apiFetch("/api/sessions", {
        method: "POST",
        token,
        body: {
          name: sessionName,
          phoneNumber: sessionPhone,
          transportType: sessionTransport,
          phoneNumberId: metaPhoneNumberId,
          businessAccountId: metaBusinessAccountId,
          accessToken: metaAccessToken,
          verifyToken: metaVerifyToken,
          appSecret: metaAppSecret,
        },
      });

      upsertSession(data.session);
      setActiveSession(data.session.id);
      setSessionName("");
      setSessionPhone("");
      setSessionTransport("wwebjs");
      setMetaPhoneNumberId("");
      setMetaBusinessAccountId("");
      setMetaAccessToken("");
      setMetaVerifyToken("");
      setMetaAppSecret("");
      setSettingsOpen(true);
      await loadWorkspace();
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const handleTogglePin = async (chatId, isPinned) => {
    setError("");
    try {
      if (!token) return;
      await apiFetch(`/api/chats/${chatId}/${isPinned ? "unpin" : "pin"}`, {
        method: "POST",
        token,
      });
      await loadWorkspace();
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const handleDeleteChat = async (chatId) => {
    setError("");
    try {
      if (!token) return;
      const chat = chats.find((c) => c.id === chatId);
      const externalId = chat?.contact?.externalId || null;
      const isAssistant =
        externalId &&
        (externalId === "openwa:assistant" ||
          String(externalId).startsWith("openwa:assistant") ||
          String(externalId).endsWith(":assistant"));

      const endpoint = isAssistant
        ? `/api/assistant/sessions/${chatId}`
        : `/api/chats/${chatId}`;

      await apiFetch(endpoint, { method: "DELETE", token });
      await loadWorkspace(true);
      if (activeChatId === chatId) {
        setActiveChat(null);
      }
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const handleConnectSession = async (sessionId) => {
    setError("");
    setConnectLoading(sessionId);
    setQrLoading(true);
    setActiveSession(sessionId);

    try {
      const data = await apiFetch(`/api/sessions/${sessionId}/connect`, {
        method: "POST",
        token,
      });
      upsertSession(data.session);

      const session = await pollSessionStatus(sessionId);
      if (!session) {
        setQrLoading(false);
      }
    } catch (requestError) {
      setError(requestError.message);
      setConnectLoading(null); // Clear loading state if request failed
      setQrLoading(false);
    }
  };

  const handleClearSession = async (sessionId) => {
    setError("");
    setConnectLoading(sessionId);
    try {
      await apiFetch(`/api/sessions/${sessionId}/disconnect`, {
        method: "POST",
        token,
      });
      await loadWorkspace(true);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setConnectLoading(null);
    }
  };

  const handleDeleteSession = async (sessionId) => {
    setError("");
    setConnectLoading(sessionId);
    try {
      await apiFetch(`/api/sessions/${sessionId}`, {
        method: "DELETE",
        token,
      });
      await loadWorkspace(true);
      if (activeSessionId === sessionId) {
        setActiveSession(null);
      }
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setConnectLoading(null);
    }
  };

  const handleDisconnectSession = async (sessionId) => {
    setError("");
    setConnectLoading(sessionId);
    try {
      const data = await apiFetch(`/api/sessions/${sessionId}/disconnect`, {
        method: "POST",
        token,
      });
      upsertSession(data.session);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setConnectLoading(null);
    }
  };

  const handleCreateApiKey = async (event) => {
    event.preventDefault();
    setError("");
    setApiKeysLoading(true);
    try {
      const result = await apiFetch("/api/api-keys", {
        method: "POST",
        token,
        body: {
          name: apiKeyName,
        },
      });

      setApiKeySecret(result.secret);
      setApiKeyName("");
      setApiKeys((current) => [result.apiKey, ...current]);
      setSettingsOpen(true);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setApiKeysLoading(false);
    }
  };

  const handleSaveWebhook = async () => {
    setWebhookLoading(true);
    setError("");
    try {
      const result = await apiFetch("/api/webhook", {
        method: "POST",
        token,
        body: {
          url: webhookUrl,
          apiKey: webhookApiKey,
          enabled: webhookEnabled,
          method: webhookMethod,
          headers: webhookHeaders,
          bodyTemplate: webhookBodyTemplate,
        },
      });

      setWebhookUrl(result.webhook?.url || "");
      setWebhookEnabled(result.webhook?.enabled !== false);
      setWebhookMethod(result.webhook?.method || "POST");
      setWebhookHeaders(
        result.webhook?.headers && Object.keys(result.webhook.headers).length
          ? JSON.stringify(result.webhook.headers, null, 2)
          : "",
      );
      setWebhookBodyTemplate(result.webhook?.bodyTemplate || "");
      setWebhookApiKey(result.webhook?.apiKey || "");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setWebhookLoading(false);
    }
  };

  const handleDeleteWebhook = async () => {
    setWebhookLoading(true);
    setError("");
    try {
      await apiFetch("/api/webhook", { method: "DELETE", token });
      setWebhookUrl("");
      setWebhookEnabled(true);
      setWebhookMethod("POST");
      setWebhookHeaders("");
      setWebhookBodyTemplate("");
      setWebhookApiKey("");
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setWebhookLoading(false);
    }
  };

  const handleRevokeApiKey = async (apiKeyId) => {
    setError("");
    setRevokingKeyId(apiKeyId);
    try {
      await apiFetch(`/api/api-keys/${apiKeyId}`, {
        method: "DELETE",
        token,
      });

      setApiKeys((current) => current.filter((item) => item.id !== apiKeyId));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setRevokingKeyId(null);
    }
  };

  const handleOpenChat = async (chatId) => {
    setActiveChat(chatId);
    setMessageQuery("");
    socket?.emit("open_chat", { chatId });
  };

  const handleStartChat = async (contactId) => {
    setStartingContactId(contactId);
    setError("");

    try {
      const result = await apiFetch(`/api/contacts/${contactId}/open`, {
        method: "POST",
        token,
      });

      upsertChat(result.chat);
      await handleOpenChat(result.chat.id);
      setContacts((current) =>
        current.map((item) =>
          item.id === contactId
            ? { ...item, hasChat: true, chatId: result.chat.id }
            : item,
        ),
      );
      setContactsPanelOpen(false);
      setTimeout(() => {
        chatWindowRef.current?.focusComposer();
      }, 80);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setStartingContactId(null);
    }
  };

  const handleSendMessage = async ({ body, replyToId }) => {
    if (!socket) {
      throw new Error("Socket connection is not ready yet.");
    }

    const response = await new Promise((resolve, reject) => {
      socket.emit(
        "send_message",
        {
          chatId: activeChatId,
          body,
          type: "text",
          replyToId,
        },
        (response) => {
          if (response?.ok) {
            resolve(response);
            return;
          }

          reject(new Error(response?.error || "Failed to send message."));
        },
      );
    });

    if (response?.chat && response.chat.id) {
      upsertChat(response.chat);
      setActiveChat(response.chat.id);
    }

    return response.message;
  };

  const handleSendMedia = async ({ file, caption }) => {
    if (!socket) {
      throw new Error("Socket connection is not ready yet.");
    }

    const formData = new FormData();
    formData.append("file", file);

    const upload = await apiFetch("/api/media", {
      method: "POST",
      token,
      formData,
    });

    await new Promise((resolve, reject) => {
      socket.emit(
        "send_media",
        {
          chatId: activeChatId,
          mediaFileId: upload.mediaFile.id,
          body: caption,
          type: upload.type,
        },
        (response) => {
          if (response?.ok) {
            resolve(response.message);
            return;
          }

          reject(new Error(response?.error || "Failed to send media."));
        },
      );
    });
  };

  const handleTyping = (isTyping) => {
    socket?.emit("typing", {
      chatId: activeChatId,
      isTyping,
    });
  };

  const handleLoadOlder = async () => {
    if (!activeChatId || !activeMeta.hasMore || !activeMeta.nextBefore) {
      return;
    }

    setLoadingOlder(true);
    try {
      const data = await apiFetch(
        `/api/chats/${activeChatId}/messages?before=${encodeURIComponent(activeMeta.nextBefore)}&take=30`,
        { token },
      );
      prependMessages(activeChatId, data.messages, {
        hasMore: Boolean(data.hasMore),
        nextBefore: data.nextBefore || null,
      });
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setLoadingOlder(false);
    }
  };

  const handleDeleteMessage = async (messageId) => {
    try {
      const result = await apiFetch(`/api/messages/${messageId}`, {
        method: "DELETE",
        token,
      });
      updateMessage(result.message);
      upsertChat(result.chat);
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const handleForwardMessage = async (messageId, targetChatId) => {
    try {
      const result = await apiFetch(`/api/messages/${messageId}/forward`, {
        method: "POST",
        token,
        body: { targetChatId },
      });
      addMessage(result.message);
      upsertChat(result.chat);
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  if (!token) {
    return null;
  }

  return (
    <>
      <AppHead
        title="Dashboard"
        description="Dashboard OpenWA untuk mengelola percakapan, kontak, device, dan session WhatsApp."
      />

      {/* Global small loading badge for slow WA syncs */}
      {syncingWorkspace || contactsLoading || messagesLoading || loading ? (
        <div className="fixed left-4 bottom-4 z-50 flex items-center gap-3 rounded-[24px] bg-brand-600/95 px-4 py-3 text-sm font-semibold text-white shadow-[0_20px_60px_rgba(0,0,0,0.35)] ring-1 ring-brand-200/30">
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-white/15">
            <span className="h-2 w-2 animate-spin rounded-full border-2 border-white border-t-transparent" />
          </span>
          <div className="min-w-[220px] leading-5">
            {syncingWorkspace
              ? "Syncing WhatsApp chats and contacts..."
              : loading
                ? "Refreshing workspace..."
                : contactsLoading
                  ? "Syncing WhatsApp data..."
                  : "Fetching messages..."}
          </div>
        </div>
      ) : null}

      <main className="h-screen overflow-hidden bg-[#161717] text-white">
        <div className="flex h-full w-full overflow-hidden bg-[#161717]">
          <aside className="flex flex-col">
            <button
              className="mx-5 mt-5 mb-2 rounded-lg bg-brand-500 px-4 py-2 text-sm font-semibold text-[#10251a] hover:bg-brand-600 transition"
              onClick={() => loadWorkspace(true)}
              disabled={loading}
              title="Reload conversations"
            >
              {loading ? "Reloading..." : "Reload Conversations"}
            </button>
            <ContactList
              chats={chats}
              activeChatId={activeChatId}
              loading={loading}
              onSelectChat={handleOpenChat}
              currentUser={user}
              query={chatQuery}
              onQueryChange={setChatQuery}
              onTogglePin={handleTogglePin}
              onDeleteChat={handleDeleteChat}
            />
          </aside>

          <section className="flex min-w-0 flex-1 flex-col">
            {error ? (
              <div className="mx-4 mt-4 rounded-2xl border border-red-400/25 bg-red-500/10 px-4 py-3 text-sm text-red-100">
                {error}
              </div>
            ) : null}

            <div className="flex min-h-0 flex-1">
              <ChatWindow
                ref={chatWindowRef}
                chat={activeChat}
                messages={activeMessages}
                chats={chats}
                typingState={activeTyping}
                loading={loading}
                messagesLoading={messagesLoading}
                loadingOlder={loadingOlder}
                hasMoreMessages={activeMeta.hasMore}
                messageQuery={messageQuery}
                onMessageQueryChange={setMessageQuery}
                onLoadOlder={handleLoadOlder}
                onSendMessage={handleSendMessage}
                onSendMedia={handleSendMedia}
                onTyping={handleTyping}
                onDeleteMessage={handleDeleteMessage}
                onForwardMessage={handleForwardMessage}
                onOpenContacts={() => setContactsPanelOpen(true)}
                onOpenCrm={() => router.push("/crm")}
                onOpenSettings={() => setSettingsOpen(true)}
                onLogout={() => {
                  logout();
                  router.replace("/");
                }}
              />

              <ContactsPanel
                contacts={contacts}
                loading={contactsLoading}
                open={contactsPanelOpen}
                query={contactQuery}
                onQueryChange={setContactQuery}
                onStartChat={handleStartChat}
                onClose={() => setContactsPanelOpen(false)}
                startingContactId={startingContactId}
              />
            </div>
          </section>
        </div>
      </main>

      <SettingsModal
        open={settingsOpen}
        sessions={sessions}
        activeSessionId={activeSessionId}
        onClose={() => setSettingsOpen(false)}
        onSelect={setActiveSession}
        onConnect={handleConnectSession}
        onDisconnect={handleDisconnectSession}
        onClearSession={handleClearSession}
        onDeleteSession={handleDeleteSession}
        connectLoading={connectLoading}
        qrLoading={qrLoading}
        syncingWorkspace={syncingWorkspace}
        sessionName={sessionName}
        sessionPhone={sessionPhone}
        sessionTransport={sessionTransport}
        metaPhoneNumberId={metaPhoneNumberId}
        metaBusinessAccountId={metaBusinessAccountId}
        metaAccessToken={metaAccessToken}
        metaVerifyToken={metaVerifyToken}
        metaAppSecret={metaAppSecret}
        onSessionNameChange={setSessionName}
        onSessionPhoneChange={setSessionPhone}
        onSessionTransportChange={setSessionTransport}
        onMetaPhoneNumberIdChange={setMetaPhoneNumberId}
        onMetaBusinessAccountIdChange={setMetaBusinessAccountId}
        onMetaAccessTokenChange={setMetaAccessToken}
        onMetaVerifyTokenChange={setMetaVerifyToken}
        onMetaAppSecretChange={setMetaAppSecret}
        onCreateSession={handleCreateSession}
        apiKeys={apiKeys}
        apiKeysLoading={apiKeysLoading}
        apiKeyName={apiKeyName}
        apiKeySecret={apiKeySecret}
        onApiKeyNameChange={setApiKeyName}
        onCreateApiKey={handleCreateApiKey}
        onRevokeApiKey={handleRevokeApiKey}
        revokingKeyId={revokingKeyId}
        webhookUrl={webhookUrl}
        webhookEnabled={webhookEnabled}
        webhookMethod={webhookMethod}
        webhookHeaders={webhookHeaders}
        webhookBodyTemplate={webhookBodyTemplate}
        webhookApiKey={webhookApiKey}
        onWebhookUrlChange={setWebhookUrl}
        onWebhookEnabledChange={setWebhookEnabled}
        onWebhookMethodChange={setWebhookMethod}
        onWebhookHeadersChange={setWebhookHeaders}
        onWebhookBodyTemplateChange={setWebhookBodyTemplate}
        onWebhookApiKeyChange={setWebhookApiKey}
        onSaveWebhook={handleSaveWebhook}
        onDeleteWebhook={handleDeleteWebhook}
        webhookLoading={webhookLoading}
      />
    </>
  );
}
