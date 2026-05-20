# TOOLS.md

This file documents tools and skills available to the Wanie Assistant.

Purpose: provide a human-readable registry of available assistant tools and examples. The system may append entries here for externally-registered tools (append-only).

Default skills

- `add_device` — Create a new WhatsApp session/device for the user.
- `add_llm_provider` — Add an LLM provider (OpenAI / Anthropic / Ollama / OpenRouter).
- `update_assistant` — Change assistant display name, avatar, or persona.
- `create_api_key` — Generate an API key for the user.
- `update_webhook` — Set incoming webhook URL and key.
- `setup_gateway_integration` — Configure Wanie as an API gateway for an external CRM/ERP/app by setting webhook URL/key, optionally creating an API key, and turning internal CRM automation off.
- `update_tools_md` — Append or update human-readable entries in this file when new external tools are registered.
- `setup_telegram_bot` — Set up a Telegram bot with a BotFather token so Wanie can be remotely controlled via Telegram.
- `configure_telegram_admins` — Save authorized Telegram chat IDs to restrict which Telegram users may control Wanie.
- `reset_password` — Initiate a password reset flow for the current Wanie user via agent or Telegram chat. The assistant will ask for a new password and then reset it only for the user owning the bot/chat.
- `cancel_reset` — Cancel an in-progress password reset flow.
- `get_telegram_bot_status` — Check whether the Telegram bot is currently configured and running.
- `get_webpage` — Fetch and read the content of a URL (static or dynamic).
- `open_browser` — Open a browser to read a URL, useful for JavaScript-heavy sites.
- `list_workspaces` — List all project folders inside the global workspaces directory.
- `get_crm_auto_reply_settings` — Read CRM auto-reply settings, including assistant name, business name, persona, instruction/SOP, fallback message, automation mode, and retrieval settings.
- `update_crm_auto_reply_settings` — Update CRM auto-reply settings from chat, including persona and `agentInstructions`.
- `list_knowledge_base` — List CRM knowledge-base documents and indexing status.
- `get_knowledge_base_document` — Read an existing CRM knowledge-base document before editing.
- `search_knowledge_base` — Search CRM knowledge-base chunks and return the source chunks that would ground a reply.
- `test_knowledge_base_reply` — Test the CRM knowledge-aware reply for a question and return the draft answer plus source chunks.
- `add_knowledge_base` — Add a text or Markdown knowledge-base document from chat, then automatically chunk and index it.
- `update_knowledge_base` — Replace or append content in an existing knowledge-base document from chat, then automatically chunk and index it again.

Knowledge-base routing:
- Use `update_crm_auto_reply_settings` when the user asks to edit persona, instruction, SOP, fallback message, assistant name, business name, or behavior for CRM auto-reply/customer support replies.
- Use `update_assistant` only for the Wanie Assistant chat profile itself, not CRM customer auto-reply behavior.
- For CRM auto-reply edits, keep changes literal and narrow. Do not invent policies, prices, guarantees, workflows, tone rules, or business facts. Prefer find/replace when changing one phrase in `persona` or `agentInstructions`.
- Use `list_knowledge_base` when the user asks what CRM knowledge exists.
- Knowledge base can include image assets such as pricelist, QRIS, menu, catalog, or payment images. Image retrieval works best when the filename/title contains clear keywords, for example `qris-pembayaran.png` or `pricelist-paket-premium.png`.
- Use `get_knowledge_base_document` when the user asks to show, view, open, display, or lihat the data/content of a knowledge document.
- Use `test_knowledge_base_reply` when the user asks to check, test, simulate, preview, or kira-kira what the CRM AI reply would be from the knowledge base.
- If the tested reply is wrong, inspect the returned sources, read the source document, then update only the wrong sentence/section according to the user's correction. Prefer find/replace. Do not rewrite the full document unless the user explicitly asks.
- Use `add_knowledge_base` for new knowledge-base content from chat.
- Use `update_knowledge_base` for edits after identifying the target document.

Detailed examples for commonly-used tools

- `get_webpage` (get_webpage)

  Description: fetches the text content of a webpage. It first tries a fast fetch and falls back to a headless browser if needed.

  Example request:

  ```json
  { "url": "https://example.com" }
  ```

- `setup_telegram_bot` (setup_telegram_bot)

  Description: configures and starts the Telegram bot using a BotFather token, enabling remote Wanie control from Telegram chats.

  Example request:

  ```json
  {
    "token": "<telegram-bot-token>",
    "adminTelegramIds": ["123456789"]
  }
  ```

- `configure_telegram_admins` (configure_telegram_admins)

  Description: saves authorized Telegram chat IDs that are allowed to send commands to the Wanie Telegram bot.

  Example request:

  ```json
  {
    "adminTelegramIds": ["123456789", "987654321"]
  }
  ```

- `get_telegram_bot_status` (get_telegram_bot_status)

  Description: checks whether the Telegram bot is configured and whether it is currently running.

  Example request:

  ```json
  {}
  ```

- `reset_password` (reset_password)

  Description: initiates a password reset flow for the current Wanie user via agent or Telegram. The assistant should confirm the request and prompt the user to send the new password using `/new_password <password>`.

  Example usage in chat:

  ```text
  /reset_password
  ```

- `cancel_reset` (cancel_reset)

  Description: cancels an active password reset flow if the user changes their mind.

  Example usage in chat:

  ```text
  /cancel_reset
  ```

- `open_browser` (open_browser)

  Description: opens a headless browser (Playwright) to navigate to a URL and extract text content. Use this for complex sites or Single Page Applications (SPAs).

  Example request:

  ```json
  { "url": "https://huggingface.co/microsoft/bitnet-b1.58-2B-4T" }
  ```

- `run_terminal` (run_terminal)

  Description: request execution of a shell command on the host. Supports `approvalMode` (`auto` | `manual`) and returns execution results when completed.

  Example request:

  ```json
  {
    "command": "npm run build",
    "approvalMode": "manual",
    "cwd": "my-project-folder",
    "timeout": 120000
  }
  ```

  Note: `cwd` is relative to the global workspaces directory.

  Example response:

  ```json
  {
    "id": "term_abc123",
    "status": "done",
    "stdout": "Build succeeded...",
    "stderr": "",
    "exitCode": 0,
    "startedAt": "2026-03-31T12:00:00Z",
    "finishedAt": "2026-03-31T12:00:10Z"
  }
  ```

  Notes:
  - Auto-execution requires configuration of `WANIE_TERMINAL_ALLOWLIST` on the host.
  - Prefer `manual` approval for destructive or network-facing commands.

- `search_messages` (search_messages)

  Description: search messages and attachments in the user's message database.

  Example request:

  ```json
  { "q": "invoice", "chatId": "12345@c.us", "limit": 20 }
  ```

  Example response (truncated):

  ```json
  { "results": [{ "id": "m1", "chatId": "12345@c.us", "text": "Invoice attached", "media": [...] } ] }
  ```

- `run_code_agent` (run_code_agent)

  Description: invoke the local LLM-driven coding agent which plans and executes coding tasks inside the workspace. The agent uses the server-configured LLM via the internal orchestrator and tool-executor, and may create/modify files or run terminal commands as part of its plan.

  Example request:

  ```json
  { "prompt": "create api route nextjs create order", "cwd": "my-project" }
  ```

  Example response (structured):

  ```json
  { "ok": true, "result": { "success": true, "logs": { ... } } }
  ```

  Notes:
  - The coding agent does not depend on an external Copilot CLI; it uses the configured LLM provider.
  - All file operations and terminal commands are executed relative to the `workspaces/` directory.
  - Auto-execution of terminal steps depends on server settings (`WANIE_TERMINAL_ALLOWLIST` and user preferences). When the agent requests terminal execution it may set `trustedAuto: true` for convenience.

- Coding capabilities

  The assistant can act as a coding agent: create/modify files, scaffold routes, run linters/tests, and run CLI tools. Use coding tools responsibly and prefer manual approval for potentially destructive operations.

Auto-registered tools

When external tools are registered via the API (for example `POST /api/agent/register-tool-url`), the system appends a human-readable entry below. Appended entries follow this simple pattern:

```
### Tool: <Name> (<id>)
<short description>

Docs: <url>
Invoke: <http base | none>
```

Security / Admin

- `WANIE_TERMINAL_ALLOWLIST`: when set, only commands matching the allowlist are eligible for auto-execution.
- `approvalMode`: `auto` vs `manual`. Manual-mode terminal requests require human approval via the dashboard/UI.
- `invokeEnabled`: per-tool flag that controls if non-owner users may call a registered tool. By default, only the registering user (`addedBy`) may invoke the tool unless an admin enables `invokeEnabled`.
- Registration and review: use the dashboard or admin endpoints to register external tools, review their `docs`, and verify required auth (API keys) before allowing invocation.
- Best practices: require explicit admin approval for tools that perform state changes or network calls; keep invocation logs and audit trails.

If you want, I can also add a minimal frontend form to register a tool from a URL (calls `/api/agent/register-tool-url`) and a dashboard to toggle `invokeEnabled` for each tool.

Quick curl examples

- Register a tool by manifest URL (dashboard/admin only — requires a dashboard JWT):

```bash
curl -X POST 'http://localhost:3000/api/agent/register-tool-url' \
  -H 'Authorization: Bearer <DASHBOARD_JWT>' \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://example.com/manifest.json",
    "apiKey": "<MANIFEST_API_KEY>",
    "headerName": "Authorization",
    "overwrite": true
  }'
```

Replace `http://localhost:3000` with your Wanie server host and port.

- Invoke a registered tool (authenticated — user JWT or API key allowed):

Using user JWT:

```bash
curl -X POST 'http://localhost:3000/api/agent/invoke-tool/<tool_id>' \
  -H 'Authorization: Bearer <USER_JWT>' \
  -H 'Content-Type: application/json' \
  -d '{
    "method": "GET",
    "path": "/hello"
  }'
```

Using API key (header `X-API-Key` or `X-Wanie-API-Key`):

```bash
curl -X POST 'http://localhost:3000/api/agent/invoke-tool/<tool_id>' \
  -H 'X-API-Key: <API_KEY>' \
  -H 'Content-Type: application/json' \
  -d '{
    "method": "POST",
    "path": "/echo",
    "body": { "msg": "ping" }
  }'
```

Notes:

- Replace `<tool_id>`, `<USER_JWT>`, `<API_KEY>`, and host as appropriate.
- For dashboard actions (register), use a valid dashboard JWT (dashboard-only middleware). For regular invocations, either a user JWT or an API key is accepted.

PowerShell quoting note

- Issue: PowerShell parses single and double quotes differently than bash. Commands copied from bash examples that use nested single quotes can trigger errors like "The string is missing the terminator: '".
- Guidance: When running curl/HTTP examples in PowerShell, prefer:
  - Use double quotes for arguments and headers, and single quotes for JSON payloads when possible.
  - Or use PowerShell's `Invoke-RestMethod` / `Invoke-WebRequest` which avoids shell quoting pitfalls.

Examples (Bash):

```bash
curl -X POST 'http://localhost:3000/api/agent/register-tool-url' \
  -H 'Authorization: Bearer <DASHBOARD_JWT>' \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://example.com/manifest.json",
    "apiKey": "<MANIFEST_API_KEY>",
    "overwrite": true
  }'
```

PowerShell (recommended):

```powershell
curl -X POST "http://localhost:3000/api/agent/register-tool-url" `
  -H "Authorization: Bearer <DASHBOARD_JWT>" `
  -H "Content-Type: application/json" `
  -d '{"url":"https://example.com/manifest.json","apiKey":"<MANIFEST_API_KEY>","overwrite":true}'

# Or use Invoke-RestMethod for native PowerShell behavior:
Invoke-RestMethod -Method Post -Uri 'http://localhost:3000/api/agent/register-tool-url' -Headers @{"Authorization"="Bearer <DASHBOARD_JWT>";"Content-Type"="application/json"} -Body '{"url":"https://example.com/manifest.json","apiKey":"<MANIFEST_API_KEY>","overwrite":true}'
```
