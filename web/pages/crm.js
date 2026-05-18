import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/router";
import {
  MdArrowBack,
  MdBolt,
  MdCheckCircle,
  MdDescription,
  MdGroups,
  MdInfo,
  MdRefresh,
  MdSearch,
  MdSend,
  MdSettings,
  MdSmartToy,
  MdUploadFile,
} from "react-icons/md";
import { AppHead } from "@/components/AppHead";
import { BrandLogo } from "@/components/BrandLogo";
import { ChatChannelBadge } from "@/components/ChatChannelBadge";
import { apiFetch } from "@/lib/api";
import { createSocket } from "@/lib/socket";
import { useAppStore } from "@/store/useAppStore";

const automationModes = [
  { value: "inherit", label: "Use default" },
  { value: "off", label: "Off" },
  { value: "draft", label: "Draft only" },
  { value: "auto", label: "Auto send" },
];

const globalModes = automationModes.filter((mode) => mode.value !== "inherit");

const defaultCrmSettings = {
  defaultMode: "draft",
  embeddingProviderId: null,
  embeddingModel: "",
  transcriptionProviderId: null,
  transcriptionModel: "gpt-4o-mini-transcribe",
  similarityThreshold: 0.72,
  maxChunks: 6,
  cooldownSeconds: 180,
  adminPauseSeconds: 1800,
  maxAutoRepliesPerChatPerDay: 20,
  assistantName: "OpenWA CRM Assistant",
  businessName: "",
  persona:
    "Ramah, jelas, profesional, dan membantu. Gunakan Bahasa Indonesia natural.",
  agentInstructions:
    "Tugas utama: pahami kebutuhan customer, jawab ringkas dan membantu, gunakan knowledge base bila tersedia, dan arahkan ke admin bila informasi tidak cukup. Jangan mengarang harga, jadwal, promo, kebijakan, atau janji operasional yang tidak ada di knowledge base.",
  fallbackMessage: "Terima kasih, pesan Anda akan dibantu admin kami.",
  sessionModes: {},
  chatModes: {},
};

function formatTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("id-ID", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function initials(name) {
  return String(name || "?")
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function CrmAvatar({ src, label }) {
  if (src) {
    return (
      <img
        src={src}
        alt={label}
        className="h-12 w-12 shrink-0 rounded-2xl object-cover"
      />
    );
  }

  return (
    <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[#2e2f2f] text-sm font-semibold text-white">
      {initials(label)}
    </div>
  );
}

function previewText(chat) {
  return (
    chat?.lastMessage?.body ||
    chat?.contact?.lastMessagePreview ||
    "No message preview"
  );
}

function modeLabel(value) {
  return automationModes.find((mode) => mode.value === value)?.label || value;
}

function isWhatsappGroupChat(chat) {
  return String(chat?.contact?.externalId || "")
    .toLowerCase()
    .endsWith("@g.us");
}

function resolveChatMode(settings, chat) {
  const chatMode = settings.chatModes?.[chat?.id];
  if (chatMode && chatMode !== "inherit") return chatMode;

  if (isWhatsappGroupChat(chat)) return "off";

  const sessionMode = settings.sessionModes?.[chat?.sessionId];
  if (sessionMode && sessionMode !== "inherit") return sessionMode;

  return settings.defaultMode || "off";
}

function isInbound(message) {
  return message?.direction === "inbound" || message?.direction === "incoming";
}

export default function CrmPage() {
  const router = useRouter();
  const fileInputRef = useRef(null);
  const {
    token,
    hydrateAuth,
    logout,
    setBootstrapData,
    setMessages,
    setActiveChat,
    addMessage,
    upsertChat,
    upsertSession,
    updateMessageStatus,
    updateMessageDelivery,
    setSocket,
    socket,
    chats,
    sessions,
    activeChatId,
    messagesByChat,
  } = useAppStore();

  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState("inbox");
  const [draft, setDraft] = useState("");
  const [draftSources, setDraftSources] = useState([]);
  const [draftBusy, setDraftBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [resumingAutoReply, setResumingAutoReply] = useState(false);
  const [settings, setSettings] = useState(defaultCrmSettings);
  const [knowledgeDocs, setKnowledgeDocs] = useState([]);
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [aiProviders, setAiProviders] = useState([]);
  const [providerModels, setProviderModels] = useState({});
  const [modelsLoadingProviderId, setModelsLoadingProviderId] = useState(null);
  const [reindexingDocId, setReindexingDocId] = useState(null);
  const [knowledgeQuery, setKnowledgeQuery] = useState("");
  const [knowledgeResults, setKnowledgeResults] = useState([]);
  const [knowledgeSearching, setKnowledgeSearching] = useState(false);
  const [knowledgeSearched, setKnowledgeSearched] = useState(false);
  const [knowledgeChatQuestion, setKnowledgeChatQuestion] = useState("");
  const [knowledgeChatAnswer, setKnowledgeChatAnswer] = useState("");
  const [knowledgeChatSources, setKnowledgeChatSources] = useState([]);
  const [knowledgeChatLoading, setKnowledgeChatLoading] = useState(false);
  const [personaInput, setPersonaInput] = useState("");
  const [personaGenerating, setPersonaGenerating] = useState(false);
  const [automationLogs, setAutomationLogs] = useState([]);
  const adoptedDraftLogIdRef = useRef(null);
  const pendingDraftLogRef = useRef(null);

  const activeChat = useMemo(
    () => chats.find((chat) => chat.id === activeChatId) || null,
    [activeChatId, chats],
  );
  const activeMessages = messagesByChat[activeChatId] || [];
  const effectiveMode = resolveChatMode(settings, activeChat);

  const filteredChats = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return chats;
    return chats.filter((chat) => {
      const text = [
        chat.title,
        chat.contact?.displayName,
        chat.contact?.externalId,
        previewText(chat),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return text.includes(needle);
    });
  }, [chats, query]);

  const stats = useMemo(() => {
    const auto = chats.filter(
      (chat) => resolveChatMode(settings, chat) === "auto",
    ).length;
    const draftOnly = chats.filter(
      (chat) => resolveChatMode(settings, chat) === "draft",
    ).length;
    return {
      total: chats.length,
      auto,
      draftOnly,
      handoff: chats.filter((chat) => resolveChatMode(settings, chat) === "off")
        .length,
    };
  }, [chats, settings]);

  const loadWorkspace = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError("");

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
      setLoading(false);
    }
  }, [logout, router, setBootstrapData, token]);

  const loadCrmData = useCallback(async () => {
    if (!token) return;
    setKnowledgeLoading(true);
    try {
      const [settingsData, documentsData] = await Promise.all([
        apiFetch("/api/crm/settings", { token }),
        apiFetch("/api/knowledge/documents", { token }),
      ]);
      setSettings({ ...defaultCrmSettings, ...(settingsData.settings || {}) });
      setKnowledgeDocs(documentsData.documents || []);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setKnowledgeLoading(false);
    }
  }, [token]);

  const loadAiProviders = useCallback(async () => {
    if (!token) return;
    try {
      const data = await apiFetch("/api/ai-providers", { token });
      setAiProviders(data.providers || []);
    } catch (requestError) {
      setError(requestError.message);
    }
  }, [token]);

  const fetchProviderModels = useCallback(
    async (providerId) => {
      if (!token || !providerId) return;
      setModelsLoadingProviderId(providerId);
      try {
        const data = await apiFetch(`/api/ai-providers/${providerId}/models`, {
          token,
        });
        setProviderModels((current) => ({
          ...current,
          [providerId]: data.models || [],
        }));
      } catch (requestError) {
        setError(requestError.message);
      } finally {
        setModelsLoadingProviderId(null);
      }
    },
    [token],
  );

  const loadAutomationLogs = useCallback(
    async (chatId = null) => {
      if (!token) return;
      try {
        const suffix = chatId ? `?chatId=${encodeURIComponent(chatId)}` : "";
        const data = await apiFetch(`/api/crm/logs${suffix}`, { token });
        setAutomationLogs(data.logs || []);
      } catch (requestError) {
        setError(requestError.message);
      }
    },
    [token],
  );

  useEffect(() => {
    hydrateAuth();
  }, [hydrateAuth]);

  useEffect(() => {
    if (!token) {
      router.replace("/");
      return;
    }
    loadWorkspace();
    loadCrmData();
    loadAiProviders();
    loadAutomationLogs();
  }, [loadAiProviders, loadAutomationLogs, loadCrmData, loadWorkspace, router, token]);

  useEffect(() => {
    if (!token || !activeChatId) return;
    loadAutomationLogs(activeChatId);
  }, [activeChatId, loadAutomationLogs, token]);

  useEffect(() => {
    adoptedDraftLogIdRef.current = null;
    setDraft("");
    setDraftSources([]);

    const pendingDraftLog = pendingDraftLogRef.current;
    if (pendingDraftLog?.chatId === activeChatId) {
      pendingDraftLogRef.current = null;
      adoptedDraftLogIdRef.current = pendingDraftLog.id;
      setDraft(String(pendingDraftLog.draft || "").trim());
      setDraftSources(pendingDraftLog.sources || []);
    }
  }, [activeChatId]);

  useEffect(() => {
    if (!activeChatId) return;
    const latestDraftLog = automationLogs.find(
      (log) => log.chatId === activeChatId && log.draft,
    );
    if (!latestDraftLog) return;

    if (draft.trim() && adoptedDraftLogIdRef.current !== latestDraftLog.id) {
      return;
    }

    adoptedDraftLogIdRef.current = latestDraftLog.id;
    setDraft(String(latestDraftLog.draft || "").trim());
    setDraftSources(latestDraftLog.sources || []);
  }, [activeChatId, automationLogs, draft]);

  useEffect(() => {
    if (!token) return undefined;

    const socketClient = createSocket(token);
    setSocket(socketClient);

    socketClient.on("new_message", (message) => {
      addMessage(message);
    });
    socketClient.on("contact_list_update", (chat) => {
      upsertChat(chat);
    });
    socketClient.on("session_status_update", (session) => {
      upsertSession(session);
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
        loadAutomationLogs(delivery.message?.chatId || null);
      }
    });
    socketClient.on("crm_activity_update", (payload) => {
      if (payload?.chatId) {
        loadAutomationLogs(payload.chatId);
      }
    });

    return () => {
      socketClient.close();
      setSocket(null);
    };
  }, [
    addMessage,
    setSocket,
    token,
    loadAutomationLogs,
    updateMessageDelivery,
    updateMessageStatus,
    upsertChat,
    upsertSession,
  ]);

  useEffect(() => {
    if (!activeChatId || !token || messagesByChat[activeChatId]) return;

    setMessagesLoading(true);
    apiFetch(`/api/chats/${activeChatId}/messages`, { token })
      .then((data) => {
        setMessages(activeChatId, data.messages, {
          hasMore: Boolean(data.hasMore),
          nextBefore: data.nextBefore || null,
        });
      })
      .catch((requestError) => setError(requestError.message))
      .finally(() => setMessagesLoading(false));
  }, [activeChatId, messagesByChat, setMessages, token]);

  async function saveCrmSettingsPatch(patch) {
    setError("");
    const previous = settings;
    const optimistic = { ...settings, ...patch };
    if (patch.sessionModes) {
      optimistic.sessionModes = {
        ...settings.sessionModes,
        ...patch.sessionModes,
      };
    }
    if (patch.chatModes) {
      optimistic.chatModes = { ...settings.chatModes, ...patch.chatModes };
    }
    setSettings(optimistic);

    try {
      const data = await apiFetch("/api/crm/settings", {
        method: "POST",
        token,
        body: patch,
      });
      setSettings({ ...defaultCrmSettings, ...(data.settings || {}) });
    } catch (requestError) {
      setSettings(previous);
      setError(requestError.message);
    }
  }

  function updateGlobalMode(value) {
    saveCrmSettingsPatch({ defaultMode: value });
  }

  async function updateSessionMode(sessionId, value) {
    await saveCrmSettingsPatch({ sessionModes: { [sessionId]: value } });
  }

  async function updateChatMode(chatId, value) {
    await saveCrmSettingsPatch({ chatModes: { [chatId]: value } });
  }

  async function resumeActiveChatAutoReply() {
    if (!activeChat || !token) return;
    setResumingAutoReply(true);
    setError("");
    try {
      const data = await apiFetch(
        `/api/crm/chats/${activeChat.id}/resume-auto-reply`,
        {
          method: "POST",
          token,
        },
      );
      setSettings({ ...defaultCrmSettings, ...(data.settings || {}) });
      await loadAutomationLogs(activeChat.id);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setResumingAutoReply(false);
    }
  }

  async function updateNumberSetting(key, value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    await saveCrmSettingsPatch({ [key]: parsed });
  }

  async function handleFilesSelected(event) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;

    setKnowledgeLoading(true);
    setError("");
    try {
      const formData = new FormData();
      for (const file of files) {
        formData.append("files", file);
      }
      const data = await apiFetch("/api/knowledge/documents", {
        method: "POST",
        token,
        formData,
      });
      const uploadedDocuments = data.documents || [];
      const uploadedNames = new Set(
        uploadedDocuments.map((doc) => doc.originalName).filter(Boolean),
      );
      setKnowledgeDocs((current) => [
        ...uploadedDocuments,
        ...current.filter((doc) => !uploadedNames.has(doc.originalName)),
      ]);
    } catch (requestError) {
      setError(requestError.message);
      await loadCrmData();
    } finally {
      setKnowledgeLoading(false);
    }
    event.target.value = "";
  }

  async function removeKnowledgeDoc(id) {
    setError("");
    const previous = knowledgeDocs;
    setKnowledgeDocs((current) => current.filter((doc) => doc.id !== id));
    try {
      await apiFetch(`/api/knowledge/documents/${id}`, {
        method: "DELETE",
        token,
      });
    } catch (requestError) {
      setKnowledgeDocs(previous);
      setError(requestError.message);
    }
  }

  async function reindexKnowledgeDoc(id) {
    setReindexingDocId(id);
    setError("");
    try {
      const data = await apiFetch(`/api/knowledge/documents/${id}/reindex`, {
        method: "POST",
        token,
      });
      setKnowledgeDocs((current) =>
        current.map((doc) => (doc.id === id ? data.document : doc)),
      );
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setReindexingDocId(null);
    }
  }

  async function searchKnowledge(event) {
    event.preventDefault();
    if (!knowledgeQuery.trim()) return;

    setKnowledgeSearching(true);
    setKnowledgeSearched(true);
    setError("");
    try {
      const data = await apiFetch("/api/knowledge/search", {
        method: "POST",
        token,
        body: {
          query: knowledgeQuery,
          limit: settings.maxChunks,
        },
      });
      setKnowledgeResults(data.results || []);
    } catch (requestError) {
      setKnowledgeResults([]);
      setError(requestError.message);
    } finally {
      setKnowledgeSearching(false);
    }
  }

  async function testKnowledgeChat(event) {
    event.preventDefault();
    if (!knowledgeChatQuestion.trim()) return;

    setKnowledgeChatLoading(true);
    setKnowledgeChatAnswer("");
    setKnowledgeChatSources([]);
    setError("");
    try {
      const data = await apiFetch("/api/knowledge/test-chat", {
        method: "POST",
        token,
        body: {
          question: knowledgeChatQuestion,
        },
      });
      setKnowledgeChatAnswer(data.answer || "No answer generated.");
      setKnowledgeChatSources(data.sources || []);
    } catch (requestError) {
      setKnowledgeChatAnswer("");
      setKnowledgeChatSources([]);
      setError(requestError.message);
    } finally {
      setKnowledgeChatLoading(false);
    }
  }

  async function generatePersona() {
    const input = (personaInput || settings.persona || "").trim();
    if (!input) return;

    setPersonaGenerating(true);
    setError("");
    try {
      const data = await apiFetch("/api/crm/persona/generate", {
        method: "POST",
        token,
        body: { input },
      });
      const persona = data.persona || input;
      setSettings((current) => ({ ...current, persona }));
      await saveCrmSettingsPatch({ persona });
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setPersonaGenerating(false);
    }
  }

  async function generateDraft() {
    if (!activeChat) {
      setDraft("Belum ada pesan customer yang bisa dijadikan konteks.");
      return;
    }

    setDraftBusy(true);
    setError("");
    try {
      const result = await apiFetch(`/api/crm/chats/${activeChat.id}/draft`, {
        method: "POST",
        token,
      });
      setDraft(String(result?.draft || settings.fallbackMessage).trim());
      setDraftSources(result?.sources || []);
    } catch (requestError) {
      setDraft(settings.fallbackMessage);
      setDraftSources([]);
      setError(requestError.message);
    } finally {
      setDraftBusy(false);
    }
  }

  async function sendDraftText(text, chatId = activeChatId, { clearComposer = false } = {}) {
    const body = String(text || "").trim();
    if (!socket || !chatId || !body) return;

    setSending(true);
    setError("");
    try {
      await new Promise((resolve, reject) => {
        socket.emit(
          "send_message",
          {
            chatId,
            body,
            type: "text",
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
      if (clearComposer || chatId === activeChatId) {
        setDraft("");
        setDraftSources([]);
        adoptedDraftLogIdRef.current = null;
      }
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSending(false);
    }
  }

  async function sendDraft() {
    await sendDraftText(draft, activeChatId, { clearComposer: true });
  }

  function useAutomationDraft(log) {
    if (!log?.draft) return;
    if (log.chatId && log.chatId !== activeChatId) {
      pendingDraftLogRef.current = log;
      setActiveChat(log.chatId);
      setActiveTab("inbox");
      return;
    }
    adoptedDraftLogIdRef.current = log.id;
    setDraft(String(log.draft || "").trim());
    setDraftSources(log.sources || []);
    setActiveTab("inbox");
  }

  if (!token) return null;

  return (
    <>
      <AppHead
        title="CRM"
        description="CRM dashboard untuk inbox, AI reply, automation, dan knowledge base OpenWA."
      />

      <main className="min-h-screen bg-[#111b21] text-white">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/5 bg-[#161717] px-5 py-4">
          <div className="flex items-center gap-3">
            <BrandLogo variant="square" className="h-10 w-10 rounded-xl" />
            <div>
              <p className="text-xs uppercase tracking-[0.22em] text-white/35">
                OpenWA CRM
              </p>
              <h1 className="text-lg font-semibold text-white">
                AI customer workspace
              </h1>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-2xl bg-white/5 px-4 py-2 text-sm text-white/75 transition hover:bg-white/10"
              onClick={() => router.push("/dashboard")}
            >
              <MdArrowBack />
              Dashboard
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-2xl bg-brand-500 px-4 py-2 text-sm font-semibold text-[#10251a]"
              onClick={loadWorkspace}
              disabled={loading}
            >
              <MdRefresh className={loading ? "animate-spin" : ""} />
              {loading ? "Refreshing" : "Refresh"}
            </button>
          </div>
        </header>

        {error ? (
          <div className="mx-5 mt-4 rounded-2xl border border-red-400/15 bg-red-500/10 px-4 py-3 text-sm text-red-100">
            {error}
          </div>
        ) : null}

        <section className="grid min-h-[calc(100vh-73px)] grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)_360px]">
          <aside className="border-b border-white/5 bg-[#161717] lg:border-b-0 lg:border-r">
            <div className="border-b border-white/5 p-4">
              <div className="grid grid-cols-3 gap-2">
                <div className="rounded-[18px] bg-[#242626] p-3">
                  <p className="text-[11px] text-white/40">Inbox</p>
                  <p className="mt-1 text-xl font-semibold">{stats.total}</p>
                </div>
                <div className="rounded-[18px] bg-[#242626] p-3">
                  <p className="text-[11px] text-white/40">Auto</p>
                  <p className="mt-1 text-xl font-semibold text-brand-200">
                    {stats.auto}
                  </p>
                </div>
                <div className="rounded-[18px] bg-[#242626] p-3">
                  <p className="text-[11px] text-white/40">Draft</p>
                  <p className="mt-1 text-xl font-semibold text-amber-200">
                    {stats.draftOnly}
                  </p>
                </div>
              </div>

              <div className="mt-4 flex items-center gap-2 rounded-2xl bg-[#242626] px-3 py-2">
                <MdSearch className="text-white/35" />
                <input
                  className="min-w-0 flex-1 bg-transparent text-sm text-white outline-none placeholder:text-white/30"
                  placeholder="Search customers"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
            </div>

            <div className="max-h-[55vh] overflow-y-auto px-3 py-3 lg:max-h-[calc(100vh-238px)]">
              <div className="space-y-2">
                {filteredChats.map((chat) => {
                  const selected = chat.id === activeChatId;
                  const mode = resolveChatMode(settings, chat);
                  const title = chat.contact?.displayName || chat.title;
                  return (
                    <button
                      key={chat.id}
                      type="button"
                      className={
                        "flex w-full items-start gap-3 rounded-[16px] px-4 py-3 text-left transition " +
                        (selected
                          ? "bg-[#2e2f2f]"
                          : "bg-transparent hover:bg-white/[0.05]")
                      }
                      onClick={() => setActiveChat(chat.id)}
                    >
                      <CrmAvatar src={chat.contact?.avatarUrl} label={title} />
                      <div className="min-w-0 flex-1">
                        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3">
                          <div className="flex min-w-0 items-center gap-2">
                            <h3 className="min-w-0 truncate font-medium text-white">
                              {title}
                            </h3>
                            <ChatChannelBadge chat={chat} compact />
                          </div>
                          <div className="flex w-[76px] shrink-0 items-center justify-end gap-2">
                            <span className="block min-w-0 truncate text-[11px] text-white/35">
                              {formatTime(
                                chat.contact?.lastMessageAt || chat.updatedAt,
                              )}
                            </span>
                          </div>
                          <p className="mt-1 min-w-0 truncate text-sm text-white/42">
                            {previewText(chat)}
                          </p>
                          <div className="mt-1 flex w-[76px] shrink-0 justify-end">
                            {chat.contact?.unreadCount ? (
                              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-500 px-1.5 text-[11px] font-bold text-[#10251a]">
                                {chat.contact.unreadCount}
                              </span>
                            ) : (
                              <span
                                className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase ${
                                  mode === "auto"
                                    ? "bg-brand-500/15 text-brand-100"
                                    : mode === "draft"
                                      ? "bg-amber-500/15 text-amber-100"
                                      : "bg-white/8 text-white/45"
                                }`}
                              >
                                {mode}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>

              {!filteredChats.length ? (
                <div className="p-6 text-sm leading-6 text-white/45">
                  No CRM conversations found.
                </div>
              ) : null}
            </div>
          </aside>

          <section className="min-w-0 bg-[#0f1418]">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/5 px-5 py-4">
              <div className="min-w-0">
                <p className="text-[11px] uppercase tracking-[0.2em] text-white/35">
                  Conversation
                </p>
                <h2 className="truncate text-base font-semibold text-white">
                  {activeChat
                    ? activeChat.contact?.displayName || activeChat.title
                    : "Select a customer"}
                </h2>
              </div>
              {activeChat ? (
                <div className="flex items-center gap-2">
                  <ChatChannelBadge chat={activeChat} />
                  <div className="flex items-center gap-2 rounded-2xl bg-[#242626] px-3 py-2 text-xs text-white/60">
                    <MdBolt className="text-brand-200" />
                    {modeLabel(effectiveMode)}
                  </div>
                </div>
              ) : null}
            </div>

            <div className="h-[calc(100vh-220px)] overflow-y-auto px-5 py-5 lg:h-[calc(100vh-145px)]">
              {messagesLoading ? (
                <div className="rounded-[22px] bg-white/5 px-4 py-8 text-center text-sm text-white/45">
                  Loading messages...
                </div>
              ) : null}

              {!activeChat ? (
                <div className="flex h-full items-center justify-center">
                  <div className="max-w-sm text-center">
                    <MdGroups className="mx-auto text-5xl text-white/20" />
                    <h3 className="mt-3 text-base font-semibold text-white">
                      Pick a CRM inbox item
                    </h3>
                    <p className="mt-2 text-sm leading-6 text-white/45">
                      Conversation, automation status, and AI reply draft will
                      appear here.
                    </p>
                  </div>
                </div>
              ) : null}

              {activeMessages.map((message) => {
                const inbound = isInbound(message);
                return (
                  <div
                    key={message.id}
                    className={`mb-3 flex ${inbound ? "justify-start" : "justify-end"}`}
                  >
                    <div
                      className={`max-w-[78%] rounded-[20px] px-4 py-3 text-sm leading-6 ${
                        inbound
                          ? "bg-[#242626] text-white/85"
                          : "bg-brand-500 text-[#10251a]"
                      }`}
                    >
                      <p className="whitespace-pre-wrap break-words">
                        {message.body || message.mediaFile?.originalName || ""}
                      </p>
                      <p
                        className={`mt-2 text-[11px] ${
                          inbound ? "text-white/35" : "text-[#10251a]/55"
                        }`}
                      >
                        {formatTime(message.createdAt)}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          <aside className="border-t border-white/5 bg-[#161717] lg:border-l lg:border-t-0">
            <div className="flex border-b border-white/5 px-3 pt-3">
              {[
                ["inbox", "Reply"],
                ["knowledge", "Knowledge"],
                ["automation", "Automation"],
                ["activity", "Activity"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={`rounded-t-2xl px-3 py-2 text-sm ${
                    activeTab === key
                      ? "bg-white/5 text-white"
                      : "text-white/50 hover:text-white/80"
                  }`}
                  onClick={() => setActiveTab(key)}
                >
                  {label}
                </button>
              ))}
            </div>

            {activeTab === "inbox" ? (
              <div className="space-y-4 p-4">
                <div className="rounded-[22px] bg-[#242626] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.2em] text-white/35">
                        Customer
                      </p>
                      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
                        <h3 className="min-w-0 truncate text-sm font-semibold text-white">
                          {activeChat?.contact?.displayName ||
                            activeChat?.title ||
                            "No customer selected"}
                        </h3>
                        {activeChat ? <ChatChannelBadge chat={activeChat} /> : null}
                      </div>
                    </div>
                    <MdInfo className="text-xl text-white/30" />
                  </div>
                  <div className="mt-3 space-y-2 text-xs text-white/45">
                    <p>{activeChat?.contact?.externalId || "No external id"}</p>
                    <p>Updated {formatTime(activeChat?.updatedAt)}</p>
                  </div>
                </div>

                <div className="rounded-[22px] bg-[#242626] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.2em] text-white/35">
                        AI Draft
                      </p>
                      <h3 className="mt-1 text-sm font-semibold text-white">
                        Knowledge-aware reply
                      </h3>
                    </div>
                    <MdSmartToy className="text-xl text-brand-200" />
                  </div>

                  <textarea
                    className="mt-3 min-h-40 w-full rounded-[18px] bg-[#111b21] px-3 py-3 text-sm leading-6 text-white outline-none placeholder:text-white/30"
                    placeholder="Generate or write a reply draft"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                  />

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      className="inline-flex items-center justify-center gap-2 rounded-2xl bg-white/5 px-3 py-2 text-sm font-medium text-white/80 transition hover:bg-white/10"
                      onClick={generateDraft}
                      disabled={!activeChat || draftBusy}
                    >
                      <MdSmartToy />
                      {draftBusy ? "Generating" : "Generate"}
                    </button>
                    <button
                      type="button"
                      className="inline-flex items-center justify-center gap-2 rounded-2xl bg-brand-500 px-3 py-2 text-sm font-semibold text-[#10251a]"
                      onClick={sendDraft}
                      disabled={!activeChat || !draft.trim() || sending}
                    >
                      <MdSend />
                      {sending ? "Sending" : "Send"}
                    </button>
                  </div>

                  {draftSources.length ? (
                    <div className="mt-4 rounded-[18px] bg-[#111b21] p-3">
                      <p className="text-[11px] uppercase tracking-[0.18em] text-white/35">
                        Sources
                      </p>
                      <div className="mt-2 space-y-2">
                        {draftSources.map((source) => (
                          <div key={source.id} className="text-xs leading-5">
                            <p className="font-medium text-white/75">
                              {source.fileName || source.documentTitle}
                            </p>
                            <p className="line-clamp-2 text-white/40">
                              {source.content}
                            </p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {activeTab === "knowledge" ? (
              <div className="space-y-4 p-4">
                <div className="rounded-[22px] bg-[#242626] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.2em] text-white/35">
                        Knowledge Base
                      </p>
                      <h3 className="mt-1 text-sm font-semibold text-white">
                        SQLite local store
                      </h3>
                    </div>
                    <MdDescription className="text-xl text-brand-200" />
                  </div>
                  <p className="mt-2 text-xs leading-5 text-white/45">
                    Files are stored in SQLite-backed knowledge records. Upload
                    multiple files at once; matching filenames automatically
                    replace older knowledge records. TXT, MD, and CSV extract
                    immediately; PDF, DOCX, and XLSX use optional extractor
                    packages when installed.
                  </p>

                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    accept=".txt,.md,.markdown,.pdf,.docx,.xlsx,.csv"
                    onChange={handleFilesSelected}
                  />
                  <button
                    type="button"
                    className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-brand-500 px-4 py-3 text-sm font-semibold text-[#10251a]"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={knowledgeLoading}
                  >
                    <MdUploadFile />
                    {knowledgeLoading
                      ? "Processing files"
                      : "Add knowledge files"}
                  </button>
                </div>

                <form
                  className="rounded-[22px] bg-[#242626] p-4"
                  onSubmit={searchKnowledge}
                >
                  <h3 className="text-sm font-semibold text-white">
                    Test retrieval
                  </h3>
                  <div className="mt-3 flex gap-2">
                    <input
                      className="min-w-0 flex-1 rounded-2xl bg-[#111b21] px-3 py-2 text-sm text-white outline-none placeholder:text-white/30"
                      placeholder="Ask a product or policy question"
                      value={knowledgeQuery}
                      onChange={(event) => setKnowledgeQuery(event.target.value)}
                    />
                    <button
                      type="submit"
                      className="rounded-2xl bg-white/5 px-3 py-2 text-sm font-medium text-white/75"
                      disabled={knowledgeSearching}
                    >
                      {knowledgeSearching ? "Searching" : "Search"}
                    </button>
                  </div>
                  {knowledgeResults.length ? (
                    <div className="mt-3 space-y-2">
                      {knowledgeResults.map((result) => (
                        <div
                          key={result.id}
                          className="rounded-[16px] bg-[#111b21] p-3 text-xs leading-5"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <p className="truncate font-medium text-white/75">
                              {result.fileName || result.documentTitle}
                            </p>
                            <span className="shrink-0 text-white/35">
                              {result.searchMode} {result.score.toFixed(2)}
                            </span>
                          </div>
                          <p className="mt-2 line-clamp-3 text-white/45">
                            {result.content}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {knowledgeSearched &&
                  !knowledgeSearching &&
                  !knowledgeResults.length ? (
                    <div className="mt-3 rounded-[16px] bg-[#111b21] p-3 text-xs leading-5 text-white/45">
                      No matching chunks found. Make sure at least one document
                      is ready, then try a keyword from the document or lower
                      the similarity threshold.
                    </div>
                  ) : null}
                </form>

                <form
                  className="rounded-[22px] bg-[#242626] p-4"
                  onSubmit={testKnowledgeChat}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.2em] text-white/35">
                        AI Test Chat
                      </p>
                      <h3 className="mt-1 text-sm font-semibold text-white">
                        Ask using knowledge base
                      </h3>
                    </div>
                    <MdSmartToy className="text-xl text-brand-200" />
                  </div>

                  <textarea
                    className="mt-3 min-h-24 w-full rounded-2xl bg-[#111b21] px-3 py-2 text-sm leading-6 text-white outline-none placeholder:text-white/30"
                    placeholder="Contoh: Berapa harga paket premium?"
                    value={knowledgeChatQuestion}
                    onChange={(event) =>
                      setKnowledgeChatQuestion(event.target.value)
                    }
                  />
                  <button
                    type="submit"
                    className="mt-3 w-full rounded-2xl bg-brand-500 px-4 py-3 text-sm font-semibold text-[#10251a]"
                    disabled={knowledgeChatLoading}
                  >
                    {knowledgeChatLoading ? "Asking AI..." : "Ask AI"}
                  </button>

                  {knowledgeChatAnswer ? (
                    <div className="mt-4 rounded-[18px] bg-[#111b21] p-3">
                      <p className="text-[11px] uppercase tracking-[0.18em] text-white/35">
                        Answer
                      </p>
                      <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-white/75">
                        {knowledgeChatAnswer}
                      </p>
                    </div>
                  ) : null}

                  {knowledgeChatSources.length ? (
                    <div className="mt-3 space-y-2">
                      {knowledgeChatSources.map((source) => (
                        <div
                          key={source.id}
                          className="rounded-[16px] bg-[#111b21] p-3 text-xs leading-5"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <p className="truncate font-medium text-white/75">
                              {source.fileName || source.documentTitle}
                            </p>
                            <span className="shrink-0 text-white/35">
                              {source.searchMode} {source.score.toFixed(2)}
                            </span>
                          </div>
                          <p className="mt-2 line-clamp-3 text-white/45">
                            {source.content}
                          </p>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </form>

                <div className="space-y-2">
                  {knowledgeDocs.map((doc) => (
                    <div
                      key={doc.id}
                      className="rounded-[18px] bg-[#242626] px-3 py-3"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-white">
                            {doc.originalName || doc.title || doc.fileName}
                          </p>
                          <p className="mt-1 text-xs text-white/40">
                            {Math.ceil((doc.size || 0) / 1024)} KB -{" "}
                            {doc.status}
                            {doc.chunkCount
                              ? ` - ${doc.chunkCount} chunks`
                              : ""}
                          </p>
                          {doc.error ? (
                            <p className="mt-2 text-xs leading-5 text-red-200/80">
                              {doc.error}
                            </p>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          className="rounded-full bg-white/5 px-3 py-1.5 text-xs text-white/60"
                          onClick={() => reindexKnowledgeDoc(doc.id)}
                          disabled={reindexingDocId === doc.id}
                        >
                          {reindexingDocId === doc.id ? "Indexing" : "Reindex"}
                        </button>
                        <button
                          type="button"
                          className="rounded-full bg-white/5 px-3 py-1.5 text-xs text-white/60"
                          onClick={() => removeKnowledgeDoc(doc.id)}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}

                  {!knowledgeDocs.length && !knowledgeLoading ? (
                    <div className="rounded-[18px] bg-[#242626] p-5 text-center text-sm leading-6 text-white/45">
                      No knowledge files queued yet.
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}

            {activeTab === "automation" ? (
              <div className="space-y-4 p-4">
                <div className="rounded-[22px] bg-[#242626] p-4">
                  <div className="flex items-center gap-2">
                    <MdSettings className="text-brand-200" />
                    <h3 className="text-sm font-semibold text-white">
                      Auto-reply settings
                    </h3>
                  </div>

                  <label className="mt-4 block text-xs font-medium text-white/45">
                    Global mode
                  </label>
                  <select
                    className="mt-2 w-full rounded-2xl bg-[#111b21] px-3 py-3 text-sm text-white outline-none"
                    value={settings.defaultMode}
                    onChange={(event) => updateGlobalMode(event.target.value)}
                  >
                    {globalModes.map((mode) => (
                      <option key={mode.value} value={mode.value}>
                        {mode.label}
                      </option>
                    ))}
                  </select>

                  <label className="mt-4 block text-xs font-medium text-white/45">
                    Active chat override
                  </label>
                  <select
                    className="mt-2 w-full rounded-2xl bg-[#111b21] px-3 py-3 text-sm text-white outline-none"
                    value={
                      activeChat
                        ? settings.chatModes?.[activeChat.id] || "inherit"
                        : "inherit"
                    }
                    onChange={(event) =>
                      activeChat && updateChatMode(activeChat.id, event.target.value)
                    }
                    disabled={!activeChat}
                  >
                    {automationModes.map((mode) => (
                      <option key={mode.value} value={mode.value}>
                        {mode.label}
                      </option>
                    ))}
                  </select>

                  <div className="mt-4 rounded-[18px] bg-[#111b21] p-3 text-xs leading-5 text-white/45">
                    Effective mode:{" "}
                    <span className="font-semibold text-white">
                      {modeLabel(effectiveMode)}
                    </span>
                    {isWhatsappGroupChat(activeChat) &&
                    (settings.chatModes?.[activeChat.id] || "inherit") !==
                      "auto" ? (
                      <p className="mt-2 text-amber-100/75">
                        WhatsApp groups are not auto-replied by default. Set this
                        chat override to Auto send to enable replies for this
                        group.
                      </p>
                    ) : null}
                  </div>
                  {activeChat ? (
                    <div className="mt-3 rounded-[18px] bg-brand-500/10 p-3">
                      <p className="text-xs leading-5 text-brand-100/75">
                        Clears the admin pause and sets this chat override to
                        Auto send.
                      </p>
                      <button
                        type="button"
                        className="mt-3 w-full rounded-2xl bg-brand-500 px-4 py-3 text-sm font-semibold text-[#10251a] transition hover:bg-brand-600 disabled:opacity-60"
                        onClick={resumeActiveChatAutoReply}
                        disabled={resumingAutoReply}
                      >
                        {resumingAutoReply
                          ? "Activating auto-reply..."
                          : "Activate auto-reply for this chat"}
                      </button>
                    </div>
                  ) : null}
                </div>

                <div className="rounded-[22px] bg-[#242626] p-4">
                  <h3 className="text-sm font-semibold text-white">
                    Session overrides
                  </h3>
                  <div className="mt-3 space-y-3">
                    {sessions.map((session) => (
                      <div key={session.id}>
                        <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                          <span className="truncate text-white/65">
                            {session.name}
                          </span>
                          <span className="text-white/35">{session.status}</span>
                        </div>
                        <select
                          className="w-full rounded-2xl bg-[#111b21] px-3 py-2 text-sm text-white outline-none"
                          value={settings.sessionModes?.[session.id] || "inherit"}
                          onChange={(event) =>
                            updateSessionMode(session.id, event.target.value)
                          }
                        >
                          {automationModes.map((mode) => (
                            <option key={mode.value} value={mode.value}>
                              {mode.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    ))}
                    {!sessions.length ? (
                      <p className="text-sm text-white/45">
                        No WhatsApp sessions configured.
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="rounded-[22px] bg-[#242626] p-4">
                  <h3 className="text-sm font-semibold text-white">
                    Retrieval tuning
                  </h3>
                  <label className="mt-3 block text-xs text-white/45">
                    Embedding provider
                  </label>
                  <select
                    className="mt-2 w-full rounded-2xl bg-[#111b21] px-3 py-2 text-sm text-white outline-none"
                    value={settings.embeddingProviderId || ""}
                    onChange={(event) =>
                      saveCrmSettingsPatch({
                        embeddingProviderId: event.target.value || null,
                      })
                    }
                  >
                    <option value="">Keyword fallback only</option>
                    {aiProviders.map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.name} ({provider.provider})
                      </option>
                    ))}
                  </select>
                  <label className="mt-3 block text-xs text-white/45">
                    Embedding model
                  </label>
                  <input
                    className="mt-2 w-full rounded-2xl bg-[#111b21] px-3 py-2 text-sm text-white outline-none placeholder:text-white/30"
                    placeholder="text-embedding-3-small or nomic-embed-text"
                    value={settings.embeddingModel || ""}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        embeddingModel: event.target.value,
                      }))
                    }
                    onBlur={(event) =>
                      saveCrmSettingsPatch({
                        embeddingModel: event.target.value,
                      })
                    }
                  />
                  <div className="mt-4 rounded-[18px] bg-[#111b21] p-3">
                    <h4 className="text-xs font-semibold text-white/70">
                      Audio transcription
                    </h4>
                    <label className="mt-3 block text-xs text-white/45">
                      Transcription provider
                    </label>
                    <select
                      className="mt-2 w-full rounded-2xl bg-[#0d171d] px-3 py-2 text-sm text-white outline-none"
                      value={settings.transcriptionProviderId || ""}
                      onChange={(event) => {
                        const providerId = event.target.value || null;
                        saveCrmSettingsPatch({
                          transcriptionProviderId: providerId,
                        });
                        if (providerId && !providerModels[providerId]) {
                          fetchProviderModels(providerId);
                        }
                      }}
                    >
                      <option value="">Use default AI provider</option>
                      {aiProviders.map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.name} ({provider.provider})
                        </option>
                      ))}
                    </select>
                    <div className="mt-3 flex items-center justify-between gap-2">
                      <label className="block text-xs text-white/45">
                        Transcription model
                      </label>
                      {settings.transcriptionProviderId ? (
                        <button
                          type="button"
                          className="rounded-full bg-white/5 px-2 py-1 text-[10px] text-white/55"
                          onClick={() =>
                            fetchProviderModels(settings.transcriptionProviderId)
                          }
                          disabled={
                            modelsLoadingProviderId ===
                            settings.transcriptionProviderId
                          }
                        >
                          {modelsLoadingProviderId ===
                          settings.transcriptionProviderId
                            ? "Loading"
                            : "Fetch models"}
                        </button>
                      ) : null}
                    </div>
                    {settings.transcriptionProviderId &&
                    providerModels[settings.transcriptionProviderId]?.length ? (
                      <select
                        className="mt-2 w-full rounded-2xl bg-[#0d171d] px-3 py-2 text-sm text-white outline-none"
                        value={settings.transcriptionModel || ""}
                        onChange={(event) =>
                          saveCrmSettingsPatch({
                            transcriptionModel: event.target.value,
                          })
                        }
                      >
                        <option value="">gpt-4o-mini-transcribe</option>
                        {providerModels[settings.transcriptionProviderId].map(
                          (model) => (
                            <option key={model.id} value={model.id}>
                              {model.name || model.id}
                            </option>
                          ),
                        )}
                      </select>
                    ) : (
                      <input
                        className="mt-2 w-full rounded-2xl bg-[#0d171d] px-3 py-2 text-sm text-white outline-none placeholder:text-white/30"
                        placeholder="gpt-4o-mini-transcribe"
                        value={settings.transcriptionModel || ""}
                        onChange={(event) =>
                          setSettings((current) => ({
                            ...current,
                            transcriptionModel: event.target.value,
                          }))
                        }
                        onBlur={(event) =>
                          saveCrmSettingsPatch({
                            transcriptionModel: event.target.value,
                          })
                        }
                      />
                    )}
                    <p className="mt-2 text-xs leading-5 text-white/35">
                      Voice notes and audio files are transcribed before CRM
                      auto-reply generates a draft.
                    </p>
                  </div>
                  <label className="mt-3 block text-xs text-white/45">
                    Similarity threshold
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    className="mt-2 w-full rounded-2xl bg-[#111b21] px-3 py-2 text-sm text-white outline-none"
                    value={settings.similarityThreshold}
                    onChange={(event) =>
                      updateNumberSetting(
                        "similarityThreshold",
                        event.target.value,
                      )
                    }
                  />
                  <label className="mt-3 block text-xs text-white/45">
                    Max knowledge chunks
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="12"
                    className="mt-2 w-full rounded-2xl bg-[#111b21] px-3 py-2 text-sm text-white outline-none"
                    value={settings.maxChunks}
                    onChange={(event) =>
                      updateNumberSetting("maxChunks", event.target.value)
                    }
                  />
                  <label className="mt-3 block text-xs text-white/45">
                    Abuse cooldown seconds
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="3600"
                    className="mt-2 w-full rounded-2xl bg-[#111b21] px-3 py-2 text-sm text-white outline-none"
                    value={settings.cooldownSeconds}
                    onChange={(event) =>
                      updateNumberSetting("cooldownSeconds", event.target.value)
                    }
                  />
                  <label className="mt-3 block text-xs text-white/45">
                    Admin reply pause seconds
                  </label>
                  <input
                    type="number"
                    min="0"
                    max="86400"
                    className="mt-2 w-full rounded-2xl bg-[#111b21] px-3 py-2 text-sm text-white outline-none"
                    value={settings.adminPauseSeconds}
                    onChange={(event) =>
                      updateNumberSetting(
                        "adminPauseSeconds",
                        event.target.value,
                      )
                    }
                  />
                  <p className="mt-2 text-xs leading-5 text-white/35">
                    Auto-reply pauses per customer after an admin replies from
                    OpenWA, API, or the paired WhatsApp app.
                  </p>
                  <label className="mt-3 block text-xs text-white/45">
                    Max auto replies per chat per day
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="200"
                    className="mt-2 w-full rounded-2xl bg-[#111b21] px-3 py-2 text-sm text-white outline-none"
                    value={settings.maxAutoRepliesPerChatPerDay}
                    onChange={(event) =>
                      updateNumberSetting(
                        "maxAutoRepliesPerChatPerDay",
                        event.target.value,
                      )
                    }
                  />
                  <label className="mt-3 block text-xs text-white/45">
                    Assistant name
                  </label>
                  <input
                    className="mt-2 w-full rounded-2xl bg-[#111b21] px-3 py-2 text-sm text-white outline-none placeholder:text-white/30"
                    placeholder="OpenWA CRM Assistant"
                    value={settings.assistantName || ""}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        assistantName: event.target.value,
                      }))
                    }
                    onBlur={(event) =>
                      saveCrmSettingsPatch({
                        assistantName: event.target.value,
                      })
                    }
                  />
                  <label className="mt-3 block text-xs text-white/45">
                    Business name
                  </label>
                  <input
                    className="mt-2 w-full rounded-2xl bg-[#111b21] px-3 py-2 text-sm text-white outline-none placeholder:text-white/30"
                    placeholder="Tukang Beberes"
                    value={settings.businessName || ""}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        businessName: event.target.value,
                      }))
                    }
                    onBlur={(event) =>
                      saveCrmSettingsPatch({
                        businessName: event.target.value,
                      })
                    }
                  />
                  <p className="mt-2 text-xs leading-5 text-white/35">
                    Used when customers ask who the bot is on WhatsApp or
                    Telegram CRM chats.
                  </p>
                  <label className="mt-3 block text-xs text-white/45">
                    Persona / brand voice
                  </label>
                  <div className="mt-2 rounded-2xl bg-[#111b21] p-3">
                    <textarea
                      className="min-h-20 w-full rounded-xl bg-[#242626] px-3 py-2 text-sm leading-6 text-white outline-none placeholder:text-white/30"
                      placeholder="Tulis input singkat: brand kamu seperti apa, gaya bahasa, panggilan customer, batasan jawaban..."
                      value={personaInput}
                      onChange={(event) => setPersonaInput(event.target.value)}
                    />
                    <button
                      type="button"
                      className="mt-2 w-full rounded-2xl bg-amber-400 px-4 py-2 text-sm font-semibold text-[#1d1600] shadow-[0_0_18px_rgba(251,191,36,0.28)] transition hover:bg-amber-300 disabled:opacity-60"
                      onClick={generatePersona}
                      disabled={personaGenerating}
                    >
                      {personaGenerating
                        ? "Generating persona..."
                        : "Generate persona from input"}
                    </button>
                  </div>
                  <textarea
                    className="mt-2 min-h-28 w-full rounded-2xl bg-[#111b21] px-3 py-2 text-sm leading-6 text-white outline-none placeholder:text-white/30"
                    placeholder="Contoh: Ramah, cepat, tidak terlalu formal, panggil customer dengan Kak, jangan membuat janji stok/harga jika tidak ada di knowledge."
                    value={settings.persona || ""}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        persona: event.target.value,
                      }))
                    }
                    onBlur={(event) =>
                      saveCrmSettingsPatch({
                        persona: event.target.value,
                      })
                    }
                  />
                  <label className="mt-3 block text-xs text-white/45">
                    Instructions / agent behavior
                  </label>
                  <textarea
                    className="mt-2 min-h-36 w-full rounded-2xl bg-[#111b21] px-3 py-2 text-sm leading-6 text-white outline-none placeholder:text-white/30"
                    placeholder="Contoh: Tanyakan kota/alamat jika customer ingin booking. Jika harga/jadwal tidak ada di knowledge, jangan menebak. Untuk komplain, minta nomor order dan ringkas masalahnya. Untuk pertanyaan di luar layanan, jawab edukatif selama masih terkait kebersihan."
                    value={settings.agentInstructions || ""}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        agentInstructions: event.target.value,
                      }))
                    }
                    onBlur={(event) =>
                      saveCrmSettingsPatch({
                        agentInstructions: event.target.value,
                      })
                    }
                  />
                  <p className="mt-2 text-xs leading-5 text-white/35">
                    Use this for SOP, boundaries, escalation rules, and what the
                    agent should do when the knowledge base is incomplete.
                  </p>
                  <label className="mt-3 block text-xs text-white/45">
                    Fallback message
                  </label>
                  <textarea
                    className="mt-2 min-h-24 w-full rounded-2xl bg-[#111b21] px-3 py-2 text-sm leading-6 text-white outline-none"
                    value={settings.fallbackMessage}
                    onChange={(event) =>
                      setSettings((current) => ({
                        ...current,
                        fallbackMessage: event.target.value,
                      }))
                    }
                    onBlur={(event) =>
                      saveCrmSettingsPatch({
                        fallbackMessage: event.target.value,
                      })
                    }
                  />
                </div>

                <div className="rounded-[22px] bg-brand-500/10 p-4 text-xs leading-5 text-brand-100">
                  <div className="flex items-center gap-2 font-semibold">
                    <MdCheckCircle />
                    Safety guard
                  </div>
                  <p className="mt-2">
                    Auto-reply waits a few seconds after the last customer
                    message, then answers the combined context. Normal follow-up
                    questions are still answered; cooldown only starts when a
                    chat sends too many messages in one minute or reaches the
                    daily limit.
                  </p>
                </div>

                <div className="rounded-[22px] bg-brand-500/10 p-4 text-xs leading-5 text-brand-100">
                  <div className="flex items-center gap-2 font-semibold">
                    <MdCheckCircle />
                    Priority order
                  </div>
                  <p className="mt-2">
                    Chat override wins over session override, then global mode.
                  </p>
                </div>
              </div>
            ) : null}

            {activeTab === "activity" ? (
              <div className="space-y-3 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.2em] text-white/35">
                      Automation Activity
                    </p>
                    <h3 className="mt-1 text-sm font-semibold text-white">
                      {activeChat ? "Current chat log" : "Recent CRM log"}
                    </h3>
                  </div>
                  <div className="flex items-center gap-2">
                    {activeChat ? (
                      <button
                        type="button"
                        className="rounded-full bg-brand-500 px-3 py-1.5 text-xs font-semibold text-[#10251a] transition hover:bg-brand-600 disabled:opacity-60"
                        onClick={resumeActiveChatAutoReply}
                        disabled={resumingAutoReply}
                      >
                        {resumingAutoReply ? "Resuming..." : "Resume auto-reply"}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="rounded-full bg-white/5 px-3 py-1.5 text-xs text-white/70"
                      onClick={() => loadAutomationLogs(activeChat?.id || null)}
                    >
                      Refresh
                    </button>
                  </div>
                </div>

                {automationLogs.map((log) => (
                  <div key={log.id} className="rounded-[18px] bg-[#242626] p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-white">
                          {log.action}
                        </p>
                        <p className="mt-1 text-xs text-white/40">
                          {modeLabel(log.mode)} - {formatTime(log.createdAt)}
                        </p>
                      </div>
                      {log.reason ? (
                        <span className="rounded-full bg-white/5 px-2 py-1 text-[10px] text-white/55">
                          {log.reason}
                        </span>
                      ) : null}
                    </div>
                    {log.draft ? (
                      <>
                        <p className="mt-3 line-clamp-3 text-xs leading-5 text-white/55">
                          {log.draft}
                        </p>
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            className="inline-flex items-center justify-center gap-2 rounded-2xl bg-white/5 px-3 py-2 text-xs font-medium text-white/80 transition hover:bg-white/10"
                            onClick={() => useAutomationDraft(log)}
                          >
                            <MdSmartToy />
                            Use draft
                          </button>
                          <button
                            type="button"
                            className="inline-flex items-center justify-center gap-2 rounded-2xl bg-brand-500 px-3 py-2 text-xs font-semibold text-[#10251a] disabled:opacity-60"
                            onClick={() =>
                              sendDraftText(log.draft, log.chatId || activeChatId)
                            }
                            disabled={sending || !log.chatId}
                          >
                            <MdSend />
                            {sending ? "Sending" : "Send draft"}
                          </button>
                        </div>
                      </>
                    ) : null}
                  </div>
                ))}

                {!automationLogs.length ? (
                  <div className="rounded-[18px] bg-[#242626] p-5 text-center text-sm leading-6 text-white/45">
                    No automation activity yet.
                  </div>
                ) : null}
              </div>
            ) : null}
          </aside>
        </section>
      </main>
    </>
  );
}
