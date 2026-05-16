import { MdInfo } from "react-icons/md";
import { FaTelegramPlane, FaWhatsapp } from "react-icons/fa";

export function getChatChannel(chat) {
  const transportType = String(chat?.transportType || "").toLowerCase();
  if (transportType === "telegram" || transportType === "whatsapp") {
    return transportType;
  }

  const externalId = String(chat?.contact?.externalId || "").toLowerCase();
  if (externalId.startsWith("tg:")) return "telegram";
  if (externalId.endsWith("@c.us") || externalId.endsWith("@g.us")) {
    return "whatsapp";
  }

  return "unknown";
}

export function getChatChannelLabel(chat) {
  const channel = getChatChannel(chat);
  if (channel === "telegram") return "Telegram";
  if (channel === "whatsapp") return "WhatsApp";
  return "Unknown";
}

export function ChatChannelBadge({ chat, compact = false }) {
  const channel = getChatChannel(chat);
  const config =
    channel === "telegram"
      ? {
          label: "Telegram",
          Icon: FaTelegramPlane,
          className: "bg-sky-500/15 text-sky-100",
        }
      : channel === "whatsapp"
        ? {
            label: "WhatsApp",
            Icon: FaWhatsapp,
            className: "bg-emerald-500/15 text-emerald-100",
          }
        : {
            label: "Unknown",
            Icon: MdInfo,
            className: "bg-white/8 text-white/45",
          };
  const Icon = config.Icon;

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full font-semibold ${config.className} ${
        compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-1 text-[11px]"
      }`}
      title={config.label}
    >
      <Icon className={compact ? "text-[11px]" : "text-xs"} />
      {compact ? null : config.label}
    </span>
  );
}
