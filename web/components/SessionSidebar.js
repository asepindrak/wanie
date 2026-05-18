import { BrandLogo } from "@/components/BrandLogo";

function SessionStatusBadge({ status }) {
  const colors = {
    ready: "bg-brand-500/15 text-brand-100 ring-1 ring-brand-400/20",
    connecting: "bg-amber-500/15 text-amber-100 ring-1 ring-amber-400/20",
    disconnected: "bg-white/8 text-white/60 ring-1 ring-white/10",
    error: "bg-red-500/15 text-red-100 ring-1 ring-red-400/20"
  };

  return (
    <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium capitalize tracking-[0.08em] ${colors[status] || colors.disconnected}`}>
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
  return <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#202c33] text-sm font-semibold text-white">{initials(label)}</div>;
}

function formatHealthTime(value) {
  if (!value) return "Never";
  return new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function SessionSidebar({
  sessions,
  activeSessionId,
  onSelect,
  onConnect,
  onDisconnect,
  sessionName,
  sessionPhone,
  onSessionNameChange,
  onSessionPhoneChange,
  onCreateSession
}) {
  const activeSession = sessions.find((session) => session.id === activeSessionId) || sessions[0] || null;

  return (
    <aside className="flex w-[330px] shrink-0 flex-col border-r border-white/6 bg-[#0b141a]">
      <div className="border-b border-white/6 px-5 py-5">
        <p className="text-[11px] uppercase tracking-[0.28em] text-brand-100/60">Workspace</p>
        <div className="mt-3 flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white p-2 shadow-[0_16px_40px_rgba(0,0,0,0.18)]">
            <BrandLogo variant="square" alt="OpenWA" className="h-full w-full rounded-xl" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-white">OpenWA Devices</h2>
            <p className="text-sm text-white/45">Manage multiple numbers in one dashboard.</p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="space-y-2.5">
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              className={`w-full rounded-[26px] border px-4 py-3.5 text-left transition ${
                session.id === activeSessionId
                  ? "border-brand-500/40 bg-brand-500/10 shadow-panel"
                  : "border-white/6 bg-white/[0.03] hover:border-white/12 hover:bg-white/[0.05]"
              }`}
              onClick={() => onSelect(session.id)}
            >
              <div className="flex items-start gap-3">
                <SessionAvatar label={session.name} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="truncate font-medium text-white">{session.name}</h3>
                    <SessionStatusBadge status={session.status} />
                  </div>
                  <p className="mt-1 truncate text-sm text-white/45">{session.phoneNumber || "Number will appear after device connects"}</p>
                </div>
              </div>
            </button>
          ))}

          {sessions.length === 0 ? (
            <div className="rounded-[26px] border border-dashed border-white/10 bg-white/[0.03] px-4 py-7 text-sm leading-6 text-white/45">
              No active sessions. Add a new device to start building your OpenWA workspace.
            </div>
          ) : null}
        </div>
      </div>

      <div className="border-t border-white/6 px-5 py-5">
        {activeSession ? (
          <div className="mb-4 rounded-[28px] border border-white/8 bg-gradient-to-b from-white/[0.06] to-white/[0.03] p-4 shadow-panel">
             <div className="mb-4 flex items-center justify-between gap-3">
               <div>
                 <h3 className="font-semibold text-white">{activeSession.name}</h3>
                 <p className="text-sm text-white/45">{activeSession.phoneNumber || "Waiting for WhatsApp pairing"}</p>
                 <p className="mt-1 text-xs uppercase tracking-[0.18em] text-white/30">
                   Transport: {activeSession.transportType === "mock" ? "Mock" : activeSession.transportType === "whatsapp_cloud" ? "WhatsApp Official API" : "WhatsApp Web"}
                 </p>
                 <p className="mt-1 text-xs text-white/35">
                   Health: {formatHealthTime(activeSession.lastHealthCheckAt)}
                   {activeSession.reconnectAttempts
                     ? ` · reconnect #${activeSession.reconnectAttempts}`
                     : ""}
                 </p>
               </div>
               <SessionStatusBadge status={activeSession.status} />
             </div>

            {activeSession.qrCode ? (
              <div className="rounded-[24px] bg-white p-3">
                <img src={activeSession.qrCode} alt="QR Code" className="mx-auto h-64 w-64 rounded-2xl" />
              </div>
             ) : (
               <div className="rounded-[24px] border border-dashed border-white/10 bg-[#111b21] px-4 py-10 text-center text-sm leading-6 text-white/45">
                 QR code will appear here when session starts pairing.
               </div>
             )}

             {activeSession.lastError ? (
               <div className="mt-3 rounded-2xl border border-red-400/20 bg-red-500/10 px-3 py-2.5 text-sm leading-6 text-red-100">
                 {activeSession.lastError}
               </div>
             ) : null}

             <div className="mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                className="rounded-2xl bg-brand-500 px-4 py-3 text-sm font-semibold text-[#10251a] transition hover:bg-brand-600"
                onClick={() => onConnect(activeSession.id)}
              >
                Connect
              </button>
              <button
                type="button"
                className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm font-medium text-white/80 transition hover:bg-white/[0.06]"
                onClick={() => onDisconnect(activeSession.id)}
              >
                Disconnect
              </button>
            </div>
          </div>
        ) : null}

        <form className="space-y-3" onSubmit={onCreateSession}>
          <div>
            <p className="mb-2 text-[11px] uppercase tracking-[0.26em] text-white/35">Add device</p>
            <input
              className="w-full rounded-2xl border border-white/10 bg-[#202c33] px-4 py-3 text-sm text-white outline-none transition placeholder:text-white/30 focus:border-brand-500"
              placeholder="Session name, e.g. Sales Team"
              value={sessionName}
              onChange={(event) => onSessionNameChange(event.target.value)}
              required
            />
          </div>
          <input
            className="w-full rounded-2xl border border-white/10 bg-[#202c33] px-4 py-3 text-sm text-white outline-none transition placeholder:text-white/30 focus:border-brand-500"
            placeholder="Nomor WhatsApp (opsional)"
            value={sessionPhone}
            onChange={(event) => onSessionPhoneChange(event.target.value)}
          />
          <button type="submit" className="w-full rounded-2xl border border-brand-500/30 bg-brand-500/10 px-4 py-3 text-sm font-semibold text-brand-100 transition hover:bg-brand-500/20">
            Add WhatsApp Session
          </button>
        </form>
      </div>
    </aside>
  );
}
