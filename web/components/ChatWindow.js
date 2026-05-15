import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { apiFetch, getApiBaseUrl } from "@/lib/api";
import { useAppStore } from "@/store/useAppStore";
import { ChatProfileModal } from "@/components/ChatProfileModal";
import { MessageMarkdown } from "@/components/MessageMarkdown";
import { TerminalChatCard } from "@/components/TerminalChatCard";
import { MessageActionMenu } from "./MessageActionMenu";
import { MediaPreviewModal } from "./MediaPreviewModal";
import { EmojiPicker } from "./EmojiPicker";
import { SendButtonSpinner, MessagesSkeletonList } from "./Skeletons";
import {
  MdMoreVert,
  MdSend,
  MdEmojiEmotions,
  MdSearch,
  MdAdd,
  MdSettings,
  MdLogout,
  MdGroups,
  MdClose,
  MdFlashOn,
  MdRefresh,
  MdSmartToy,
} from "react-icons/md";

function formatTime(value) {
  if (!value) {
    return "";
  }

  return new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function renderStatus(message) {
  const deliveryStatus = message.outboundDelivery?.status;
  if (deliveryStatus === "failed") {
    return "Failed";
  }
  if (deliveryStatus === "canceled") {
    return "Canceled";
  }
  if (deliveryStatus === "queued" || deliveryStatus === "sending") {
    return "Sending";
  }

  const status = message.statuses?.[message.statuses.length - 1]?.status;
  if (!status || message.direction !== "outbound") {
    return "";
  }

  return status === "read"
    ? "Read"
    : status === "delivered"
      ? "Delivered"
      : "Sent";
}

function isDeliveryFailed(message) {
  return message.outboundDelivery?.status === "failed";
}

function getTerminalMessageId(message) {
  const externalMessageId = String(message?.externalMessageId || "");
  if (!externalMessageId.startsWith("terminal:")) {
    return null;
  }

  return externalMessageId.slice("terminal:".length) || null;
}

function previewReply(message) {
  if (!message) {
    return "";
  }

  if (message.body) {
    return message.body;
  }

  if (message.mediaFile?.originalName) {
    return message.mediaFile.originalName;
  }

  return "Attachment";
}

function initials(value) {
  return String(value || "?")
    .slice(0, 2)
    .toUpperCase();
}

function ChatAvatar({ src, label }) {
  if (src) {
    return (
      <img
        src={src}
        alt={label}
        className="h-11 w-11 rounded-2xl object-cover"
      />
    );
  }

  return (
    <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#2e2f2f] text-sm font-semibold text-white">
      {initials(label)}
    </div>
  );
}

function QrCodeWithCountdown({ mediaUrl, originalName, createdAt }) {
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
      <div className="flex h-[450px] w-[450px] flex-col items-center justify-center rounded-2xl bg-[#2e2f2f] p-6 text-center shadow-lg border border-white/5">
        <MdRefresh className="mb-4 text-5xl text-white/20 animate-spin-slow" />
        <p className="mb-4 font-medium text-white/60">QR Code Expired</p>
        <button
          onClick={() => window.location.reload()}
          className="rounded-full bg-emerald-500 px-6 py-2 text-sm font-semibold text-white shadow-md hover:bg-emerald-600 transition"
        >
          Refresh to Get New QR
        </button>
      </div>
    );
  }

  return (
    <div className="relative h-[450px] w-[450px] overflow-hidden rounded-2xl bg-white p-6 shadow-lg">
      <img
        src={mediaUrl}
        alt={originalName}
        className="h-full w-full object-contain"
      />
      <div className="absolute bottom-4 right-4 flex items-center gap-2 rounded-full bg-black/70 px-3 py-1 text-xs font-bold text-white backdrop-blur-sm">
        <span className={timeLeft <= 10 ? "text-red-400 animate-pulse" : ""}>
          Expires in {timeLeft}s
        </span>
      </div>
    </div>
  );
}

function renderMediaPreview(message) {
  if (!message.mediaFile) {
    return null;
  }

  const mediaUrl = `${getApiBaseUrl()}/${message.mediaFile.relativePath}`;
  const mimeType = String(message.mediaFile.mimeType || "");
  const isSticker = message.type === "sticker" || mimeType === "image/webp";
  const isQrCode =
    String(message.mediaFile.originalName || "").toLowerCase() ===
      "whatsapp-qr.png" ||
    String(message.mediaFile.fileName || "")
      .toLowerCase()
      .startsWith("qr-");

  if (isSticker) {
    return (
      <a
        href={mediaUrl}
        target="_blank"
        rel="noreferrer"
        className="mb-2 inline-flex overflow-hidden rounded-2xl bg-transparent"
      >
        <img
          src={mediaUrl}
          alt={message.mediaFile.originalName}
          className="h-36 w-36 object-contain drop-shadow-sm"
        />
      </a>
    );
  }

  if (mimeType.startsWith("image/")) {
    if (isQrCode) {
      return (
        <div className="mb-2">
          <QrCodeWithCountdown
            mediaUrl={mediaUrl}
            originalName={message.mediaFile.originalName}
            createdAt={message.createdAt}
          />
        </div>
      );
    }

    return (
      <a
        href={mediaUrl}
        target="_blank"
        rel="noreferrer"
        className="mb-2 block overflow-hidden rounded-2xl"
      >
        <img
          src={mediaUrl}
          alt={message.mediaFile.originalName}
          className="max-h-[320px] w-full rounded-2xl object-contain"
        />
      </a>
    );
  }

  if (mimeType.startsWith("video/")) {
    return (
      <video
        controls
        className="mb-2 max-h-[320px] w-full rounded-2xl bg-black"
      >
        <source src={mediaUrl} type={mimeType} />
      </video>
    );
  }

  if (mimeType.startsWith("audio/")) {
    return (
      <audio controls className="mb-2 w-full">
        <source src={mediaUrl} type={mimeType} />
      </audio>
    );
  }

  return (
    <a
      href={mediaUrl}
      target="_blank"
      rel="noreferrer"
      className="mb-2 inline-flex rounded-xl bg-white/10 px-3 py-2 text-sm font-medium text-white underline-offset-2 hover:underline"
    >
      {message.mediaFile.originalName}
    </a>
  );
}

function isImageFile(mimeType) {
  return mimeType && mimeType.startsWith("image/") && mimeType !== "image/webp";
}

function groupConsecutiveImages(messages) {
  const groups = [];
  let currentGroup = null;
  const TWO_MINUTES = 2 * 60 * 1000;

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const mimeType = String(message.mediaFile?.mimeType || "");
    const isImage = message.mediaFile && isImageFile(mimeType);

    if (isImage && currentGroup === null) {
      // Start a new image group
      currentGroup = {
        type: "image-group",
        messages: [message],
        direction: message.direction,
        startTime: new Date(message.createdAt).getTime(),
      };
    } else if (
      isImage &&
      currentGroup &&
      currentGroup.type === "image-group" &&
      currentGroup.direction === message.direction &&
      new Date(message.createdAt).getTime() - currentGroup.startTime <=
        TWO_MINUTES
    ) {
      // Add to current group
      currentGroup.messages.push(message);
    } else {
      // Not consecutive, save current group if exists
      if (currentGroup) {
        groups.push(currentGroup);
        currentGroup = null;
      }
      // Add single message
      if (!isImage) {
        groups.push({ type: "single", message });
      }
    }
  }

  // Don't forget the last group
  if (currentGroup) {
    groups.push(currentGroup);
  }

  return groups;
}

function renderGridImage(group, onImageClick) {
  const images = group.messages.map((msg) => msg.mediaFile).filter(Boolean);
  if (images.length === 0) return null;

  if (images.length === 1) {
    const img = images[0];
    const message = group.messages[0];
    const mediaUrl = `${getApiBaseUrl()}/${img.relativePath}`;
    const isQrCode =
      String(img.originalName || "").toLowerCase() === "whatsapp-qr.png" ||
      String(img.fileName || "")
        .toLowerCase()
        .startsWith("qr-");

    if (isQrCode) {
      return (
        <div className="mb-2">
          <QrCodeWithCountdown
            mediaUrl={mediaUrl}
            originalName={img.originalName}
            createdAt={message.createdAt}
          />
        </div>
      );
    }

    return (
      <img
        src={mediaUrl}
        alt={img.originalName}
        className="mb-2 h-24 w-24 cursor-pointer rounded-2xl object-cover"
        onClick={() =>
          onImageClick({
            mediaUrl,
            relativePath: img.relativePath,
            mimeType: img.mimeType,
            originalName: img.originalName,
            isImage: true,
          })
        }
      />
    );
  }

  return (
    <div className="mb-2 grid grid-cols-2 gap-1">
      {images.map((img, idx) => {
        const mediaUrl = `${getApiBaseUrl()}/${img.relativePath}`;
        return (
          <img
            key={idx}
            src={mediaUrl}
            alt={img.originalName}
            className="h-32 w-32 cursor-pointer rounded-lg object-cover"
            onClick={() =>
              onImageClick({
                mediaUrl,
                relativePath: img.relativePath,
                mimeType: img.mimeType,
                originalName: img.originalName,
                isImage: true,
              })
            }
          />
        );
      })}
    </div>
  );
}

function renderMediaPreviewWithCallback(message, onImageClick) {
  if (!message.mediaFile) {
    return null;
  }

  const mediaUrl = `${getApiBaseUrl()}/${message.mediaFile.relativePath}`;
  const mimeType = String(message.mediaFile.mimeType || "");
  const isSticker = message.type === "sticker" || mimeType === "image/webp";
  const isQrCode =
    String(message.mediaFile.originalName || "").toLowerCase() ===
      "whatsapp-qr.png" ||
    String(message.mediaFile.fileName || "")
      .toLowerCase()
      .startsWith("qr-");

  if (isSticker) {
    return (
      <a
        href={mediaUrl}
        target="_blank"
        rel="noreferrer"
        className="mb-2 inline-flex overflow-hidden rounded-2xl bg-transparent"
      >
        <img
          src={mediaUrl}
          alt={message.mediaFile.originalName}
          className="h-36 w-36 object-contain drop-shadow-sm"
        />
      </a>
    );
  }

  if (isImageFile(mimeType)) {
    if (isQrCode) {
      return (
        <div className="mb-2">
          <QrCodeWithCountdown
            mediaUrl={mediaUrl}
            originalName={message.mediaFile.originalName}
            createdAt={message.createdAt}
          />
        </div>
      );
    }

    return (
      <img
        src={mediaUrl}
        alt={message.mediaFile.originalName}
        className="mb-2 max-h-[320px] w-full cursor-pointer rounded-2xl object-contain"
        onClick={() =>
          onImageClick &&
          onImageClick({
            mediaUrl,
            relativePath: message.mediaFile.relativePath,
            mimeType: message.mediaFile.mimeType,
            originalName: message.mediaFile.originalName,
            isImage: true,
          })
        }
      />
    );
  }

  if (mimeType.startsWith("video/")) {
    return (
      <video
        controls
        className="mb-2 max-h-[320px] w-full rounded-2xl bg-black"
      >
        <source src={mediaUrl} type={mimeType} />
      </video>
    );
  }

  if (mimeType.startsWith("audio/")) {
    return (
      <audio controls className="mb-2 w-full">
        <source src={mediaUrl} type={mimeType} />
      </audio>
    );
  }

  return (
    <a
      href={mediaUrl}
      target="_blank"
      rel="noreferrer"
      className="mb-2 inline-flex rounded-xl bg-white/10 px-3 py-2 text-sm font-medium text-white underline-offset-2 hover:underline"
    >
      {message.mediaFile.originalName}
    </a>
  );
}

export const ChatWindow = forwardRef(function ChatWindow(
  {
    chat,
    messages,
    chats,
    typingState,
    loading,
    messagesLoading,
    loadingOlder,
    hasMoreMessages,
    messageQuery,
    onMessageQueryChange,
    onLoadOlder,
    onSendMessage,
    onSendMedia,
    onTyping,
    onDeleteMessage,
    onForwardMessage,
    onOpenContacts,
    onOpenCrm,
    onOpenSettings,
    onLogout,
  },
  ref,
) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [replyTo, setReplyTo] = useState(null);
  const [forwardingMessageId, setForwardingMessageId] = useState(null);
  const [forwardTargetChatId, setForwardTargetChatId] = useState("");
  const [searchOpen, setSearchOpen] = useState(Boolean(messageQuery));
  const [searchResultIndex, setSearchResultIndex] = useState(0);
  const [hoveredMessageId, setHoveredMessageId] = useState(null);
  const [activeMenuMessageId, setActiveMenuMessageId] = useState(null);
  const [selectedMediaModal, setSelectedMediaModal] = useState(null);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [pendingFiles, setPendingFiles] = useState([]);
  const [profileOpen, setProfileOpen] = useState(false);
  const [confirmingScanMap, setConfirmingScanMap] = useState({});
  const updateMessage = useAppStore((s) => s.updateMessage);
  const typingStateByChat = useAppStore((s) => s.typingByChat);
  const effectiveTypingState =
    typingState || (chat?.id ? typingStateByChat[chat?.id] : null);

  const composerRef = useRef(null);
  const searchInputRef = useRef(null);
  const messagesViewportRef = useRef(null);
  const messagesEndRef = useRef(null);
  const pendingOpenChatScrollRef = useRef(false);
  const previousMessagesCountRef = useRef(0);
  const fileInputRef = useRef(null);
  const menuTriggerRef = useRef(null);
  const emojiTriggerRef = useRef(null);
  const emojiContainerRef = useRef(null);
  const [shortcutMenuOpen, setShortcutMenuOpen] = useState(false);
  const shortcutTriggerRef = useRef(null);
  const shortcutContainerRef = useRef(null);
  const [aiMenuOpen, setAiMenuOpen] = useState(false);
  const aiTriggerRef = useRef(null);
  const aiContainerRef = useRef(null);
  const [aiProviders, setAiProviders] = useState([]);
  const [aiProvidersLoading, setAiProvidersLoading] = useState(false);
  const [modelsMap, setModelsMap] = useState({});
  const [selectedAiProviderId, setSelectedAiProviderId] = useState("");
  const [selectedAiModel, setSelectedAiModel] = useState("");
  const [manualModelInput, setManualModelInput] = useState("");
  const [savingAiSelection, setSavingAiSelection] = useState(false);

  useEffect(() => {
    const handleClickOutside = (event) => {
      // Handle Emoji Picker click outside
      if (
        emojiPickerOpen &&
        emojiContainerRef.current &&
        !emojiContainerRef.current.contains(event.target) &&
        !emojiTriggerRef.current.contains(event.target)
      ) {
        setEmojiPickerOpen(false);
      }

      // Handle Shortcut Menu click outside
      if (
        shortcutMenuOpen &&
        shortcutContainerRef.current &&
        !shortcutContainerRef.current.contains(event.target) &&
        !shortcutTriggerRef.current.contains(event.target)
      ) {
        setShortcutMenuOpen(false);
      }

      // Handle AI Provider menu click outside
      if (
        aiMenuOpen &&
        aiContainerRef.current &&
        !aiContainerRef.current.contains(event.target) &&
        !aiTriggerRef.current.contains(event.target)
      ) {
        setAiMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [emojiPickerOpen, shortcutMenuOpen, aiMenuOpen]);

  const isAssistantChat = Boolean(
    chat?.contact?.externalId &&
    (chat.contact.externalId === "openwa:assistant" ||
      String(chat.contact.externalId).startsWith("openwa:assistant") ||
      String(chat.contact.externalId).endsWith(":assistant")),
  );

  const shortcuts = [
    ...(isAssistantChat
      ? [
          {
            label: "New Assistant Chat",
            message: "/new",
            icon: "✨",
          },
        ]
      : []),
    {
      label: "Add WhatsApp Device",
      message: "Please help me add a new WhatsApp device",
      icon: "📱",
    },
    {
      label: "Integrate Telegram",
      message: "How can I remote OpenWA via Telegram?",
      icon: "🤖",
    },
    {
      label: "Latest Messages",
      message: "Show me the latest messages from my WhatsApp chats",
      icon: "💬",
    },
    {
      label: "Create Coding Project",
      message:
        "I want to create a new coding project in the workspace. Help me scaffold it.",
      icon: "🚀",
    },
    {
      label: "Register New Tool",
      message:
        "I want to register a new external tool/API to your capabilities.",
      icon: "🛠️",
    },
    {
      label: "Setup LLM Provider",
      message: "Help me setup an LLM Provider (OpenAI/Anthropic/Ollama)",
      icon: "🧠",
    },
    {
      label: "Create API Key",
      message: "I want to create a new API Key",
      icon: "🔑",
    },
    {
      label: "Check Workspace",
      message: "Check the contents of my workspace folder",
      icon: "📁",
    },
    {
      label: "Reset Password",
      message: "/reset_password",
      icon: "🔒",
    },
    {
      label: "Help / Capabilities",
      message: "What are your capabilities as an AI Assistant?",
      icon: "❓",
    },
  ];

  const handleShortcutClick = async (message) => {
    setShortcutMenuOpen(false);
    setDraft(""); // Clear any existing draft first

    // Use onSendMessage directly to avoid draft race conditions
    setBusy(true);
    try {
      await onSendMessage({
        body: message,
        replyToId: null,
      });
      onTyping(false);
    } catch (err) {
      console.error("Failed to send shortcut message:", err);
      // Fallback: put it in draft if send fails
      setDraft(message);
    } finally {
      setBusy(false);
    }
  };

  const searchResults = useMemo(() => {
    const query = String(messageQuery || "")
      .trim()
      .toLowerCase();
    if (!query) {
      return [];
    }

    return messages
      .map((message, index) => {
        const matches = [
          message.body,
          message.sender,
          message.replyTo?.body,
          message.mediaFile?.originalName,
        ]
          .filter(Boolean)
          .some((value) => value.toLowerCase().includes(query));
        return matches ? index : -1;
      })
      .filter((index) => index !== -1);
  }, [messageQuery, messages]);

  const filteredMessages = useMemo(() => {
    if (!messageQuery) {
      return messages;
    }
    return messages;
  }, [messageQuery, messages]);

  const forwardTargets = chats.filter((item) => item.id !== chat?.id);

  const submitComposer = async () => {
    if (pendingFiles.length > 0) {
      await handleSendWithFiles();
      return;
    }

    if (draft.trim()) {
      await sendDraft();
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    await submitComposer();
  };

  const sendDraft = async () => {
    if (!draft.trim()) {
      return;
    }

    setBusy(true);

    try {
      await onSendMessage({
        body: draft.trim(),
        replyToId: replyTo?.id || null,
      });
      setDraft("");
      setReplyTo(null);
      onTyping(false);
    } finally {
      setBusy(false);
    }
  };

  const handleFile = async (event) => {
    const files = event.target.files;
    if (!files || files.length === 0) {
      return;
    }

    const newPendingFiles = [];
    for (let file of files) {
      let preview = null;
      const mimeType = file.type || "";

      if (mimeType.startsWith("image/")) {
        preview = URL.createObjectURL(file);
      } else if (mimeType.startsWith("video/")) {
        preview = URL.createObjectURL(file);
      }

      newPendingFiles.push({
        file,
        name: file.name,
        size: file.size,
        type: mimeType,
        preview,
      });
    }

    setPendingFiles((current) => [...current, ...newPendingFiles]);
    event.target.value = "";
  };

  const removePendingFile = (index) => {
    setPendingFiles((current) => {
      const updated = [...current];
      const file = updated[index];
      if (file.preview) {
        URL.revokeObjectURL(file.preview);
      }
      updated.splice(index, 1);
      return updated;
    });
  };

  const releasePendingFilePreviews = (files) => {
    for (const pendingFile of files || []) {
      if (pendingFile?.preview) {
        URL.revokeObjectURL(pendingFile.preview);
      }
    }
  };

  const handleSendWithFiles = async () => {
    if (pendingFiles.length === 0) {
      return sendDraft();
    }

    const queuedFiles = [...pendingFiles];
    const queuedDraft = draft;
    const queuedReplyTo = replyTo;

    setBusy(true);
    setUploading(true);
    setDraft("");
    setReplyTo(null);
    setPendingFiles([]);
    onTyping(false);

    try {
      for (let i = 0; i < queuedFiles.length; i++) {
        const pendingFile = queuedFiles[i];
        const isLastFile = i === queuedFiles.length - 1;
        const caption = isLastFile ? queuedDraft.trim() : "";

        await onSendMedia({ file: pendingFile.file, caption });
      }
      releasePendingFilePreviews(queuedFiles);
    } catch (error) {
      setDraft(queuedDraft);
      setReplyTo(queuedReplyTo);
      setPendingFiles(queuedFiles);
      throw error;
    } finally {
      setBusy(false);
      setUploading(false);
    }
  };

  const token = useAppStore((s) => s.token);
  const setActiveChat = useAppStore((s) => s.setActiveChat);
  const upsertChat = useAppStore((s) => s.upsertChat);
  const defaultAiProviderId = useAppStore((s) => s.defaultAiProviderId);
  const defaultAiModel = useAppStore((s) => s.defaultAiModel);
  const setDefaultAiProvider = useAppStore((s) => s.setDefaultAiProvider);
  const setDefaultAiModel = useAppStore((s) => s.setDefaultAiModel);
  const [creatingAssistant, setCreatingAssistant] = useState(false);

  useEffect(() => {
    if (!aiMenuOpen) return undefined;
    let mounted = true;
    setAiProvidersLoading(true);
    setSelectedAiProviderId(defaultAiProviderId || "");
    setSelectedAiModel(defaultAiModel || "");
    setManualModelInput("");

    (async () => {
      if (!token) {
        if (mounted) setAiProvidersLoading(false);
        return;
      }
      try {
        const data = await apiFetch("/api/ai-providers", { token });
        if (!mounted) return;
        setAiProviders(data.providers || []);
      } catch (err) {
        // ignore
      } finally {
        if (mounted) setAiProvidersLoading(false);
      }
    })();

    return () => {
      mounted = false;
    };
  }, [aiMenuOpen, token, defaultAiProviderId, defaultAiModel]);

  useEffect(() => {
    if (!selectedAiProviderId || modelsMap[selectedAiProviderId] || !token) {
      return undefined;
    }

    let mounted = true;
    (async () => {
      try {
        const data = await apiFetch(
          `/api/ai-providers/${selectedAiProviderId}/models`,
          { token },
        );
        if (!mounted) return;
        setModelsMap((current) => ({
          ...current,
          [selectedAiProviderId]: data.models || [],
        }));
      } catch (err) {
        // ignore
      }
    })();

    return () => {
      mounted = false;
    };
  }, [selectedAiProviderId, token, modelsMap]);

  const handleSaveAiSelection = async () => {
    if (!selectedAiProviderId) return;
    setSavingAiSelection(true);
    try {
      await setDefaultAiProvider(selectedAiProviderId);
      const nextModel = selectedAiModel || manualModelInput.trim() || null;
      await setDefaultAiModel(nextModel);
      setAiMenuOpen(false);
    } catch (err) {
      // ignore
    } finally {
      setSavingAiSelection(false);
    }
  };

  const handleAiProviderChange = (providerId) => {
    setSelectedAiProviderId(providerId);
    setSelectedAiModel("");
    setManualModelInput("");
  };

  const handleAiModelChange = (modelId) => {
    setSelectedAiModel(modelId);
    setManualModelInput("");
  };

  const handleAiManualModelInput = (value) => {
    setManualModelInput(value);
  };

  const handleConfirmScan = async (sessionId, messageId) => {
    if (!token) return alert("Not authenticated");
    setConfirmingScanMap((m) => ({ ...m, [messageId]: true }));
    try {
      const res = await fetch(
        `${getApiBaseUrl()}/api/sessions/${sessionId}/confirm-scan`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Request failed");
      // Optionally notify user
      alert("Scan confirmed; waiting for device to connect.");
    } catch (err) {
      alert(err.message || "Failed to confirm scan");
    } finally {
      setConfirmingScanMap((m) => ({ ...m, [messageId]: false }));
    }
  };

  const handleEmojiSelect = (emoji) => {
    const textarea = composerRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart || 0;
    const end = textarea.selectionEnd || 0;
    const newDraft = draft.slice(0, start) + emoji + draft.slice(end);
    setDraft(newDraft);

    setTimeout(() => {
      textarea.focus();
      textarea.setSelectionRange(start + emoji.length, start + emoji.length);
    }, 0);

    setEmojiPickerOpen(false);
  };

  const handleForward = async (messageId) => {
    if (!forwardTargetChatId) {
      return;
    }

    await onForwardMessage(messageId, forwardTargetChatId);
    setForwardingMessageId(null);
    setForwardTargetChatId("");
  };

  const handleSearchNext = () => {
    if (searchResults.length === 0) return;
    const nextIndex = (searchResultIndex + 1) % searchResults.length;
    setSearchResultIndex(nextIndex);
    scrollToSearchResult(nextIndex);
  };

  const handleSearchPrev = () => {
    if (searchResults.length === 0) return;
    const prevIndex =
      (searchResultIndex - 1 + searchResults.length) % searchResults.length;
    setSearchResultIndex(prevIndex);
    scrollToSearchResult(prevIndex);
  };

  const scrollToSearchResult = (resultIndex) => {
    if (searchResults.length === 0) return;
    const messageIndex = searchResults[resultIndex];
    const messageElement = document.querySelector(
      `[data-message-id="${messages[messageIndex]?.id}"]`,
    );
    if (messageElement && messagesViewportRef.current) {
      messagesViewportRef.current.scrollTop =
        messageElement.offsetTop - messagesViewportRef.current.offsetTop;
    }
  };

  useEffect(() => {
    if (messageQuery && searchResults.length > 0) {
      setSearchResultIndex(0);
      scrollToSearchResult(0);
    }
  }, [messageQuery]);

  useImperativeHandle(
    ref,
    () => ({
      focusComposer() {
        composerRef.current?.focus();
      },
    }),
    [],
  );

  useEffect(() => {
    const textarea = composerRef.current;
    if (!textarea) {
      return;
    }

    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 128)}px`;
  }, [draft]);

  useEffect(() => {
    if (searchOpen) {
      searchInputRef.current?.focus();
    }
  }, [searchOpen]);

  // Track when chat is opened to scroll to bottom
  useEffect(() => {
    pendingOpenChatScrollRef.current = true;
    previousMessagesCountRef.current = 0; // Reset count when chat changes
  }, [chat?.id]);

  // Auto-scroll to bottom when opening a chat or when new messages arrive
  useEffect(() => {
    if (!chat?.id) {
      return;
    }

    const scrollToBottom = (behavior = "smooth") => {
      if (messagesViewportRef.current) {
        messagesViewportRef.current.scrollTo({
          top: messagesViewportRef.current.scrollHeight,
          behavior,
        });
      }
    };

    // If opening a new chat, always scroll to bottom
    if (pendingOpenChatScrollRef.current) {
      if (!messages.length) {
        scrollToBottom();
        pendingOpenChatScrollRef.current = false;
        return;
      }

      // Use longer delay for initial load since DOM needs more time to render many messages
      const timeoutId = setTimeout(() => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              scrollToBottom();
              pendingOpenChatScrollRef.current = false;
            });
          });
        });
      }, 300);

      return () => clearTimeout(timeoutId);
    }

    // If new messages arrived (not from loading older messages), scroll to bottom
    const currentCount = messages.length;
    const previousCount = previousMessagesCountRef.current;
    previousMessagesCountRef.current = currentCount;

    // Only auto-scroll if message count increased (new messages arrived, not prepended old ones)
    // and we're not in the middle of loading older messages
    if (currentCount > previousCount && !messagesLoading) {
      const newMessageCount = currentCount - previousCount;
      // Small delay to ensure DOM is updated
      const timeoutId = setTimeout(() => {
        scrollToBottom("smooth");
      }, 50);
      return () => clearTimeout(timeoutId);
    }
  }, [chat?.id, messages.length, messagesLoading]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center text-white/50">
        Loading dashboard...
      </div>
    );
  }

  if (!chat) {
    return (
      <div className="flex flex-1 items-center justify-center bg-[#161717] px-8 text-center text-white/50">
        <div>
          <p className="text-lg font-medium text-white">No chat selected</p>
          <p className="mt-3 max-w-md text-sm leading-7 text-white/45">
            Start a new conversation from the contact selector to begin
            chatting.
          </p>
          <button
            type="button"
            className="mt-5 rounded-full bg-brand-500 px-5 py-3 text-sm font-semibold text-[#10251a]"
            onClick={onOpenContacts}
          >
            New chat
          </button>
        </div>
      </div>
    );
  }

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-[#161717] text-white">
      <header className="flex h-[78px] shrink-0 items-center justify-between gap-4 bg-[#161717] px-6 py-3">
        <div
          className="flex min-w-0 items-center gap-3 cursor-pointer"
          onClick={() => setProfileOpen(true)}
        >
          <ChatAvatar
            src={chat.contact.avatarUrl}
            label={chat.contact.displayName}
          />
          <div className="min-w-0">
            <h2 className="truncate font-semibold text-white">
              {chat.contact.displayName}
            </h2>
            <p className="text-sm text-white/40">
              {effectiveTypingState?.isTyping
                ? `${effectiveTypingState.name} is typing...`
                : "WhatsApp chat synced locally"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {searchOpen || messageQuery ? (
            <div className="flex items-center gap-2 rounded-[22px] bg-[#2e2f2f] px-4 py-2">
              <input
                ref={searchInputRef}
                className="w-[180px] border-none bg-transparent text-sm text-white outline-none placeholder:text-white/30"
                placeholder="Search messages..."
                value={messageQuery}
                onChange={(event) => onMessageQueryChange(event.target.value)}
              />
              {searchResults.length > 0 && (
                <span className="text-xs text-white/60">
                  {searchResultIndex + 1}/{searchResults.length}
                </span>
              )}
              {searchResults.length > 0 && (
                <>
                  <button
                    type="button"
                    title="Previous result"
                    aria-label="Previous result"
                    className="text-sm leading-none text-white/55 transition hover:text-white"
                    onClick={handleSearchPrev}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    title="Next result"
                    aria-label="Next result"
                    className="text-sm leading-none text-white/55 transition hover:text-white"
                    onClick={handleSearchNext}
                  >
                    ↓
                  </button>
                </>
              )}
              <button
                type="button"
                title="Close search"
                aria-label="Close search"
                className="text-sm leading-none text-white/55 transition hover:text-white"
                onClick={() => {
                  onMessageQueryChange("");
                  setSearchOpen(false);
                }}
              >
                <MdClose className="w-4 h-4" />
              </button>
            </div>
          ) : null}
          <button
            type="button"
            title="Search"
            aria-label="Search"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-[#2e2f2f] text-base leading-none text-white transition hover:bg-[#3a3b3b]"
            onClick={() => setSearchOpen(true)}
          >
            <MdSearch className="w-5 h-5" />
          </button>
          <button
            type="button"
            title="New chat"
            aria-label="New chat"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-[#2e2f2f] text-lg leading-none text-white transition hover:bg-[#3a3b3b]"
            onClick={onOpenContacts}
          >
            <MdAdd className="w-5 h-5" />
          </button>
          <button
            type="button"
            title="Open CRM"
            aria-label="Open CRM"
            className="relative flex h-10 w-10 items-center justify-center rounded-full bg-amber-400 text-[#1d1600] shadow-[0_0_22px_rgba(251,191,36,0.42)] ring-1 ring-amber-100/70 transition hover:scale-105 hover:bg-amber-300 focus:outline-none focus:ring-2 focus:ring-amber-200"
            onClick={onOpenCrm}
          >
            <span className="absolute inset-0 rounded-full bg-amber-300/35 animate-ping" />
            <MdGroups className="relative h-5 w-5" />
          </button>
          <button
            type="button"
            title="New Assistant"
            aria-label="New Assistant"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-[#2e2f2f] text-sm leading-none text-white transition hover:bg-[#3a3b3b]"
            onClick={async () => {
              if (!token) return alert("Not authenticated");
              if (!confirm("Start a new Assistant conversation?")) return;
              setCreatingAssistant(true);
              try {
                const res = await fetch(
                  `${getApiBaseUrl()}/api/assistant/sessions`,
                  {
                    method: "POST",
                    headers: {
                      Authorization: `Bearer ${token}`,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({}),
                  },
                );
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || "Request failed");
                const chat = data.chat;
                if (chat && chat.id) {
                  upsertChat(chat);
                  setActiveChat(chat.id);
                }
              } catch (err) {
                alert(err.message || "Failed to create assistant session");
              } finally {
                setCreatingAssistant(false);
              }
            }}
            disabled={creatingAssistant}
          >
            {creatingAssistant ? "..." : "AI"}
          </button>
          <button
            type="button"
            title="Settings"
            aria-label="Settings"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-[#2e2f2f] text-base leading-none text-white transition hover:bg-[#3a3b3b]"
            onClick={onOpenSettings}
          >
            <MdSettings className="w-5 h-5" />
          </button>
          <button
            type="button"
            title="Logout"
            aria-label="Logout"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-[#2e2f2f] text-base leading-none text-white transition hover:bg-[#3a3b3b]"
            onClick={onLogout}
          >
            <MdLogout className="w-5 h-5" />
          </button>
        </div>
      </header>

      <ChatProfileModal
        open={profileOpen}
        chat={chat}
        onClose={() => setProfileOpen(false)}
      />

      <div
        ref={messagesViewportRef}
        className="flex-1 overflow-y-auto bg-[#161717] px-8 py-5"
      >
        <div className="mb-5 flex justify-center">
          <button
            type="button"
            className="rounded-full bg-[#2e2f2f] px-4 py-2 text-xs font-medium text-white/60 transition hover:text-white disabled:opacity-40"
            onClick={onLoadOlder}
            disabled={!hasMoreMessages || loadingOlder}
          >
            {loadingOlder
              ? "Loading..."
              : hasMoreMessages
                ? "Load older messages"
                : "All messages loaded"}
          </button>
        </div>

        {messagesLoading ? <MessagesSkeletonList /> : null}

        <div className="space-y-3">
          {(() => {
            const groupedMessages = groupConsecutiveImages(messages);
            return groupedMessages.map((group, groupIndex) => {
              if (group.type === "image-group") {
                // Render grouped images
                const firstMessage = group.messages[0];
                const outbound = firstMessage.direction === "outbound";
                // Merge captions from all images in the group
                const captions = group.messages
                  .map((msg) => msg.body)
                  .filter(Boolean)
                  .join("\n");

                return (
                  <div
                    key={`group-${groupIndex}`}
                    className={`flex ${outbound ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[72%] rounded-[18px] px-4 py-3 shadow-[0_16px_32px_rgba(0,0,0,0.18)] transition-colors relative ${
                        outbound ? "bg-[#144d37]" : "bg-[#2e2f2f]"
                      }`}
                    >
                      {renderGridImage(group, (media) =>
                        setSelectedMediaModal(media),
                      )}
                      {captions ? (
                        <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-white/88">
                          {captions}
                        </p>
                      ) : null}
                      <div className="mt-3 flex items-center justify-end gap-2 text-[11px] text-white/35">
                        <span>{formatTime(firstMessage.createdAt)}</span>
                        {outbound ? (
                          <span>{renderStatus(firstMessage)}</span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              } else {
                // Render single message
                const message = group.message;
                const outbound = message.direction === "outbound";
                const messageIndexInAll = messages.indexOf(message);
                const isSearchResult =
                  messageQuery && searchResults.includes(messageIndexInAll);
                const isCurrentSearchResult =
                  isSearchResult &&
                  searchResults[searchResultIndex] === messageIndexInAll;
                const terminalMessageId = getTerminalMessageId(message);
                const deliveryFailed = outbound && isDeliveryFailed(message);

                return (
                  <div
                    key={message.id}
                    data-message-id={message.id}
                    className={`flex ${outbound ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`max-w-[72%] rounded-[18px] px-4 py-3 shadow-[0_16px_32px_rgba(0,0,0,0.18)] transition-colors relative ${
                        isCurrentSearchResult
                          ? "ring-2 ring-brand-500 " +
                            (outbound ? "bg-[#1a5f41]" : "bg-[#3a4a4a]")
                          : isSearchResult
                            ? "ring-1 ring-brand-500/50 " +
                              (outbound ? "bg-[#144d37]" : "bg-[#2e2f2f]")
                            : deliveryFailed
                              ? "bg-red-950/80 ring-1 ring-red-400/30"
                            : outbound
                              ? "bg-[#144d37]"
                              : "bg-[#2e2f2f]"
                      }`}
                      onMouseEnter={() => setHoveredMessageId(message.id)}
                      onMouseLeave={() => setHoveredMessageId(null)}
                    >
                      {message.replyTo ? (
                        <div className="mb-2 rounded-2xl border-l-4 border-brand-500 bg-white/[0.04] px-3 py-2 text-xs text-white/55">
                          <span className="font-semibold text-white">
                            {message.replyTo.direction === "outbound"
                              ? "Anda"
                              : chat.contact.displayName}
                          </span>
                          <p className="mt-1 truncate">
                            {previewReply(message.replyTo)}
                          </p>
                        </div>
                      ) : null}

                      {/* Always render media preview if mediaFile exists */}
                      {message.mediaFile &&
                        renderMediaPreviewWithCallback(message, (media) =>
                          setSelectedMediaModal(media),
                        )}
                      {/* If this is a session assistant QR image, offer a "I scanned this QR" button */}
                      {message.mediaFile &&
                        message.sender &&
                        String(message.sender).startsWith("session:") &&
                        String(message.sender).endsWith(":assistant") &&
                        (message.type === "image" ||
                          String(message.mediaFile.mimeType || "").startsWith(
                            "image/",
                          )) && (
                          <div className="mt-2">
                            <button
                              type="button"
                              className="rounded-2xl bg-brand-500 px-3 py-2 text-sm font-semibold text-[#10251a]"
                              onClick={() => {
                                const parts = String(message.sender).split(":");
                                const sessionId = parts[1] || null;
                                if (!sessionId) return;
                                handleConfirmScan(sessionId, message.id);
                              }}
                              disabled={Boolean(confirmingScanMap[message.id])}
                            >
                              {confirmingScanMap[message.id]
                                ? "Confirming..."
                                : "I scanned this QR"}
                            </button>
                          </div>
                        )}
                      {terminalMessageId ? (
                        <TerminalChatCard
                          terminalId={terminalMessageId}
                          fallbackBody={message.body}
                          onReplaceTerminalId={(nextId) => {
                            updateMessage({
                              ...message,
                              externalMessageId: `terminal:${nextId}`,
                            });
                          }}
                        />
                      ) : null}
                      {!terminalMessageId && message.body ? (
                        <MessageMarkdown content={message.body} />
                      ) : null}

                      <div className="mt-3 flex items-center justify-end gap-3 text-[11px] text-white/35">
                        <span>{formatTime(message.createdAt)}</span>
                        {outbound ? (
                          <span
                            className={
                              deliveryFailed ? "font-semibold text-red-200" : ""
                            }
                          >
                            {renderStatus(message)}
                          </span>
                        ) : null}
                      </div>
                      {deliveryFailed && message.outboundDelivery?.lastError ? (
                        <p className="mt-2 text-[11px] leading-5 text-red-100/75">
                          {message.outboundDelivery.lastError}
                        </p>
                      ) : null}

                      {hoveredMessageId === message.id && (
                        <div className="absolute right-2 top-2 flex items-center gap-1">
                          <button
                            type="button"
                            ref={menuTriggerRef}
                            className="flex h-8 w-8 items-center justify-center rounded-full bg-[#2e2f2f] text-white/60 transition hover:bg-[#3a3b3b] hover:text-white"
                            onClick={() =>
                              setActiveMenuMessageId((current) =>
                                current === message.id ? null : message.id,
                              )
                            }
                            title="More options"
                          >
                            <MdMoreVert className="w-5 h-5" />
                          </button>
                          <MessageActionMenu
                            isOpen={activeMenuMessageId === message.id}
                            onClose={() => setActiveMenuMessageId(null)}
                            message={message}
                            onReply={() => setReplyTo(message)}
                            onDelete={() => onDeleteMessage(message.id)}
                            onForward={() => {
                              setForwardingMessageId((current) =>
                                current === message.id ? null : message.id,
                              );
                              setForwardTargetChatId("");
                            }}
                            isOutbound={outbound}
                            triggerRef={menuTriggerRef}
                          />
                        </div>
                      )}

                      {forwardingMessageId === message.id ? (
                        <div className="mt-3 flex flex-wrap gap-2 rounded-2xl bg-white/[0.04] p-3">
                          <select
                            className="min-w-[200px] flex-1 rounded-xl border border-white/10 bg-[#0b141a] px-3 py-2 text-sm text-white outline-none"
                            value={forwardTargetChatId}
                            onChange={(event) =>
                              setForwardTargetChatId(event.target.value)
                            }
                          >
                            <option value="">Select target chat</option>
                            {forwardTargets.map((target) => (
                              <option key={target.id} value={target.id}>
                                {target.contact.displayName}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="rounded-xl bg-brand-500 px-4 py-2 text-sm font-semibold text-[#10251a]"
                            onClick={() => handleForward(message.id)}
                          >
                            Send
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                );
              }
            });
          })()}
          {effectiveTypingState?.isTyping && (
            <div className="flex justify-start">
              <div className="max-w-[72%] rounded-[18px] bg-[#2e2f2f] px-4 py-3 shadow-[0_16px_32px_rgba(0,0,0,0.18)]">
                <div className="flex items-center gap-2 text-sm text-white/60 italic">
                  <span>{effectiveTypingState.name} is thinking...</span>
                  <div className="flex gap-1">
                    <span className="h-1 w-1 animate-bounce rounded-full bg-white/40 delay-0" />
                    <span className="h-1 w-1 animate-bounce rounded-full bg-white/40 delay-150" />
                    <span className="h-1 w-1 animate-bounce rounded-full bg-white/40 delay-300" />
                  </div>
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <form className="shrink-0 bg-[#161717] px-6 py-3" onSubmit={handleSubmit}>
        {replyTo ? (
          <div className="mb-3 flex items-start justify-between rounded-2xl bg-[#2e2f2f] px-4 py-3">
            <div className="min-w-0">
              <p className="text-xs uppercase tracking-[0.22em] text-brand-100">
                Reply
              </p>
              <p className="mt-1 truncate text-sm text-white/55">
                {previewReply(replyTo)}
              </p>
            </div>
            <button
              type="button"
              className="text-sm text-white/45 hover:text-white"
              onClick={() => setReplyTo(null)}
            >
              <MdClose className="w-4 h-4" />
            </button>
          </div>
        ) : null}

        {pendingFiles.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2 rounded-2xl bg-white/[0.04] p-3">
            {pendingFiles.map((file, index) => (
              <div key={index} className="relative">
                {file.preview && file.type.startsWith("image/") ? (
                  <img
                    src={file.preview}
                    alt={file.name}
                    className="h-16 w-16 rounded-lg object-cover"
                  />
                ) : file.preview && file.type.startsWith("video/") ? (
                  <video
                    src={file.preview}
                    className="h-16 w-16 rounded-lg object-cover"
                  />
                ) : (
                  <div className="flex h-16 w-16 items-center justify-center rounded-lg bg-[#2e2f2f] text-sm font-medium text-white/60">
                    {file.name.split(".").pop()?.toUpperCase() || "FILE"}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => removePendingFile(index)}
                  className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-red-500 text-xs text-white transition hover:bg-red-600"
                >
                  <MdClose className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-center gap-2 relative">
          <label className="flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-full bg-[#2e2f2f] text-[24px] leading-none text-white/60 transition hover:bg-[#3a3b3b] hover:text-white">
            <MdAdd className="w-5 h-5" />
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              onChange={handleFile}
              multiple
              accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"
            />
          </label>
          <button
            type="button"
            ref={emojiTriggerRef}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#2e2f2f] text-[20px] transition hover:bg-[#3a3b3b]"
            onClick={() => setEmojiPickerOpen(!emojiPickerOpen)}
            title="Emoji"
          >
            <MdEmojiEmotions className="w-5 h-5" />
          </button>
          {emojiPickerOpen && (
            <div
              ref={emojiContainerRef}
              className="absolute bottom-full left-0 z-50"
            >
              <EmojiPicker
                isOpen={emojiPickerOpen}
                onClose={() => setEmojiPickerOpen(false)}
                onEmojiSelect={handleEmojiSelect}
                triggerRef={emojiTriggerRef}
              />
            </div>
          )}

          <button
            type="button"
            ref={shortcutTriggerRef}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition ${
              shortcutMenuOpen
                ? "bg-brand-500 text-[#10251a] ring-2 ring-emerald-400/60 shadow-[0_0_0_8px_rgba(16,37,26,0.12)]"
                : "bg-[#2e2f2f] text-white/60 hover:bg-[#3a3b3b] hover:text-white ring-1 ring-emerald-400/30 animate-pulse"
            }`}
            onClick={() => setShortcutMenuOpen(!shortcutMenuOpen)}
            title="Shortcuts"
          >
            <MdFlashOn className="w-5 h-5" />
          </button>
          {shortcutMenuOpen && (
            <div
              ref={shortcutContainerRef}
              className="absolute bottom-full left-12 z-50 mb-2 w-64 overflow-hidden rounded-2xl bg-[#2e2f2f] p-1 shadow-2xl ring-1 ring-white/10"
            >
              <div className="px-3 py-2 text-[11px] font-bold uppercase tracking-wider text-white/30">
                AI Shortcuts
              </div>
              <div className="max-h-64 overflow-y-auto">
                {shortcuts.map((shortcut, idx) => (
                  <button
                    key={idx}
                    type="button"
                    className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm text-white/90 transition hover:bg-white/5 first:rounded-t-xl last:rounded-b-xl"
                    onClick={() => handleShortcutClick(shortcut.message)}
                  >
                    <span className="text-lg">{shortcut.icon}</span>
                    <span className="flex-1 font-medium">{shortcut.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <button
            type="button"
            ref={aiTriggerRef}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition ${
              aiMenuOpen
                ? "bg-emerald-500 text-white ring-2 ring-emerald-300/70 shadow-[0_0_0_8px_rgba(23,163,70,0.18)]"
                : "bg-orange-500 text-white hover:bg-orange-600 ring-1 ring-orange-300/30"
            }`}
            onClick={() => setAiMenuOpen(!aiMenuOpen)}
            title="AI Provider settings"
          >
            <MdSmartToy className="w-5 h-5" />
          </button>
          {aiMenuOpen && (
            <div
              ref={aiContainerRef}
              className="absolute bottom-full left-20 z-50 mb-2 w-72 overflow-hidden rounded-2xl bg-[#2e2f2f] p-3 shadow-2xl ring-1 ring-white/10"
            >
              <div className="px-2 pb-2 text-[11px] font-bold uppercase tracking-wider text-white/30">
                AI Provider & Model
              </div>

              {aiProvidersLoading ? (
                <div className="rounded-2xl bg-[#161717] px-4 py-4 text-center text-sm text-white/50">
                  Loading providers...
                </div>
              ) : aiProviders.length === 0 ? (
                <div className="rounded-2xl bg-[#161717] px-4 py-4 text-sm text-white/60">
                  No AI providers configured. Open settings to add one.
                </div>
              ) : (
                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs uppercase tracking-[0.22em] text-white/40">
                      Provider
                    </label>
                    <select
                      className="w-full rounded-[14px] bg-[#161717] px-3 py-2 text-sm text-white outline-none"
                      value={selectedAiProviderId}
                      onChange={(event) =>
                        handleAiProviderChange(event.target.value)
                      }
                    >
                      <option value="">Select provider</option>
                      {aiProviders.map((provider) => (
                        <option key={provider.id} value={provider.id}>
                          {provider.name} ({provider.provider})
                        </option>
                      ))}
                    </select>
                  </div>

                  {selectedAiProviderId ? (
                    <div>
                      <label className="mb-1 block text-xs uppercase tracking-[0.22em] text-white/40">
                        Model
                      </label>
                      {modelsMap[selectedAiProviderId]?.length ? (
                        <>
                          <select
                            className="w-full rounded-[14px] bg-[#161717] px-3 py-2 text-sm text-white outline-none"
                            value={selectedAiModel}
                            onChange={(event) =>
                              handleAiModelChange(event.target.value)
                            }
                          >
                            <option value="">Select model</option>
                            {modelsMap[selectedAiProviderId].map((model) => (
                              <option key={model.id} value={model.id}>
                                {model.name || model.id}
                              </option>
                            ))}
                            <option value="manual-model">Manual model</option>
                          </select>
                          {selectedAiModel === "manual-model" ? (
                            <input
                              className="mt-2 w-full rounded-[14px] bg-[#161717] px-3 py-2 text-sm text-white outline-none"
                              placeholder="Enter model id"
                              value={manualModelInput}
                              onChange={(event) =>
                                handleAiManualModelInput(event.target.value)
                              }
                            />
                          ) : null}
                        </>
                      ) : (
                        <input
                          className="w-full rounded-[14px] bg-[#161717] px-3 py-2 text-sm text-white outline-none"
                          placeholder="Enter model id"
                          value={manualModelInput}
                          onChange={(event) =>
                            handleAiManualModelInput(event.target.value)
                          }
                        />
                      )}
                    </div>
                  ) : null}

                  <button
                    type="button"
                    className="w-full rounded-[14px] bg-brand-500 px-4 py-2 text-sm font-semibold text-[#10251a] transition hover:bg-brand-600 disabled:opacity-60"
                    onClick={handleSaveAiSelection}
                    disabled={!selectedAiProviderId || savingAiSelection}
                  >
                    {savingAiSelection ? "Saving..." : "Set AI provider"}
                  </button>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-1 items-center rounded-[22px] bg-[#2e2f2f] px-4 py-2">
            <textarea
              ref={composerRef}
              rows={1}
              className="min-h-[20px] w-full resize-none overflow-y-auto border-none bg-transparent px-1 py-0.5 text-sm leading-5 text-white outline-none placeholder:text-white/30 disabled:opacity-60"
              placeholder="Type a message"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                onTyping(Boolean(event.target.value));
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (!busy && !uploading) {
                    void submitComposer();
                  }
                }
              }}
              disabled={busy || uploading}
            />
          </div>
          <button
            type="submit"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-brand-500 text-sm font-semibold leading-none text-[#10251a] transition hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={busy || uploading}
          >
            {busy || uploading ? (
              <SendButtonSpinner />
            ) : (
              <MdSend className="w-5 h-5" />
            )}
          </button>
        </div>
      </form>
      {selectedMediaModal && (
        <MediaPreviewModal
          media={selectedMediaModal}
          onClose={() => setSelectedMediaModal(null)}
        />
      )}
    </section>
  );
});
