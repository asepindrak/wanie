# PROJECT PROMPT -- WANIE (CLI + NPM PACKAGE + WHATSAPP WEB CLONE)

## ROLE

You are a senior full-stack engineer and Node.js package maintainer.

Your task is to build a **self-hosted WhatsApp Web clone platform**
using **whatsapp-web.js**, where the **frontend and backend are bundled
into a single npm package** that can be installed globally and executed
using a CLI command.

This is NOT a simple web app.\
This must be a **production-ready CLI tool that launches a web
dashboard**.

------------------------------------------------------------------------

# FINAL GOAL

User installs the package globally:

``` bash
npm i -g @adens/wanie
```

Then runs:

``` bash
wanie
```

After that:

-   Express server starts automatically
-   Socket.IO starts automatically
-   WhatsApp session manager starts automatically
-   Web dashboard opens automatically in browser
-   User sees a WhatsApp Web-like interface
-   User can connect multiple WhatsApp numbers
-   Supports multiple users (multi login inside web app)

------------------------------------------------------------------------

# CORE CONCEPT

The system must behave like these tools:

-   n8n
-   Directus
-   Supabase CLI (local mode)
-   Ollama

Meaning:

-   Installed once via npm
-   Runs locally
-   Opens a web app at `http://localhost:PORT`
-   Everything works using ONE command

------------------------------------------------------------------------

# TECH STACK

## Backend

-   Node.js
-   Express.js
-   whatsapp-web.js (latest stable)
-   Socket.IO
-   Prisma ORM
-   SQLite (must work without PostgreSQL)
-   Multer (for media upload)
-   File-based session storage

DO NOT USE: - Redis - Docker - External cloud services - External
database

Everything must work locally after install.

------------------------------------------------------------------------

## Frontend

-   Next.js (must be bundled inside the npm package)
-   TailwindCSS
-   Zustand (state manager)
-   Socket.IO client

------------------------------------------------------------------------

# MAIN FEATURES

## 1. CLI COMMAND

The package must expose this command:

``` bash
wanie
```

When executed it must:

1.  Check if database exists
2.  Run Prisma migration automatically
3.  Create required folders automatically
4.  Start Express server
5.  Start Socket.IO
6.  Start WhatsApp session manager
7.  Open browser automatically
8.  Show URL in terminal

Example terminal output:

``` bash
Wanie is running 🚀

Dashboard: http://localhost:3000
WhatsApp Sessions: ready
Socket: connected
Database: connected
```

------------------------------------------------------------------------

## 2. MULTI USER SYSTEM

The web app must support:

-   Register
-   Login
-   Logout
-   Multiple users
-   Each user can connect multiple WhatsApp numbers
-   Each WhatsApp number must run as a separate session

------------------------------------------------------------------------

## 3. MULTI WHATSAPP DEVICE SUPPORT

Each user must be able to:

-   Add new WhatsApp number
-   Generate QR code
-   Connect device
-   Reconnect automatically
-   See connection status

Session statuses:

-   connecting
-   ready
-   disconnected
-   error

------------------------------------------------------------------------

## 4. WHATSAPP WEB CLONE UI

The UI must be very similar to WhatsApp Web.

### LEFT PANEL (Contact List)

Must include:

-   Profile picture
-   Contact name
-   Last message preview
-   Timestamp
-   Unread message badge
-   Contact search
-   Scrollable contact list

------------------------------------------------------------------------

### RIGHT PANEL (Chat Area)

Must include:

-   Chat header (profile photo + name)
-   Message bubbles (left and right)
-   Message timestamp
-   Delivered / read status
-   Typing indicator
-   Scroll to load old messages
-   Media preview inside chat

------------------------------------------------------------------------

## 5. MEDIA SUPPORT

User must be able to send:

-   Image
-   Video
-   Audio
-   Document (PDF, DOCX, ZIP, etc)
-   Sticker

Media must:

-   Upload to server
-   Stored in local storage
-   Saved in database
-   Sent using MessageMedia

------------------------------------------------------------------------

## 6. IMPORTANT CHAT FEATURES

Add these features:

-   Reply message
-   Delete message
-   Forward message
-   Chat search
-   Emoji support
-   Typing indicator
-   Unread message counter
-   Real-time contact list update

------------------------------------------------------------------------

# PROJECT STRUCTURE (IMPORTANT)

This project must be built as a **single npm package**, not a monorepo.

Use this structure:

    wanie/
    │
    ├── bin/
    │   └── openwa.js         (legacy CLI entry file; exposes `wanie`)
    │
    ├── server/
    │   ├── express/
    │   ├── whatsapp/
    │   ├── socket/
    │   ├── services/
    │   ├── database/
    │   └── utils/
    │
    ├── web/
    │   ├── nextjs app
    │   ├── components/
    │   ├── chat/
    │   ├── contacts/
    │   └── store/
    │
    ├── storage/
    │   ├── sessions/
    │   ├── media/
    │   └── database/
    │
    ├── prisma/
    │   └── schema.prisma
    │
    └── package.json

------------------------------------------------------------------------

# DATABASE REQUIREMENTS

Use Prisma + SQLite.

Create these tables:

-   users
-   whatsapp_sessions
-   contacts
-   chats
-   messages
-   media_files
-   message_status

Each message must store:

-   message_id
-   sender
-   receiver
-   timestamp
-   type (text, image, video, audio, document, sticker)
-   status (sent, delivered, read)

------------------------------------------------------------------------

# SOCKET EVENTS

### Client → Server

-   send_message
-   send_media
-   typing
-   open_chat

### Server → Client

-   new_message
-   message_status_update
-   contact_list_update
-   session_status_update
-   typing_event

------------------------------------------------------------------------

# REQUIRED BEHAVIOR

The system must work like this:

``` bash
npm i -g @adens/wanie
wanie
```

And it must:

-   Work without manual configuration
-   Automatically create folders
-   Automatically create database
-   Automatically open browser
-   Automatically start all services

------------------------------------------------------------------------

# OUTPUT REQUIREMENTS

Now generate:

1.  Full project architecture
2.  CLI architecture design
3.  WhatsApp session manager design
4.  Database schema (Prisma)
5.  Backend folder structure
6.  Frontend folder structure
7.  Socket architecture
8.  Step-by-step development plan
9.  Then start generating code step by step
