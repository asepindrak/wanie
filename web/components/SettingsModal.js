import { useState, useEffect } from "react";
import { useRouter } from "next/router";
import { BrandLogo } from "@/components/BrandLogo";
import { ToolsEditorModal } from "@/components/ToolsEditorModal";
import TerminalMonitorModal from "@/components/TerminalMonitorModal";
import { apiFetch, getApiBaseUrl } from "@/lib/api";
import { useAppStore } from "@/store/useAppStore";
import { MdFlashOn } from "react-icons/md";

function QrCodeWithCountdown({
  mediaUrl,
  originalName,
  createdAt,
  size = "h-56 w-56",
}) {
  const [timeLeft, setTimeLeft] = useState(120);
  const [isExpired, setIsExpired] = useState(false);

  useEffect(() => {
    const createdTime = new Date(createdAt).getTime();
    const updateCountdown = () => {
      const now = Date.now();
      const diff = Math.floor((now - createdTime) / 1000);
      const remaining = 120 - diff;

      if (remaining <= 0) {
        setTimeLeft(0);
        setIsExpired(true);
      } else {
        setTimeLeft(remaining);
        setIsExpired(false);
      }
    };

    updateCountdown();
    const timer = setInterval(updateCountdown, 1000);
    return () => clearInterval(timer);
  }, [createdAt]);

  if (isExpired) {
    return (
      <div
        className={`flex ${size} flex-col items-center justify-center rounded-2xl bg-[#2e2f2f] p-6 text-center shadow-lg mx-auto`}
      >
        <MdFlashOn className="mb-4 text-3xl text-white/30" />
        <p className="mb-3 text-xs font-medium text-white/50">QR Expired</p>
        <button
          onClick={() => window.location.reload()}
          className="rounded-full bg-brand-500 px-4 py-1.5 text-[11px] font-bold text-[#10251a] shadow-md hover:bg-brand-600 transition"
        >
          Refresh
        </button>
      </div>
    );
  }

  return (
    <div
      className={`relative ${size} overflow-hidden rounded-2xl bg-white p-4 shadow-lg mx-auto`}
    >
      <img
        src={mediaUrl}
        alt={originalName}
        className="h-full w-full object-contain"
      />
      <div className="absolute bottom-2 right-2 flex items-center gap-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-bold text-white backdrop-blur-sm">
        <span className={timeLeft <= 10 ? "text-red-400 animate-pulse" : ""}>
          {timeLeft}s
        </span>
      </div>
    </div>
  );
}

function SessionStatusBadge({ status }) {
  const colors = {
    ready: "bg-brand-500/15 text-brand-100 ring-1 ring-brand-400/20",
    connecting: "bg-amber-500/15 text-amber-100 ring-1 ring-amber-400/20",
    disconnected: "bg-white/8 text-white/60 ring-1 ring-white/10",
    error: "bg-red-500/15 text-red-100 ring-1 ring-red-400/20",
  };

  return (
    <span
      className={`rounded-full px-2.5 py-1 text-[11px] font-medium capitalize tracking-[0.08em] ${colors[status] || colors.disconnected}`}
    >
      {status}
    </span>
  );
}

function initials(label) {
  return String(label || "?")
    .split(" ")
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function SessionAvatar({ label }) {
  return (
    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[#2e2f2f] text-sm font-semibold text-white">
      {initials(label)}
    </div>
  );
}

function formatDateTime(value) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

const webhookReceiverExample = `app.post("/openwa-webhook", express.json(), async (req, res) => {
  const key = req.get("x-openwa-webhook-key");
  if (key !== process.env.OPENWA_WEBHOOK_KEY) {
    return res.status(401).json({ ok: false });
  }

  const { chat, message } = req.body;
  const isTelegram = String(chat.contact?.externalId || "").startsWith("tg:");
  const hasMedia = Boolean(message.mediaFile);

  console.log("Incoming OpenWA message", {
    chatId: chat.id,
    channel: isTelegram ? "telegram" : "whatsapp",
    from: message.sender,
    text: message.body,
    type: message.type,
    media: hasMedia
      ? {
          id: message.mediaFile.id,
          mimeType: message.mediaFile.mimeType,
          originalName: message.mediaFile.originalName,
          size: message.mediaFile.size,
        }
      : null,
  });

  // Reply later with:
  // POST /api/chats/{chat.id}/messages/send
  // { "body": "Reply from external app", "type": "text" }

  res.json({ ok: true });
});`;

const webhookPayloadExample = `{
  "chat": {
    "id": "chat_123",
    "title": "Customer Name",
    "sessionId": "session_123",
    "transportType": "whatsapp",
    "contact": {
      "externalId": "6281234567890@c.us",
      "displayName": "Customer Name"
    },
    "updatedAt": "2026-05-15T08:30:00.000Z"
  },
  "message": {
    "id": "msg_123",
    "chatId": "chat_123",
    "sessionId": "session_123",
    "sender": "6281234567890@c.us",
    "receiver": "6289876543210@c.us",
    "body": "Ini foto area yang mau dibersihkan",
    "type": "image",
    "direction": "inbound",
    "createdAt": "2026-05-15T08:30:00.000Z",
    "mediaFileId": "media_123",
    "mediaFile": {
      "id": "media_123",
      "fileName": "photo.jpg",
      "originalName": "photo.jpg",
      "mimeType": "image/jpeg",
      "size": 248120,
      "relativePath": "media/photo.jpg",
      "createdAt": "2026-05-15T08:30:00.000Z"
    },
    "statuses": []
  }
}`;

export function SettingsModal({
  open,
  sessions,
  activeSessionId,
  onClose,
  onSelect,
  onConnect,
  onDisconnect,
  onClearSession,
  onDeleteSession,
  connectLoading,
  qrLoading,
  syncingWorkspace,
  sessionName,
  sessionPhone,
  onSessionNameChange,
  onSessionPhoneChange,
  onCreateSession,
  apiKeys,
  apiKeysLoading,
  apiKeyName,
  apiKeySecret,
  onApiKeyNameChange,
  onCreateApiKey,
  onRevokeApiKey,
  revokingKeyId,
  webhookUrl,
  webhookApiKey,
  onWebhookUrlChange,
  onWebhookApiKeyChange,
  onSaveWebhook,
  onDeleteWebhook,
  webhookLoading,
}) {
  const [copied, setCopied] = useState(false);
  const [copiedWebhookExample, setCopiedWebhookExample] = useState(null);
  const token = useAppStore((s) => s.token);
  const socket = useAppStore((s) => s.socket);
  const setActiveChat = useAppStore((s) => s.setActiveChat);
  const upsertChat = useAppStore((s) => s.upsertChat);
  const terminalAutoApproveAll = useAppStore((s) => s.terminalAutoApproveAll);
  const setTerminalAutoApproveAll = useAppStore(
    (s) => s.setTerminalAutoApproveAll,
  );
  const defaultAiProviderId = useAppStore((s) => s.defaultAiProviderId);
  const defaultAiModel = useAppStore((s) => s.defaultAiModel);
  const setDefaultAiProvider = useAppStore((s) => s.setDefaultAiProvider);
  const setDefaultAiModel = useAppStore((s) => s.setDefaultAiModel);
  const logout = useAppStore((s) => s.logout);
  const router = useRouter();

  const [providers, setProviders] = useState([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providerName, setProviderName] = useState("");
  const [providerKey, setProviderKey] = useState("");
  const [providerApiKey, setProviderApiKey] = useState("");
  const [providerHost, setProviderHost] = useState("");
  const [providerModel, setProviderModel] = useState("");
  const [providerTemperature, setProviderTemperature] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [addingProvider, setAddingProvider] = useState(false);
  const [modelsMap, setModelsMap] = useState({});
  const [registerAllowed, setRegisterAllowed] = useState(true);
  const [registerLoading, setRegisterLoading] = useState(false);
  const [telegramAdminIds, setTelegramAdminIds] = useState("");
  const [telegramConfigLoading, setTelegramConfigLoading] = useState(false);
  const [telegramConfigSaving, setTelegramConfigSaving] = useState(false);
  const [webhookDeliveries, setWebhookDeliveries] = useState([]);
  const [webhookDeliveriesLoading, setWebhookDeliveriesLoading] =
    useState(false);
  const [retryingWebhookDeliveryId, setRetryingWebhookDeliveryId] =
    useState(null);
  const [testingWebhook, setTestingWebhook] = useState(false);
  const [outboundDeliveries, setOutboundDeliveries] = useState([]);
  const [outboundDeliveriesLoading, setOutboundDeliveriesLoading] =
    useState(false);
  const [retryingOutboundDeliveryId, setRetryingOutboundDeliveryId] =
    useState(null);
  const [cancelingOutboundDeliveryId, setCancelingOutboundDeliveryId] =
    useState(null);
  const [resetPasswordValue, setResetPasswordValue] = useState("");
  const [resetPasswordLoading, setResetPasswordLoading] = useState(false);
  const [resetAllLoading, setResetAllLoading] = useState(false);
  const [modelsLoadingId, setModelsLoadingId] = useState(null);
  const [manualModelByProvider, setManualModelByProvider] = useState({});
  const [providerTempDraftById, setProviderTempDraftById] = useState({});
  const [modelTempDraftByProvider, setModelTempDraftByProvider] = useState({});
  const [savingProviderConfigId, setSavingProviderConfigId] = useState(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [creatingAssistant, setCreatingAssistant] = useState(false);
  const [activeTab, setActiveTab] = useState("devices");

  const activeProvider = providers.find((p) => p.id === defaultAiProviderId);
  const activeModelName =
    defaultAiModel && modelsMap[defaultAiProviderId]
      ? modelsMap[defaultAiProviderId].find((m) => m.id === defaultAiModel)
          ?.name || defaultAiModel
      : defaultAiModel || null;
  const activeSession = sessions.find(
    (session) => session.id === activeSessionId,
  );
  const activeOrigin =
    typeof window !== "undefined"
      ? window.location.origin
      : getApiBaseUrl().replace(/\/+$/, "");
  const gatewayAgentInstruction = `Integrate this application with OpenWA as a messaging gateway.

OpenWA base URL:
${activeOrigin}

Read these docs first:
- ${activeOrigin}/docs/readme#webhooks
- ${activeOrigin}/docs/json

Use X-API-Key for authentication.
Configure an OpenWA webhook so this application receives incoming customer messages.
Verify the x-openwa-webhook-key header on every webhook request.
Store chat.id from the webhook payload.
Reply to the customer with POST ${activeOrigin}/api/chats/{chatId}/messages/send.
For media replies, either pass a public mediaUrl or upload to POST ${activeOrigin}/api/media and then send the returned mediaFileId.
Do not use OpenWA internal CRM automation for this integration; set OpenWA CRM automation to Off.
Treat WhatsApp and non-admin Telegram customer messages the same way: receive them from the webhook and reply through the OpenWA API.`;

  function providerHint(key) {
    if (!key) return "";
    switch (String(key).toLowerCase()) {
      case "openai":
        return "OpenAI: provide an API key (platform.openai.com). Host is optional.";
      case "anthropic":
        return "Anthropic: provide an API key. Default model is typically `claude-2`.";
      case "ollama":
        return "Ollama: provide the local host (e.g. http://localhost:11434) and model name to use.";
      case "openrouter":
        return "OpenRouter: provide host or API key and optionally a default model.";
      default:
        return "Provide connection details (API key, host, default model).";
    }
  }

  function normalizeTemperatureInput(value) {
    if (value === undefined || value === null || value === "") return "";
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return "";
    if (parsed < 0) return "0";
    if (parsed > 2) return "2";
    return String(Math.round(parsed * 10) / 10);
  }

  function normalizeTelegramAdminIdsInput(value) {
    return String(value || "")
      .split(/[,;\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  async function copyWebhookExample(kind, value) {
    await navigator.clipboard.writeText(value);
    setCopiedWebhookExample(kind);
    setTimeout(() => setCopiedWebhookExample(null), 1500);
  }

  async function copyGatewayAgentInstruction() {
    await navigator.clipboard.writeText(gatewayAgentInstruction);
    setCopiedWebhookExample("gateway-agent");
    setTimeout(() => setCopiedWebhookExample(null), 1500);
  }

  async function loadWebhookDeliveries() {
    if (!token) return;
    setWebhookDeliveriesLoading(true);
    try {
      const data = await apiFetch("/api/webhook/deliveries?limit=10", {
        token,
      });
      setWebhookDeliveries(data.deliveries || []);
    } catch (error) {
      setWebhookDeliveries([]);
    } finally {
      setWebhookDeliveriesLoading(false);
    }
  }

  async function retryWebhookDelivery(deliveryId) {
    if (!token || !deliveryId) return;
    setRetryingWebhookDeliveryId(deliveryId);
    try {
      await apiFetch(`/api/webhook/deliveries/${deliveryId}/retry`, {
        method: "POST",
        token,
      });
      await loadWebhookDeliveries();
    } catch (error) {
      alert(error.message || "Failed to retry webhook delivery");
    } finally {
      setRetryingWebhookDeliveryId(null);
    }
  }

  async function testWebhook() {
    if (!token) return;
    setTestingWebhook(true);
    try {
      const result = await apiFetch("/api/webhook/test", {
        method: "POST",
        token,
      });
      await loadWebhookDeliveries();
      if (!result?.ok) {
        alert(result?.error || "Webhook test failed");
      }
    } catch (error) {
      alert(error.message || "Webhook test failed");
    } finally {
      setTestingWebhook(false);
    }
  }

  async function loadOutboundDeliveries() {
    if (!token) return;
    setOutboundDeliveriesLoading(true);
    try {
      const data = await apiFetch("/api/outbound-deliveries?limit=20", {
        token,
      });
      setOutboundDeliveries(data.deliveries || []);
    } catch (error) {
      setOutboundDeliveries([]);
    } finally {
      setOutboundDeliveriesLoading(false);
    }
  }

  async function retryOutboundDelivery(deliveryId) {
    if (!token || !deliveryId) return;
    setRetryingOutboundDeliveryId(deliveryId);
    try {
      await apiFetch(`/api/outbound-deliveries/${deliveryId}/retry`, {
        method: "POST",
        token,
      });
      await loadOutboundDeliveries();
    } catch (error) {
      alert(error.message || "Failed to retry outbound delivery");
    } finally {
      setRetryingOutboundDeliveryId(null);
    }
  }

  async function cancelOutboundDelivery(deliveryId) {
    if (!token || !deliveryId) return;
    setCancelingOutboundDeliveryId(deliveryId);
    try {
      await apiFetch(`/api/outbound-deliveries/${deliveryId}/cancel`, {
        method: "POST",
        token,
      });
      await loadOutboundDeliveries();
    } catch (error) {
      alert(error.message || "Failed to cancel outbound delivery");
    } finally {
      setCancelingOutboundDeliveryId(null);
    }
  }

  useEffect(() => {
    if (!open) return;
    let mounted = true;
    (async () => {
      if (!token) return;
      setProvidersLoading(true);
      try {
        const data = await apiFetch("/api/ai-providers", { token });
        if (!mounted) return;
        setProviders(data.providers || []);
      } catch (e) {
        // ignore
      } finally {
        if (mounted) setProvidersLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [open, token]);

  useEffect(() => {
    if (!open) return;
    let mounted = true;
    (async () => {
      try {
        const data = await apiFetch("/api/auth/config", { token });
        if (!mounted) return;
        setRegisterAllowed(data.allowRegistration !== false);
      } catch (e) {
        if (!mounted) return;
        setRegisterAllowed(true);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [open, token]);

  useEffect(() => {
    if (!open || !token) return;
    let mounted = true;
    (async () => {
      setTelegramConfigLoading(true);
      try {
        const data = await apiFetch("/api/telegram/config", { token });
        if (!mounted) return;
        const ids = data.config?.adminTelegramIds || [];
        setTelegramAdminIds(ids.join("\n"));
      } catch (e) {
        if (!mounted) return;
        setTelegramAdminIds("");
      } finally {
        if (mounted) setTelegramConfigLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [open, token]);

  useEffect(() => {
    if (!open || activeTab !== "webhooks" || !token) return;
    loadWebhookDeliveries();
  }, [open, activeTab, token]);

  useEffect(() => {
    if (!open || activeTab !== "deliveries" || !token) return;
    loadOutboundDeliveries();
  }, [open, activeTab, token]);

  useEffect(() => {
    if (!socket || !open) return undefined;
    const onWebhookDeliveryUpdate = (payload = {}) => {
      const delivery = payload.delivery;
      if (!delivery?.id) return;
      setWebhookDeliveries((current) => {
        const exists = current.some((item) => item.id === delivery.id);
        const next = exists
          ? current.map((item) =>
              item.id === delivery.id ? { ...item, ...delivery } : item,
            )
          : [delivery, ...current];
        return next.slice(0, 10);
      });
    };
    const onOutboundDeliveryUpdate = (payload = {}) => {
      const delivery = payload.delivery;
      if (!delivery?.id) return;
      setOutboundDeliveries((current) => {
        const exists = current.some((item) => item.id === delivery.id);
        const next = exists
          ? current.map((item) =>
              item.id === delivery.id ? { ...item, ...delivery } : item,
            )
          : [delivery, ...current];
        return next.slice(0, 20);
      });
    };

    socket.on("webhook_delivery_update", onWebhookDeliveryUpdate);
    socket.on("outbound_delivery_update", onOutboundDeliveryUpdate);
    return () => {
      socket.off("webhook_delivery_update", onWebhookDeliveryUpdate);
      socket.off("outbound_delivery_update", onOutboundDeliveryUpdate);
    };
  }, [socket, open]);

  const handleSaveTelegramConfig = async (e) => {
    e.preventDefault();
    if (!token) return;

    const adminTelegramIds = normalizeTelegramAdminIdsInput(telegramAdminIds);
    setTelegramConfigSaving(true);
    try {
      const data = await apiFetch("/api/telegram/config", {
        method: "POST",
        token,
        body: { adminTelegramIds },
      });
      setTelegramAdminIds(
        (data.config?.adminTelegramIds || adminTelegramIds).join("\n"),
      );
      alert("Telegram admin IDs saved.");
    } catch (err) {
      alert(err.message || "Failed to save Telegram admin IDs");
    } finally {
      setTelegramConfigSaving(false);
    }
  };

  const handleCreateProvider = async (e) => {
    e.preventDefault();
    if (!token) return;
    setAddingProvider(true);
    try {
      const cfg = {};
      if (providerApiKey && providerApiKey.trim())
        cfg.apiKey = providerApiKey.trim();
      if (providerHost && providerHost.trim()) cfg.host = providerHost.trim();
      if (providerModel && providerModel.trim())
        cfg.model = providerModel.trim();
      if (providerTemperature !== "")
        cfg.temperature = Number(providerTemperature);

      const result = await apiFetch("/api/ai-providers", {
        method: "POST",
        token,
        body: { provider: providerKey, name: providerName, config: cfg },
      });

      setProviders((p) => [result.provider, ...p]);
      setProviderName("");
      setProviderKey("");
      setProviderApiKey("");
      setProviderHost("");
      setProviderModel("");
      setProviderTemperature("");
      setShowApiKey(false);
    } catch (err) {
      alert(err.message || "Failed to create provider");
    } finally {
      setAddingProvider(false);
    }
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();
    if (!token) return;
    if (!resetPasswordValue) {
      alert("New password is required.");
      return;
    }

    setResetPasswordLoading(true);
    try {
      await apiFetch("/api/settings/reset-password", {
        method: "POST",
        token,
        body: {
          password: resetPasswordValue,
        },
      });
      alert("Password reset successfully.");
      setResetPasswordValue("");
    } catch (err) {
      alert(err.message || "Failed to reset password");
    } finally {
      setResetPasswordLoading(false);
    }
  };

  const handleResetAllData = async () => {
    if (!token) return;
    const confirmed = window.prompt(
      "Type YES to confirm resetting all OpenWA data. This action is permanent.",
    );
    if (confirmed !== "YES") return;

    setResetAllLoading(true);
    try {
      await apiFetch("/api/settings/reset-all", {
        method: "POST",
        token,
        body: { confirm: "YES" },
      });
      window.location.reload();
    } catch (err) {
      alert(err.message || "Failed to reset all data");
    } finally {
      setResetAllLoading(false);
    }
  };

  const handleDeleteProvider = async (id) => {
    if (!token) return;
    if (!confirm("Delete this provider?")) return;
    try {
      await apiFetch(`/api/ai-providers/${id}`, { method: "DELETE", token });
      setProviders((p) => p.filter((x) => x.id !== id));
    } catch (err) {
      alert(err.message || "Failed to delete provider");
    }
  };

  const handleFetchModels = async (id) => {
    if (!token) return;
    setModelsLoadingId(id);
    try {
      const data = await apiFetch(`/api/ai-providers/${id}/models`, { token });
      setModelsMap((m) => ({ ...m, [id]: data.models || [] }));
    } catch (err) {
      alert(err.message || "Failed to fetch models");
    } finally {
      setModelsLoadingId(null);
    }
  };

  const handleSaveProviderTemperature = async (provider, valueOverride) => {
    if (!token || !provider?.id) return;
    const hasDraft = Object.prototype.hasOwnProperty.call(
      providerTempDraftById,
      provider.id,
    );
    const draft = normalizeTemperatureInput(
      valueOverride !== undefined
        ? valueOverride
        : hasDraft
          ? providerTempDraftById[provider.id]
          : provider.config?.temperature,
    );
    const nextConfig = {
      ...(provider.config && typeof provider.config === "object"
        ? provider.config
        : {}),
    };

    if (draft === "") delete nextConfig.temperature;
    else nextConfig.temperature = Number(draft);

    setSavingProviderConfigId(provider.id);
    try {
      const data = await apiFetch(`/api/ai-providers/${provider.id}`, {
        method: "PUT",
        token,
        body: { config: nextConfig },
      });
      setProviders((prev) =>
        prev.map((item) => (item.id === provider.id ? data.provider : item)),
      );
      setProviderTempDraftById((prev) => ({ ...prev, [provider.id]: draft }));
    } catch (err) {
      alert(err.message || "Failed to save provider temperature");
    } finally {
      setSavingProviderConfigId(null);
    }
  };

  const handleSaveModelTemperature = async (provider, modelId, valueOverride) => {
    if (!token || !provider?.id || !modelId) return;
    const hasDraft = Object.prototype.hasOwnProperty.call(
      modelTempDraftByProvider,
      provider.id,
    );
    const draft = normalizeTemperatureInput(
      valueOverride !== undefined
        ? valueOverride
        : hasDraft
          ? modelTempDraftByProvider[provider.id]
          : provider.config?.modelTemperatures?.[modelId],
    );
    const nextConfig = {
      ...(provider.config && typeof provider.config === "object"
        ? provider.config
        : {}),
    };
    const modelTemps =
      nextConfig.modelTemperatures &&
      typeof nextConfig.modelTemperatures === "object"
        ? { ...nextConfig.modelTemperatures }
        : {};

    if (draft === "") {
      delete modelTemps[modelId];
    } else {
      modelTemps[modelId] = Number(draft);
    }

    if (Object.keys(modelTemps).length) nextConfig.modelTemperatures = modelTemps;
    else delete nextConfig.modelTemperatures;

    setSavingProviderConfigId(provider.id);
    try {
      const data = await apiFetch(`/api/ai-providers/${provider.id}`, {
        method: "PUT",
        token,
        body: { config: nextConfig },
      });
      setProviders((prev) =>
        prev.map((item) => (item.id === provider.id ? data.provider : item)),
      );
      setModelTempDraftByProvider((prev) => ({
        ...prev,
        [provider.id]: draft,
      }));
    } catch (err) {
      alert(err.message || "Failed to save model temperature");
    } finally {
      setSavingProviderConfigId(null);
    }
  };

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-6 py-8 backdrop-blur-sm">
        <div className="flex h-full max-h-[840px] w-full max-w-[1080px] flex-col overflow-hidden rounded-[32px] bg-[#161717] shadow-[0_40px_120px_rgba(0,0,0,0.5)]">
          <div className="flex items-center justify-between px-6 py-5">
            <div className="flex items-center gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white p-2 shadow-[0_16px_40px_rgba(0,0,0,0.18)]">
                <BrandLogo
                  variant="square"
                  alt="OpenWA"
                  className="h-full w-full rounded-xl"
                />
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-[0.26em] text-white/35">
                  Settings
                </p>
                <h2 className="mt-2 text-xl font-semibold text-white">
                  OpenWA Devices
                </h2>
                <div className="mt-1 text-sm text-white/60">
                  <span className="font-medium text-white/85">AI:</span>{" "}
                  {activeProvider ? (
                    <span>
                      {activeProvider.name} ({activeProvider.provider})
                      {activeModelName ? ` — ${activeModelName}` : ""}
                    </span>
                  ) : (
                    <span>None active</span>
                  )}
                </div>
                {syncingWorkspace ? (
                  <div className="mt-3 rounded-2xl bg-[#22302a] px-4 py-3 text-sm text-emerald-200 ring-1 ring-emerald-400/15">
                    Syncing WhatsApp chats and contacts...
                  </div>
                ) : null}
              </div>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                className="rounded-2xl bg-[#2e2f2f] px-3 py-1 text-sm text-white/70 transition hover:bg-[#3a3b3b] hover:text-white"
                onClick={async () => {
                  if (!token) return;
                  if (!confirm("Start a new Assistant conversation?")) return;
                  setCreatingAssistant(true);
                  try {
                    const data = await apiFetch("/api/assistant/sessions", {
                      method: "POST",
                      token,
                      body: {},
                    });
                    const chat = data.chat;
                    if (chat && chat.id) {
                      upsertChat(chat);
                      setActiveChat(chat.id);
                      onClose();
                    }
                  } catch (err) {
                    alert(err.message || "Failed to create assistant session");
                  } finally {
                    setCreatingAssistant(false);
                  }
                }}
                disabled={creatingAssistant}
              >
                {creatingAssistant ? "Creating..." : "New Assistant"}
              </button>

              <button
                type="button"
                className="rounded-2xl bg-[#2e2f2f] px-3 py-1 text-sm text-white/70 transition hover:bg-[#3a3b3b] hover:text-white"
                onClick={() => setToolsOpen(true)}
              >
                Edit Tools
              </button>

              <button
                type="button"
                className="rounded-2xl bg-[#2e2f2f] px-3 py-1 text-sm text-white/70 transition hover:bg-[#3a3b3b] hover:text-white"
                onClick={() => setTerminalOpen(true)}
              >
                Terminal Monitor
              </button>

              <button
                type="button"
                className="rounded-full bg-[#2e2f2f] px-4 py-2 text-sm text-white/70 transition hover:bg-[#3a3b3b] hover:text-white"
                onClick={onClose}
              >
                Close
              </button>
            </div>
          </div>

          <div className="grid min-h-0 flex-1 gap-0 md:grid-cols-[1.2fr_0.8fr]">
            <div className="min-h-0 px-5 py-5">
              <div className="h-full overflow-y-auto pr-1">
                <div className="space-y-3">
                  {sessions.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      className={`w-full rounded-[18px] px-4 py-4 text-left transition ${
                        session.id === activeSessionId
                          ? "bg-[#2e2f2f]"
                          : "bg-transparent hover:bg-white/[0.04]"
                      }`}
                      onClick={() => onSelect(session.id)}
                    >
                      <div className="flex items-start gap-3">
                        <SessionAvatar label={session.name} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-3">
                            <h3 className="truncate font-medium text-white">
                              {session.name}
                            </h3>
                            <SessionStatusBadge status={session.status} />
                          </div>
                          <p className="mt-1 text-sm text-white/45">
                            {session.phoneNumber ||
                              "Waiting for WhatsApp pairing"}
                          </p>
                          <p className="mt-2 text-xs uppercase tracking-[0.16em] text-white/30">
                            Transport:{" "}
                            {session.transportType === "mock"
                              ? "Mock"
                              : "WhatsApp Web"}
                          </p>
                          <div className="mt-2 grid gap-1 text-xs text-white/35">
                            <p>
                              Health:{" "}
                              {formatDateTime(session.lastHealthCheckAt)}
                            </p>
                            <p>
                              Last seen: {formatDateTime(session.lastSeenAt)}
                            </p>
                            {session.reconnectAttempts ? (
                              <p>
                                Reconnect attempts:{" "}
                                {session.reconnectAttempts}
                              </p>
                            ) : null}
                          </div>
                          {session.lastError ? (
                            <p className="mt-3 rounded-2xl bg-red-500/10 px-3 py-2 text-sm text-red-100">
                              {session.lastError}
                            </p>
                          ) : null}
                        </div>
                      </div>

                      <div className="mt-4 flex gap-2 flex-wrap">
                        <button
                          type="button"
                          className="rounded-2xl bg-brand-500 px-4 py-2 text-sm font-semibold text-[#10251a] disabled:opacity-60"
                          disabled={
                            !!connectLoading && connectLoading === session.id
                          }
                          onClick={(event) => {
                            event.stopPropagation();
                            onConnect(session.id);
                          }}
                        >
                          {connectLoading === session.id
                            ? "Connecting..."
                            : "Connect"}
                        </button>

                        <button
                          type="button"
                          className="rounded-2xl bg-[#2e2f2f] px-4 py-2 text-sm text-white/75 disabled:opacity-60"
                          disabled={
                            !!connectLoading && connectLoading === session.id
                          }
                          onClick={(event) => {
                            event.stopPropagation();
                            onDisconnect(session.id);
                          }}
                        >
                          {connectLoading === session.id
                            ? "Disconnecting..."
                            : "Disconnect"}
                        </button>

                        <button
                          type="button"
                          className="rounded-2xl bg-yellow-700 px-4 py-2 text-sm text-white/90"
                          onClick={(event) => {
                            event.stopPropagation();
                            onClearSession(session.id);
                          }}
                        >
                          Clear Session
                        </button>

                        <button
                          type="button"
                          className="rounded-2xl bg-red-700 px-4 py-2 text-sm text-white/90"
                          onClick={(event) => {
                            event.stopPropagation();
                            onDeleteSession(session.id);
                          }}
                        >
                          Delete Device
                        </button>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="min-h-0 overflow-y-auto px-6 py-5">
              <div className="mb-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  className={`rounded-2xl px-4 py-2 text-sm ${
                    activeTab === "devices"
                      ? "bg-white/5 text-white"
                      : "bg-transparent text-white/60 hover:bg-white/[0.04]"
                  }`}
                  onClick={() => setActiveTab("devices")}
                >
                  Devices
                </button>

                <button
                  type="button"
                  className={`rounded-2xl px-4 py-2 text-sm ${
                    activeTab === "api"
                      ? "bg-white/5 text-white"
                      : "bg-transparent text-white/60 hover:bg-white/[0.04]"
                  }`}
                  onClick={() => setActiveTab("api")}
                >
                  API Access
                </button>

                <button
                  type="button"
                  className={`rounded-2xl px-4 py-2 text-sm ${
                    activeTab === "webhooks"
                      ? "bg-white/5 text-white"
                      : "bg-transparent text-white/60 hover:bg-white/[0.04]"
                  }`}
                  onClick={() => setActiveTab("webhooks")}
                >
                  Webhooks
                </button>

                <button
                  type="button"
                  className={`rounded-2xl px-4 py-2 text-sm ${
                    activeTab === "deliveries"
                      ? "bg-white/5 text-white"
                      : "bg-transparent text-white/60 hover:bg-white/[0.04]"
                  }`}
                  onClick={() => setActiveTab("deliveries")}
                >
                  Deliveries
                </button>

                <button
                  type="button"
                  className={`rounded-2xl px-4 py-2 text-sm ${
                    activeTab === "telegram"
                      ? "bg-white/5 text-white"
                      : "bg-transparent text-white/60 hover:bg-white/[0.04]"
                  }`}
                  onClick={() => setActiveTab("telegram")}
                >
                  Telegram
                </button>

                <button
                  type="button"
                  className={`rounded-2xl px-4 py-2 text-sm ${
                    activeTab === "ai"
                      ? "bg-white/5 text-white"
                      : "bg-transparent text-white/60 hover:bg-white/[0.04]"
                  }`}
                  onClick={() => setActiveTab("ai")}
                >
                  AI Providers
                </button>
                <button
                  type="button"
                  className={`rounded-2xl px-4 py-2 text-sm ${
                    activeTab === "advanced"
                      ? "bg-white/5 text-white"
                      : "bg-transparent text-white/60 hover:bg-white/[0.04]"
                  }`}
                  onClick={() => setActiveTab("advanced")}
                >
                  Advanced
                </button>
              </div>

              {activeTab === "devices" && (
                <>
                  <div className="rounded-[28px] bg-[#161717] p-4">
                    <p className="text-[11px] uppercase tracking-[0.24em] text-white/35">
                      Pairing QR
                    </p>
                    {qrLoading && !activeSession?.qrCode ? (
                      <div className="mt-4 rounded-[24px] bg-[#2e2f2f] px-4 py-16 text-center text-sm leading-6 text-white/40">
                        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-white/10">
                          <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-white" />
                        </div>
                        Waiting for your QR code...
                      </div>
                    ) : activeSession?.qrCode ? (
                      <div className="mt-4">
                        <QrCodeWithCountdown
                          mediaUrl={activeSession.qrCode}
                          originalName="WhatsApp QR"
                          createdAt={
                            activeSession.updatedAt || new Date().toISOString()
                          }
                          size="h-80 w-80"
                        />
                      </div>
                    ) : (
                      <div className="mt-4 rounded-[24px] bg-[#2e2f2f] px-4 py-16 text-center text-sm leading-6 text-white/40">
                        QR code for pairing will appear here when session is
                        connecting.
                      </div>
                    )}
                  </div>

                  <form
                    className="mt-5 space-y-3 rounded-[28px] bg-[#161717] p-4"
                    onSubmit={onCreateSession}
                  >
                    <div>
                      <p className="mb-2 text-[11px] uppercase tracking-[0.24em] text-white/35">
                        Add device
                      </p>
                      <input
                        className="w-full rounded-[22px] bg-[#2e2f2f] px-4 py-3 text-sm text-white outline-none placeholder:text-white/30"
                        placeholder="Session name, e.g. Sales Team"
                        value={sessionName}
                        onChange={(event) =>
                          onSessionNameChange(event.target.value)
                        }
                        required
                      />
                    </div>
                    <input
                      className="w-full rounded-[22px] bg-[#2e2f2f] px-4 py-3 text-sm text-white outline-none placeholder:text-white/30"
                      placeholder="WhatsApp number (optional)"
                      value={sessionPhone}
                      onChange={(event) =>
                        onSessionPhoneChange(event.target.value)
                      }
                    />
                    <button
                      type="submit"
                      className="w-full rounded-2xl bg-brand-500 px-4 py-3 text-sm font-semibold text-[#10251a]"
                    >
                      Add WhatsApp Session
                    </button>
                  </form>
                </>
              )}

              {activeTab === "api" && (
                <div className="rounded-[28px] bg-[#161717] p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.24em] text-white/35">
                        API Access
                      </p>
                      <h3 className="mt-2 text-base font-semibold text-white">
                        Generate API key
                      </h3>
                      <p className="mt-2 text-sm leading-6 text-white/45">
                        Use with external agents via `X-API-Key` header or
                        `Authorization: Bearer &lt;api-key&gt;`.
                      </p>
                      <p className="mt-3 text-sm leading-6 text-white/45">
                        Webhooks: forward incoming messages to your endpoint.
                        See the{" "}
                        <a
                          href="/docs/readme#webhooks"
                          target="_blank"
                          rel="noreferrer"
                          className="ml-1 font-medium text-brand-300 underline"
                        >
                          webhook documentation
                        </a>{" "}
                        for payload details and agent integration.
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 rounded-[22px] bg-[#2e2f2f] p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h4 className="text-sm font-semibold text-white">
                          AI agent gateway prompt
                        </h4>
                        <p className="mt-1 text-xs leading-5 text-white/45">
                          Copy this into an external AI agent so it can connect
                          to OpenWA as a WhatsApp and Telegram gateway.
                        </p>
                      </div>
                      <button
                        type="button"
                        className="rounded-full bg-white/5 px-3 py-1.5 text-xs font-medium text-white/75 transition hover:bg-white/10"
                        onClick={copyGatewayAgentInstruction}
                      >
                        {copiedWebhookExample === "gateway-agent"
                          ? "Copied"
                          : "Copy prompt"}
                      </button>
                    </div>
                    <pre className="mt-3 max-h-56 overflow-auto rounded-[18px] bg-[#0f1010] p-4 text-xs leading-5 text-white/70">
                      <code>{gatewayAgentInstruction}</code>
                    </pre>
                  </div>

                  {apiKeySecret ? (
                    <div className="mt-4 rounded-[22px] bg-[#2e2f2f] p-4">
                      <p className="text-[11px] uppercase tracking-[0.22em] text-brand-200/80">
                        Shown once
                      </p>
                      <p className="mt-2 break-all font-mono text-sm text-white">
                        {apiKeySecret}
                      </p>
                      <button
                        type="button"
                        className="mt-3 rounded-full bg-brand-500 px-4 py-2 text-sm font-semibold text-[#10251a]"
                        onClick={async () => {
                          await navigator.clipboard.writeText(apiKeySecret);
                          setCopied(true);
                          setTimeout(() => setCopied(false), 1500);
                        }}
                      >
                        {copied ? "Copied" : "Copy API key"}
                      </button>
                    </div>
                  ) : null}

                  <form className="mt-4 flex gap-2" onSubmit={onCreateApiKey}>
                    <input
                      className="w-full rounded-[22px] bg-[#2e2f2f] px-4 py-3 text-sm text-white outline-none placeholder:text-white/30"
                      placeholder="Key name, e.g. OpenClaw Agent"
                      value={apiKeyName}
                      onChange={(event) =>
                        onApiKeyNameChange(event.target.value)
                      }
                      required
                    />
                    <button
                      type="submit"
                      className="shrink-0 rounded-[22px] bg-brand-500 px-4 py-3 text-sm font-semibold text-[#10251a]"
                      disabled={apiKeysLoading}
                    >
                      {apiKeysLoading ? "Generating..." : "Generate"}
                    </button>
                  </form>

                  <div className="mt-4 max-h-[260px] space-y-3 overflow-y-auto pr-1">
                    {apiKeysLoading ? (
                      <div className="rounded-[22px] bg-[#2e2f2f] px-4 py-6 text-sm text-white/45">
                        Loading API keys...
                      </div>
                    ) : null}

                    {!apiKeysLoading && !apiKeys.length ? (
                      <div className="rounded-[22px] bg-[#2e2f2f] px-4 py-6 text-sm leading-6 text-white/45">
                        No API keys yet. Create one for OpenAPI client, AI
                        agents, or external integrations.
                      </div>
                    ) : null}

                    {apiKeys.map((apiKey) => (
                      <div
                        key={apiKey.id}
                        className="rounded-[22px] bg-[#2e2f2f] px-4 py-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h4 className="truncate text-sm font-semibold text-white">
                              {apiKey.name}
                            </h4>
                            <p className="mt-1 font-mono text-xs text-white/55">
                              {apiKey.maskedKey}
                            </p>
                          </div>
                          <button
                            type="button"
                            className="rounded-full bg-white/5 px-3 py-1.5 text-xs font-medium text-red-200 transition hover:bg-red-500/15"
                            onClick={() => onRevokeApiKey(apiKey.id)}
                            disabled={
                              apiKeysLoading || revokingKeyId === apiKey.id
                            }
                          >
                            {revokingKeyId === apiKey.id
                              ? "Revoking..."
                              : "Revoke"}
                          </button>
                        </div>
                        <div className="mt-3 grid gap-2 text-xs text-white/40">
                          <p>Created: {formatDateTime(apiKey.createdAt)}</p>
                          <p>Last used: {formatDateTime(apiKey.lastUsedAt)}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeTab === "webhooks" && (
                <div className="rounded-[28px] bg-[#161717] p-4">
                  <p className="text-[11px] uppercase tracking-[0.24em] text-white/35">
                    Webhooks
                  </p>
                  <h3 className="mt-2 text-base font-semibold text-white">
                    Incoming message webhook
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-white/45">
                    Forward incoming messages to this endpoint. The runtime will
                    POST a JSON payload and include header{" "}
                    <span className="font-mono">x-openwa-webhook-key</span> with
                    the value you provide.
                  </p>

                  <div className="mt-4 rounded-[22px] bg-[#2e2f2f] p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h4 className="text-sm font-semibold text-white">
                          AI agent gateway prompt
                        </h4>
                        <p className="mt-1 text-xs leading-5 text-white/45">
                          Paste this into the external app agent that will
                          receive webhooks and send replies through OpenWA.
                        </p>
                      </div>
                      <button
                        type="button"
                        className="rounded-full bg-white/5 px-3 py-1.5 text-xs font-medium text-white/75 transition hover:bg-white/10"
                        onClick={copyGatewayAgentInstruction}
                      >
                        {copiedWebhookExample === "gateway-agent"
                          ? "Copied"
                          : "Copy prompt"}
                      </button>
                    </div>
                    <pre className="mt-3 max-h-56 overflow-auto rounded-[18px] bg-[#0f1010] p-4 text-xs leading-5 text-white/70">
                      <code>{gatewayAgentInstruction}</code>
                    </pre>
                  </div>

                  <form
                    className="mt-4 space-y-3"
                    onSubmit={(e) => {
                      e.preventDefault();
                      onSaveWebhook();
                    }}
                  >
                    <input
                      className="w-full rounded-[22px] bg-[#2e2f2f] px-4 py-3 text-sm text-white outline-none placeholder:text-white/30"
                      placeholder="https://example.com/openwa-webhook"
                      value={webhookUrl || ""}
                      onChange={(e) => onWebhookUrlChange(e.target.value)}
                    />
                    <input
                      className="w-full rounded-[22px] bg-[#2e2f2f] px-4 py-3 text-sm text-white outline-none placeholder:text-white/30"
                      placeholder="Optional webhook API key (sent as x-openwa-webhook-key)"
                      value={webhookApiKey || ""}
                      onChange={(e) => onWebhookApiKeyChange(e.target.value)}
                    />
                    <div className="flex gap-2">
                      <button
                        type="submit"
                        className="rounded-2xl bg-brand-500 px-4 py-3 text-sm font-semibold text-[#10251a]"
                        disabled={webhookLoading}
                      >
                        {webhookLoading ? "Saving..." : "Save webhook"}
                      </button>
                      <button
                        type="button"
                        className="rounded-2xl bg-white/5 px-4 py-3 text-sm font-medium text-white/75 transition hover:bg-white/10"
                        onClick={testWebhook}
                        disabled={webhookLoading || testingWebhook}
                      >
                        {testingWebhook ? "Testing..." : "Test webhook"}
                      </button>
                      <button
                        type="button"
                        className="rounded-2xl bg-red-700 px-4 py-3 text-sm text-white/90"
                        onClick={() => onDeleteWebhook()}
                        disabled={webhookLoading}
                      >
                        {webhookLoading ? "Removing..." : "Remove webhook"}
                      </button>
                    </div>
                  </form>

                  <div className="mt-5 grid gap-3">
                    <div>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="text-sm font-semibold text-white">
                          Example receiver
                        </h4>
                        <button
                          type="button"
                          className="rounded-full bg-white/5 px-3 py-1.5 text-xs font-medium text-white/75 transition hover:bg-white/10"
                          onClick={() =>
                            copyWebhookExample(
                              "receiver",
                              webhookReceiverExample,
                            )
                          }
                        >
                          {copiedWebhookExample === "receiver"
                            ? "Copied"
                            : "Copy receiver"}
                        </button>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-white/45">
                        Set your webhook URL to this route, then use the same
                        API key value as{" "}
                        <span className="font-mono">
                          OPENWA_WEBHOOK_KEY
                        </span>
                        .
                      </p>
                      <pre className="mt-3 max-h-72 overflow-auto rounded-[18px] bg-[#0f1010] p-4 text-xs leading-5 text-white/70">
                        <code>{webhookReceiverExample}</code>
                      </pre>
                    </div>

                    <div>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="text-sm font-semibold text-white">
                          Example payload
                        </h4>
                        <button
                          type="button"
                          className="rounded-full bg-white/5 px-3 py-1.5 text-xs font-medium text-white/75 transition hover:bg-white/10"
                          onClick={() =>
                            copyWebhookExample("payload", webhookPayloadExample)
                          }
                        >
                          {copiedWebhookExample === "payload"
                            ? "Copied"
                            : "Copy payload"}
                        </button>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-white/45">
                        OpenWA sends text and supported media messages as JSON
                        with header{" "}
                        <span className="font-mono">
                          x-openwa-webhook-key
                        </span>
                        . Media messages include{" "}
                        <span className="font-mono">message.mediaFile</span>.
                      </p>
                      <pre className="mt-3 max-h-72 overflow-auto rounded-[18px] bg-[#0f1010] p-4 text-xs leading-5 text-white/70">
                        <code>{webhookPayloadExample}</code>
                      </pre>
                    </div>

                    <div>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <h4 className="text-sm font-semibold text-white">
                          Delivery logs
                        </h4>
                        <button
                          type="button"
                          className="rounded-full bg-white/5 px-3 py-1.5 text-xs font-medium text-white/75 transition hover:bg-white/10"
                          onClick={loadWebhookDeliveries}
                          disabled={webhookDeliveriesLoading}
                        >
                          {webhookDeliveriesLoading ? "Loading" : "Refresh"}
                        </button>
                      </div>
                      <p className="mt-1 text-xs leading-5 text-white/45">
                        Recent webhook attempts are stored per user. Failed
                        deliveries can be retried from here.
                      </p>

                      <div className="mt-3 space-y-2">
                        {webhookDeliveries.map((delivery) => (
                          <div
                            key={delivery.id}
                            className="rounded-[18px] bg-[#2e2f2f] p-3"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="min-w-0">
                                <p className="truncate text-xs font-semibold text-white">
                                  {delivery.status} - {delivery.attempts}/
                                  {delivery.maxAttempts || 3} attempts
                                </p>
                                <p className="mt-1 truncate text-[11px] text-white/40">
                                  {delivery.messageId || delivery.chatId}
                                </p>
                              </div>
                              {delivery.status === "failed" ? (
                                <button
                                  type="button"
                                  className="rounded-full bg-brand-500 px-3 py-1.5 text-xs font-semibold text-[#10251a]"
                                  onClick={() =>
                                    retryWebhookDelivery(delivery.id)
                                  }
                                  disabled={
                                    retryingWebhookDeliveryId === delivery.id
                                  }
                                >
                                  {retryingWebhookDeliveryId === delivery.id
                                    ? "Retrying"
                                    : "Retry"}
                                </button>
                              ) : null}
                            </div>
                            {delivery.error ? (
                              <p className="mt-2 text-[11px] leading-5 text-red-200/80">
                                {delivery.error}
                              </p>
                            ) : null}
                          </div>
                        ))}

                        {!webhookDeliveries.length &&
                        !webhookDeliveriesLoading ? (
                          <div className="rounded-[18px] bg-[#2e2f2f] p-4 text-xs text-white/45">
                            No webhook delivery attempts yet.
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {activeTab === "deliveries" && (
                <div className="rounded-[28px] bg-[#161717] p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.24em] text-white/35">
                        Outbound Delivery
                      </p>
                      <h3 className="mt-2 text-base font-semibold text-white">
                        WhatsApp and Telegram send queue
                      </h3>
                      <p className="mt-2 text-sm leading-6 text-white/45">
                        Messages sent from the dashboard, API, CRM auto-reply,
                        and assistant integrations are retried automatically.
                        Failed jobs stop after the retry limit and can be
                        retried manually here.
                      </p>
                    </div>
                    <button
                      type="button"
                      className="rounded-full bg-white/5 px-3 py-1.5 text-xs font-medium text-white/75 transition hover:bg-white/10"
                      onClick={loadOutboundDeliveries}
                      disabled={outboundDeliveriesLoading}
                    >
                      {outboundDeliveriesLoading ? "Loading" : "Refresh"}
                    </button>
                  </div>

                  <div className="mt-4 space-y-2">
                    {outboundDeliveries.map((delivery) => {
                      const title =
                        delivery.message?.chat?.contact?.displayName ||
                        delivery.message?.chat?.title ||
                        delivery.message?.receiver ||
                        delivery.messageId;
                      const preview =
                        delivery.message?.body ||
                        delivery.message?.type ||
                        "Outbound message";
                      return (
                        <div
                          key={delivery.id}
                          className="rounded-[18px] bg-[#2e2f2f] p-3"
                        >
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <span
                                  className={`rounded-full px-2.5 py-1 text-[11px] font-semibold capitalize ${
                                    delivery.status === "delivered"
                                      ? "bg-brand-500/15 text-brand-100"
                                      : delivery.status === "failed"
                                        ? "bg-red-500/15 text-red-100"
                                        : delivery.status === "canceled"
                                          ? "bg-white/10 text-white/55"
                                        : "bg-amber-500/15 text-amber-100"
                                  }`}
                                >
                                  {delivery.status}
                                </span>
                                <span className="text-[11px] text-white/40">
                                  {delivery.transport} - {delivery.attempts}/
                                  {delivery.maxAttempts} attempts
                                </span>
                              </div>
                              <p className="mt-2 truncate text-sm font-semibold text-white">
                                {title}
                              </p>
                              <p className="mt-1 line-clamp-2 text-xs leading-5 text-white/45">
                                {preview}
                              </p>
                              <p className="mt-1 text-[11px] text-white/30">
                                Updated: {formatDateTime(delivery.updatedAt)}
                              </p>
                            </div>

                            <div className="flex shrink-0 flex-wrap items-center gap-2">
                              {["queued", "sending"].includes(
                                delivery.status,
                              ) ? (
                                <button
                                  type="button"
                                  className="rounded-full bg-white/5 px-3 py-1.5 text-xs font-medium text-white/75 transition hover:bg-white/10"
                                  onClick={() =>
                                    cancelOutboundDelivery(delivery.id)
                                  }
                                  disabled={
                                    cancelingOutboundDeliveryId === delivery.id
                                  }
                                >
                                  {cancelingOutboundDeliveryId === delivery.id
                                    ? "Canceling"
                                    : "Cancel"}
                                </button>
                              ) : null}

                              {delivery.status === "failed" ||
                              delivery.status === "canceled" ? (
                                <button
                                  type="button"
                                  className="rounded-full bg-brand-500 px-3 py-1.5 text-xs font-semibold text-[#10251a]"
                                  onClick={() =>
                                    retryOutboundDelivery(delivery.id)
                                  }
                                  disabled={
                                    retryingOutboundDeliveryId === delivery.id
                                  }
                                >
                                  {retryingOutboundDeliveryId === delivery.id
                                    ? "Retrying"
                                    : "Retry"}
                                </button>
                              ) : null}
                            </div>
                          </div>
                          {delivery.lastError ? (
                            <p className="mt-2 text-[11px] leading-5 text-red-200/80">
                              {delivery.lastError}
                            </p>
                          ) : null}
                        </div>
                      );
                    })}

                    {!outboundDeliveries.length && !outboundDeliveriesLoading ? (
                      <div className="rounded-[18px] bg-[#2e2f2f] p-4 text-xs text-white/45">
                        No outbound delivery jobs yet.
                      </div>
                    ) : null}
                  </div>
                </div>
              )}

              {activeTab === "telegram" && (
                <div className="rounded-[28px] bg-[#161717] p-4">
                  <p className="text-[11px] uppercase tracking-[0.24em] text-white/35">
                    Telegram Bot
                  </p>
                  <h3 className="mt-2 text-base font-semibold text-white">
                    Admin allowlist
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-white/45">
                    Telegram chat IDs in this list can use the bot as the
                    OpenWA assistant admin. Other Telegram users follow CRM mode;
                    when CRM is off their messages are saved to the dashboard
                    without assistant tool access.
                  </p>

                  <form
                    className="mt-4 space-y-3"
                    onSubmit={handleSaveTelegramConfig}
                  >
                    <textarea
                      className="min-h-40 w-full resize-y rounded-[22px] bg-[#2e2f2f] px-4 py-3 font-mono text-sm text-white outline-none placeholder:text-white/30"
                      placeholder={"123456789\n987654321"}
                      value={telegramAdminIds}
                      onChange={(e) => setTelegramAdminIds(e.target.value)}
                      disabled={telegramConfigLoading}
                    />
                    <div className="flex flex-wrap items-center gap-3">
                      <button
                        type="submit"
                        className="rounded-2xl bg-brand-500 px-4 py-3 text-sm font-semibold text-[#10251a]"
                        disabled={telegramConfigLoading || telegramConfigSaving}
                      >
                        {telegramConfigSaving
                          ? "Saving..."
                          : telegramConfigLoading
                            ? "Loading..."
                            : "Save Telegram admins"}
                      </button>
                      <p className="text-xs leading-5 text-white/40">
                        Use one ID per line, or separate IDs with comma, space,
                        or semicolon.
                      </p>
                    </div>
                  </form>
                </div>
              )}

              {activeTab === "ai" && (
                <div className="rounded-[28px] bg-[#161717] p-4">
                  <p className="text-[11px] uppercase tracking-[0.24em] text-white/35">
                    AI Providers
                  </p>
                  <h3 className="mt-2 text-base font-semibold text-white">
                    Manage LLM providers
                  </h3>
                  <div className="mt-2">
                    <button
                      type="button"
                      className="rounded-2xl bg-white/5 px-3 py-2 text-sm font-medium text-white/80"
                      onClick={() => setToolsOpen(true)}
                    >
                      Edit Assistant Tools
                    </button>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-white/45">
                    Add provider configs for OpenAI, Anthropic, Ollama,
                    OpenRouter, then fetch available models.
                  </p>

                  <form
                    className="mt-4 space-y-3"
                    onSubmit={handleCreateProvider}
                  >
                    <div className="grid grid-cols-3 gap-2">
                      <input
                        className="col-span-2 w-full rounded-[22px] bg-[#2e2f2f] px-4 py-3 text-sm text-white outline-none placeholder:text-white/30"
                        placeholder="Provider name (e.g. My OpenAI)"
                        autoComplete="off"
                        value={providerName}
                        onChange={(e) => setProviderName(e.target.value)}
                        required
                      />
                      <select
                        className="w-full rounded-[22px] bg-[#2e2f2f] px-4 py-3 text-sm text-white outline-none"
                        value={providerKey}
                        onChange={(e) => setProviderKey(e.target.value)}
                        required
                      >
                        <option value="">Select provider</option>
                        <option value="openai">OpenAI</option>
                        <option value="anthropic">Anthropic</option>
                        <option value="ollama">Ollama</option>
                        <option value="openrouter">OpenRouter</option>
                      </select>
                    </div>

                    <div className="grid gap-2">
                      <div className="flex gap-2">
                        <input
                          className="flex-1 w-full rounded-[22px] bg-[#2e2f2f] px-4 py-3 text-sm text-white outline-none placeholder:text-white/30"
                          placeholder="API key (sensitive, optional)"
                          value={providerApiKey}
                          autoComplete="off"
                          onChange={(e) => setProviderApiKey(e.target.value)}
                          type={showApiKey ? "text" : "password"}
                        />
                        <button
                          type="button"
                          className="rounded-[22px] bg-white/5 px-4 py-3 text-sm text-white/70"
                          onClick={() => setShowApiKey((s) => !s)}
                        >
                          {showApiKey ? "Hide" : "Show"}
                        </button>
                      </div>

                      <input
                        className="w-full rounded-[22px] bg-[#2e2f2f] px-4 py-3 text-sm text-white outline-none placeholder:text-white/30"
                        placeholder="Host (e.g. http://localhost:11434)"
                        value={providerHost}
                        onChange={(e) => setProviderHost(e.target.value)}
                      />
                      <input
                        className="w-full rounded-[22px] bg-[#2e2f2f] px-4 py-3 text-sm text-white outline-none placeholder:text-white/30"
                        placeholder="Default model (optional)"
                        value={providerModel}
                        onChange={(e) => setProviderModel(e.target.value)}
                      />
                      <div className="rounded-[16px] bg-[#232424] px-4 py-3">
                        <div className="mb-2 flex items-center justify-between">
                          <p className="text-xs text-white/70">
                            Provider temperature
                          </p>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-white/60">
                              {providerTemperature === ""
                                ? "Auto"
                                : providerTemperature}
                            </span>
                            <button
                              type="button"
                              className="rounded-full bg-white/5 px-2 py-1 text-[11px] text-white/70"
                              onClick={() => setProviderTemperature("")}
                            >
                              Auto
                            </button>
                          </div>
                        </div>
                        <input
                          type="range"
                          min="0"
                          max="2"
                          step="0.1"
                          value={providerTemperature === "" ? "1" : providerTemperature}
                          onChange={(e) =>
                            setProviderTemperature(
                              normalizeTemperatureInput(e.target.value),
                            )
                          }
                          className="w-full accent-brand-500"
                        />
                        <p className="mt-2 text-[11px] text-white/45">
                          Set kosong untuk mengikuti default model/provider.
                        </p>
                      </div>
                      <p className="text-xs text-white/45">
                        {providerHint(providerKey)}
                      </p>
                    </div>

                    <div className="flex gap-2">
                      <button
                        type="submit"
                        className="rounded-2xl bg-brand-500 px-4 py-3 text-sm font-semibold text-[#10251a] disabled:opacity-60"
                        disabled={addingProvider}
                        aria-busy={addingProvider}
                      >
                        {addingProvider ? "Adding..." : "Add provider"}
                      </button>
                    </div>
                  </form>

                  <div className="mt-4 max-h-[200px] space-y-3 overflow-y-auto pr-1">
                    {providersLoading ? (
                      <div className="rounded-[22px] bg-[#2e2f2f] px-4 py-6 text-sm text-white/45">
                        Loading providers...
                      </div>
                    ) : null}

                    {!providersLoading && !providers.length ? (
                      <div className="rounded-[22px] bg-[#2e2f2f] px-4 py-6 text-sm leading-6 text-white/45">
                        No providers configured.
                      </div>
                    ) : null}

                    {providers.map((p) => (
                      <div
                        key={p.id}
                        className="rounded-[22px] bg-[#2e2f2f] px-4 py-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h4 className="truncate text-sm font-semibold text-white">
                              {p.name}
                            </h4>
                            <p className="mt-1 text-xs text-white/55">
                              {p.provider}
                            </p>
                          </div>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              className="rounded-full bg-white/5 px-3 py-1.5 text-xs font-medium text-white/80"
                              onClick={() => handleFetchModels(p.id)}
                              disabled={modelsLoadingId === p.id}
                            >
                              {modelsLoadingId === p.id
                                ? "Fetching..."
                                : "Fetch models"}
                            </button>
                            <button
                              type="button"
                              className="rounded-full bg-red-700 px-3 py-1.5 text-xs font-medium text-white/80"
                              onClick={() => handleDeleteProvider(p.id)}
                            >
                              Delete
                            </button>
                          </div>
                        </div>

                        <div className="mt-3 text-xs text-white/40">
                          <p>Created: {formatDateTime(p.createdAt)}</p>
                        </div>

                        <div className="mt-3 rounded-[14px] bg-[#0f1111] px-3 py-3">
                          <div className="mb-2 flex items-center justify-between">
                            <p className="text-xs text-white/60">
                              Provider temperature
                            </p>
                            <span className="text-xs text-white/60">
                              {normalizeTemperatureInput(
                                providerTempDraftById[p.id] !== undefined
                                  ? providerTempDraftById[p.id]
                                  : p.config?.temperature,
                              ) || "Auto"}
                            </span>
                          </div>
                          <input
                            type="range"
                            min="0"
                            max="2"
                            step="0.1"
                            value={
                              normalizeTemperatureInput(
                                providerTempDraftById[p.id] !== undefined
                                  ? providerTempDraftById[p.id]
                                  : p.config?.temperature,
                              ) || "1"
                            }
                            onChange={(e) =>
                              setProviderTempDraftById((prev) => ({
                                ...(prev || {}),
                                [p.id]: normalizeTemperatureInput(
                                  e.target.value,
                                ),
                              }))
                            }
                            className="w-full accent-brand-500"
                          />
                          <div className="mt-2 flex items-center gap-2">
                            <button
                              type="button"
                              className="rounded-full bg-white/5 px-3 py-1 text-xs text-white/80"
                              onClick={() => handleSaveProviderTemperature(p)}
                              disabled={savingProviderConfigId === p.id}
                            >
                              {savingProviderConfigId === p.id
                                ? "Saving..."
                                : "Save provider temp"}
                            </button>
                            <button
                              type="button"
                              className="rounded-full bg-white/5 px-3 py-1 text-xs text-white/70"
                              onClick={async () => {
                                setProviderTempDraftById((prev) => ({
                                  ...(prev || {}),
                                  [p.id]: "",
                                }));
                                await handleSaveProviderTemperature(p, "");
                              }}
                              disabled={savingProviderConfigId === p.id}
                            >
                              Auto
                            </button>
                          </div>
                        </div>

                        {modelsMap[p.id] && modelsMap[p.id].length ? (
                          <div className="mt-3 grid gap-2">
                            <p className="text-xs text-white/45">Models:</p>
                            <div className="flex items-center justify-between gap-2 mt-2">
                              <div className="flex-1">
                                <select
                                  className="w-full rounded-[10px] bg-[#0f1111] px-3 py-2 text-sm text-white outline-none"
                                  value={
                                    defaultAiProviderId === p.id &&
                                    defaultAiModel
                                      ? defaultAiModel
                                      : ""
                                  }
                                  onChange={async (e) => {
                                    const modelId = e.target.value || null;
                                    try {
                                      await setDefaultAiProvider(p.id);
                                      await setDefaultAiModel(modelId);
                                    } catch (err) {
                                      // ignore
                                    }
                                  }}
                                >
                                  <option value="">
                                    Select model (set as default)
                                  </option>
                                  {modelsMap[p.id].map((m) => (
                                    <option key={m.id} value={m.id}>
                                      {m.name || m.id}
                                    </option>
                                  ))}
                                </select>
                              </div>

                              <div>
                                {defaultAiProviderId === p.id ? (
                                  <span className="rounded-full bg-emerald-600 px-3 py-1 text-xs text-white">
                                    Active
                                  </span>
                                ) : (
                                  <button
                                    type="button"
                                    className="rounded-full bg-white/5 px-3 py-1 text-xs text-white/80"
                                    onClick={async () => {
                                      try {
                                        await setDefaultAiProvider(p.id);
                                      } catch (err) {}
                                    }}
                                  >
                                    Set active
                                  </button>
                                )}
                              </div>
                            </div>

                            {defaultAiProviderId === p.id && defaultAiModel ? (
                              <div className="mt-2 rounded-[14px] bg-[#0f1111] px-3 py-3">
                                <div className="mb-2 flex items-center justify-between">
                                  <p className="text-xs text-white/60">
                                    Model temperature ({defaultAiModel})
                                  </p>
                                  <span className="text-xs text-white/60">
                                    {normalizeTemperatureInput(
                                      modelTempDraftByProvider[p.id] !==
                                        undefined
                                        ? modelTempDraftByProvider[p.id]
                                        : p.config?.modelTemperatures?.[
                                            defaultAiModel
                                          ],
                                    ) || "Auto"}
                                  </span>
                                </div>
                                <input
                                  type="range"
                                  min="0"
                                  max="2"
                                  step="0.1"
                                  value={
                                    normalizeTemperatureInput(
                                      modelTempDraftByProvider[p.id] !==
                                        undefined
                                        ? modelTempDraftByProvider[p.id]
                                        : p.config?.modelTemperatures?.[
                                            defaultAiModel
                                          ],
                                    ) || "1"
                                  }
                                  onChange={(e) =>
                                    setModelTempDraftByProvider((prev) => ({
                                      ...(prev || {}),
                                      [p.id]: normalizeTemperatureInput(
                                        e.target.value,
                                      ),
                                    }))
                                  }
                                  className="w-full accent-brand-500"
                                />
                                <div className="mt-2 flex items-center gap-2">
                                  <button
                                    type="button"
                                    className="rounded-full bg-white/5 px-3 py-1 text-xs text-white/80"
                                    onClick={() =>
                                      handleSaveModelTemperature(
                                        p,
                                        defaultAiModel,
                                      )
                                    }
                                    disabled={savingProviderConfigId === p.id}
                                  >
                                    {savingProviderConfigId === p.id
                                      ? "Saving..."
                                      : "Save model temp"}
                                  </button>
                                  <button
                                    type="button"
                                    className="rounded-full bg-white/5 px-3 py-1 text-xs text-white/70"
                                    onClick={async () => {
                                      setModelTempDraftByProvider((prev) => ({
                                        ...(prev || {}),
                                        [p.id]: "",
                                      }));
                                      await handleSaveModelTemperature(
                                        p,
                                        defaultAiModel,
                                        "",
                                      );
                                    }}
                                    disabled={savingProviderConfigId === p.id}
                                  >
                                    Auto
                                  </button>
                                </div>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                        <div className="mt-2">
                          <p className="text-xs text-white/45">Manual model</p>
                          <div className="flex items-center gap-2 mt-2">
                            <input
                              className="flex-1 w-full rounded-[10px] bg-[#0f1111] px-3 py-2 text-sm text-white outline-none"
                              placeholder="Enter model id (e.g. gpt-5-mini)"
                              value={manualModelByProvider[p.id] || ""}
                              onChange={(e) =>
                                setManualModelByProvider((prev) => ({
                                  ...(prev || {}),
                                  [p.id]: e.target.value,
                                }))
                              }
                              onKeyDown={async (e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault();
                                  const val =
                                    (
                                      manualModelByProvider[p.id] ||
                                      e.target.value ||
                                      ""
                                    )
                                      .trim()
                                      .replace(/^\s+|\s+$/g, "") || null;
                                  try {
                                    await setDefaultAiProvider(p.id);
                                    await setDefaultAiModel(val);
                                  } catch (err) {
                                    // ignore
                                  }
                                }
                              }}
                              autoComplete="off"
                            />
                            <button
                              type="button"
                              className="rounded-full bg-white/5 px-3 py-1 text-xs text-white/80"
                              onClick={async () => {
                                const val =
                                  (manualModelByProvider[p.id] || "")
                                    .trim()
                                    .replace(/^\s+|\s+$/g, "") || null;
                                try {
                                  await setDefaultAiProvider(p.id);
                                  await setDefaultAiModel(val);
                                } catch (err) {
                                  // ignore
                                }
                              }}
                            >
                              Set
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {activeTab === "advanced" && (
                <div className="rounded-[28px] bg-[#161717] p-4">
                  <p className="text-[11px] uppercase tracking-[0.24em] text-white/35">
                    Advanced
                  </p>
                  <h3 className="mt-2 text-base font-semibold text-white">
                    Terminal auto-approve
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-white/45">
                    When enabled, terminal commands requested with approvalMode
                    "auto" will be executed immediately without checking the
                    host allowlist. Use with caution.
                  </p>

                  <div className="mt-4 flex items-center justify-between">
                    <div>
                      <div className="text-sm text-white">
                        Allow new registrations
                      </div>
                      <div className="text-xs text-white/45">
                        Toggle whether new users can sign up for this OpenWA
                        workspace.
                      </div>
                    </div>

                    <button
                      type="button"
                      className={`rounded-full px-3 py-1 text-sm ${registerAllowed ? "bg-emerald-600 text-white" : "bg-white/5 text-white/60"}`}
                      onClick={async () => {
                        if (!token) return;
                        setRegisterLoading(true);
                        try {
                          const data = await apiFetch("/api/auth/config", {
                            method: "POST",
                            token,
                            body: { allowRegistration: !registerAllowed },
                          });
                          setRegisterAllowed(data.allowRegistration === true);
                        } catch (error) {
                          alert(
                            error.message ||
                              "Failed to update registration setting",
                          );
                        } finally {
                          setRegisterLoading(false);
                        }
                      }}
                      disabled={registerLoading}
                    >
                      {registerLoading
                        ? "Saving..."
                        : registerAllowed
                          ? "Enabled"
                          : "Disabled"}
                    </button>
                  </div>

                  <div className="mt-4 flex items-center justify-between">
                    <div>
                      <div className="text-sm text-white">
                        Auto-approve terminal commands
                      </div>
                      <div className="text-xs text-white/45">
                        Bypass OPENWA_TERMINAL_ALLOWLIST and allow auto
                        execution of any command.
                      </div>
                    </div>

                    <button
                      type="button"
                      className={`rounded-full px-3 py-1 text-sm ${terminalAutoApproveAll ? "bg-emerald-600 text-white" : "bg-white/5 text-white/60"}`}
                      onClick={async () => {
                        try {
                          await setTerminalAutoApproveAll(
                            !terminalAutoApproveAll,
                          );
                        } catch (error) {
                          // ignore UI error toast for now; store state already rolled back
                        }
                      }}
                    >
                      {terminalAutoApproveAll ? "Enabled" : "Disabled"}
                    </button>
                  </div>

                  <div className="mt-8 rounded-[22px] bg-[#2e2f2f] p-4 ring-1 ring-white/10">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm font-semibold text-white">
                          Reset user password
                        </p>
                        <p className="mt-1 text-xs text-white/45">
                          Set a new password for an existing user account.
                        </p>
                      </div>
                      <span className="rounded-full bg-white/5 px-3 py-1 text-xs text-white/70">
                        Admin only
                      </span>
                    </div>

                    <form
                      className="mt-4 space-y-3"
                      onSubmit={handleResetPassword}
                    >
                      <input
                        className="w-full rounded-[22px] bg-[#161717] px-4 py-3 text-sm text-white outline-none placeholder:text-white/30"
                        placeholder="New password"
                        type="password"
                        value={resetPasswordValue}
                        onChange={(e) => setResetPasswordValue(e.target.value)}
                        required
                      />
                      <button
                        type="submit"
                        className="w-full rounded-2xl bg-brand-500 px-4 py-3 text-sm font-semibold text-[#10251a] disabled:opacity-60"
                        disabled={resetPasswordLoading}
                      >
                        {resetPasswordLoading
                          ? "Resetting..."
                          : "Reset password"}
                      </button>
                    </form>
                  </div>

                  <div className="mt-6 rounded-[22px] bg-[#2e2f2f] p-4 ring-1 ring-white/10">
                    <p className="text-sm font-semibold text-white">
                      Reset all OpenWA data
                    </p>
                    <p className="mt-1 text-xs text-white/45">
                      Permanently deletes all stored app data. Requires
                      confirmation.
                    </p>
                    <button
                      type="button"
                      className="mt-4 w-full rounded-2xl bg-red-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
                      onClick={handleResetAllData}
                      disabled={resetAllLoading}
                    >
                      {resetAllLoading ? "Resetting..." : "Reset all data"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      <ToolsEditorModal open={toolsOpen} onClose={() => setToolsOpen(false)} />
      <TerminalMonitorModal
        open={terminalOpen}
        onClose={() => setTerminalOpen(false)}
      />
    </>
  );
}
