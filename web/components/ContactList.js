import { BrandLogo } from "@/components/BrandLogo";
import { ChatChannelBadge } from "@/components/ChatChannelBadge";
import { ConversationsSkeletonList } from "@/components/Skeletons";
import { MdMoreVert } from "react-icons/md";
import { useState } from "react";
import { useEffect } from "react";

const wanieVersion =
  process.env.NEXT_PUBLIC_WANIE_VERSION ||
  process.env.NEXT_PUBLIC_OPENWA_VERSION ||
  "";

function formatTime(value) {
  if (!value) {
    return "";
  }

  return new Intl.DateTimeFormat("en-US", {
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

function Avatar({ src, label }) {
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

export function ContactList({
  chats,
  activeChatId,
  onSelectChat,
  currentUser,
  loading,
  query,
  onQueryChange,
  onTogglePin,
  onDeleteChat,
}) {
  const normalizedQuery = String(query || "")
    .trim()
    .toLowerCase();
  const [openMenuId, setOpenMenuId] = useState(null);
  const assistantChat = chats.find(
    (c) => c.contact && c.contact.externalId === "openwa:assistant",
  );

  useEffect(() => {
    function handleDocClick(e) {
      if (!openMenuId) return;
      try {
        const inButton = e.target.closest(`[data-menu-button="${openMenuId}"]`);
        const inMenu = e.target.closest(`[data-menu-id="${openMenuId}"]`);
        if (!inButton && !inMenu) setOpenMenuId(null);
      } catch (err) {
        // ignore malformed selectors
        setOpenMenuId(null);
      }
    }

    function handleEsc(e) {
      if (e.key === "Escape") setOpenMenuId(null);
    }

    document.addEventListener("mousedown", handleDocClick);
    document.addEventListener("touchstart", handleDocClick);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleDocClick);
      document.removeEventListener("touchstart", handleDocClick);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [openMenuId]);

  const filteredChats = chats
    .filter(
      (chat) => chat.contact && chat.contact.externalId !== "openwa:assistant",
    )
    .filter(
      (chat) =>
        !normalizedQuery ||
        [chat.contact.displayName, chat.contact.lastMessagePreview, chat.title]
          .filter(Boolean)
          .some((value) => value.toLowerCase().includes(normalizedQuery)),
    );

  return (
    <aside className="flex h-full w-[360px] shrink-0 flex-col bg-[#161717]">
      <div className="px-5 py-5">
        <div className="flex items-center justify-center">
          <div className="flex h-12 items-center gap-2">
            <BrandLogo variant="long" alt="Wanie" className="h-full" />
            {wanieVersion ? (
              <span className="rounded-full bg-white/5 px-2 py-1 text-[11px] font-semibold text-white/45">
                v{wanieVersion}
              </span>
            ) : null}
          </div>
        </div>

        <div className="mt-4 rounded-[22px] bg-[#2e2f2f] px-3 py-2">
          <input
            className="w-full border-none bg-transparent text-sm text-white outline-none placeholder:text-white/30"
            placeholder="Search conversation"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {loading ? <ConversationsSkeletonList /> : null}
        {!loading && filteredChats.length === 0 ? (
          <p className="px-3 py-4 text-sm leading-6 text-white/40">
            No synced conversations yet. Connect your device to load chats.
          </p>
        ) : null}

        <div className="space-y-2">
          {assistantChat ? (
            <div key={assistantChat.id} className="relative">
              <button
                type="button"
                className={
                  "flex w-full items-start gap-3 rounded-[16px] px-4 py-3 pr-12 text-left transition " +
                  (assistantChat.id === activeChatId
                    ? "bg-[#2e2f2f]"
                    : "bg-transparent hover:bg-white/[0.05]")
                }
                onClick={() => onSelectChat(assistantChat.id)}
              >
                <Avatar
                  src={assistantChat.contact.avatarUrl}
                  label={assistantChat.contact.displayName}
                />
                <div className="min-w-0 flex-1">
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3">
                    <h3 className="min-w-0 truncate font-medium text-white">
                      {assistantChat.contact.displayName}
                    </h3>
                    <div className="w-[62px] shrink-0 text-right">
                      <span className="block truncate text-[11px] text-white/35">
                        {/* show last message time if any */}
                        {assistantChat.contact.lastMessageAt ||
                        assistantChat.updatedAt
                          ? new Intl.DateTimeFormat("en-US", {
                              hour: "2-digit",
                              minute: "2-digit",
                            }).format(
                              new Date(
                                assistantChat.contact.lastMessageAt ||
                                  assistantChat.updatedAt,
                              ),
                            )
                          : ""}
                      </span>
                    </div>
                    <p className="mt-1 min-w-0 truncate text-sm text-white/42">
                      {assistantChat.contact.persona
                        ? assistantChat.contact.persona
                        : assistantChat.contact.lastMessagePreview ||
                          "No messages yet"}
                    </p>
                    <div className="mt-1 w-[62px] shrink-0" />
                  </div>
                </div>
              </button>

              <div className="absolute right-2 top-3 flex items-start gap-1">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenMenuId(
                      openMenuId === assistantChat.id ? null : assistantChat.id,
                    );
                  }}
                  data-menu-button={assistantChat.id}
                  className="text-white/40 hover:text-white/70"
                  aria-label="Open chat menu"
                >
                  <MdMoreVert className="w-5 h-5" />
                </button>

                {openMenuId === assistantChat.id ? (
                  <div
                    data-menu-id={assistantChat.id}
                    className="absolute right-0 z-50 mt-2 w-40 rounded-md bg-[#0b141a] border border-white/6 p-1 shadow-lg"
                  >
                    <button
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm text-white hover:bg-white/[0.03]"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (typeof onTogglePin === "function")
                          onTogglePin(
                            assistantChat.id,
                            !!assistantChat.pinnedAt,
                          );
                        setOpenMenuId(null);
                      }}
                    >
                      {assistantChat.pinnedAt ? "Unpin" : "Pin"}
                    </button>
                    <button
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-white/[0.03]"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!confirm("Delete this conversation?")) {
                          setOpenMenuId(null);
                          return;
                        }
                        if (typeof onDeleteChat === "function")
                          onDeleteChat(assistantChat.id);
                        setOpenMenuId(null);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
          {filteredChats.map((chat) => (
            <div key={chat.id} className="relative">
              <button
                type="button"
                className={
                  "flex w-full items-start gap-3 rounded-[16px] px-4 py-3 pr-12 text-left transition " +
                  (chat.id === activeChatId
                    ? "bg-[#2e2f2f]"
                    : "bg-transparent hover:bg-white/[0.05]")
                }
                onClick={() => onSelectChat(chat.id)}
              >
                <Avatar
                  src={chat.contact.avatarUrl}
                  label={chat.contact.displayName}
                />
                <div className="min-w-0 flex-1">
                  <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <h3 className="min-w-0 truncate font-medium text-white">
                        {chat.contact.displayName}
                      </h3>
                      <ChatChannelBadge chat={chat} compact />
                    </div>
                    <div className="flex w-[76px] shrink-0 items-center justify-end gap-2">
                      <span className="block min-w-0 truncate text-[11px] text-white/35">
                        {formatTime(
                          chat.contact.lastMessageAt || chat.updatedAt,
                        )}
                      </span>
                    </div>
                    <p className="mt-1 min-w-0 truncate text-sm text-white/42">
                      {chat.contact.lastMessagePreview || "No messages yet"}
                    </p>
                    <div className="mt-1 flex w-[76px] shrink-0 justify-end">
                      {chat.contact.unreadCount ? (
                        <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-500 px-1.5 text-[11px] font-bold text-[#10251a]">
                          {chat.contact.unreadCount}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              </button>

              <div className="absolute right-2 top-3 flex items-start gap-1">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenMenuId(openMenuId === chat.id ? null : chat.id);
                  }}
                  data-menu-button={chat.id}
                  className="text-white/40 hover:text-white/70"
                  aria-label="Open chat menu"
                >
                  <MdMoreVert className="w-5 h-5" />
                </button>

                {openMenuId === chat.id ? (
                  <div
                    data-menu-id={chat.id}
                    className="absolute right-0 z-50 mt-2 w-40 rounded-md bg-[#0b141a] border border-white/6 p-1 shadow-lg"
                  >
                    <button
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm text-white hover:bg-white/[0.03]"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (typeof onTogglePin === "function")
                          onTogglePin(chat.id, !!chat.pinnedAt);
                        setOpenMenuId(null);
                      }}
                    >
                      {chat.pinnedAt ? "Unpin" : "Pin"}
                    </button>
                    <button
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm text-red-400 hover:bg-white/[0.03]"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!confirm("Delete this conversation?")) {
                          setOpenMenuId(null);
                          return;
                        }
                        if (typeof onDeleteChat === "function")
                          onDeleteChat(chat.id);
                        setOpenMenuId(null);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
