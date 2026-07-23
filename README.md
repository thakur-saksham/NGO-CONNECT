# NGOConnect AI

A mobile-first, installable PWA for small NGOs to manage volunteers, events, and impact — with **Nova**, an AI copilot for donor emails, social posts, and impact reports. A real full-stack app: Node/Express + SQLite backend, no external database service required, with live real-time sync across every connected device.

![status](https://img.shields.io/badge/status-working-34d399) ![license](https://img.shields.io/badge/license-MIT-5b4fe0)

## Features

- 🔐 Real accounts — signup/signin with hashed passwords and session tokens
- 🏢 Multi-tenant orgs — each NGO gets a unique org code; colleagues join with an admin-issued invite code (or a shareable invite link) and get their own login
- 🙋 Self-serve volunteer applications — anyone with the public org code can apply to join as a Volunteer; an Admin/Manager reviews and approves (or rejects) from a banner right on Home
- 👥 Role-based permissions — Admin / Manager / Volunteer Coordinator / **Volunteer**, enforced server-side (not just hidden buttons); Admins can change anyone's role, Managers can promote/demote everyone except Admins
- ⚡ Real-time sync — Server-Sent Events push live updates (new tasks, messages, approvals, donations, etc.) to every connected device with no polling and no manual refresh
- 💬 Team messaging — direct messages and group conversations between colleagues, with live delivery and unread badges
- 👤 Profile — edit name/phone/bio/avatar photo, change password, dark/light mode toggle
- 📅 Calendar view — monthly grid with dots on days that have events, tap a day to see what's on
- ✅ Task management — priority (low/normal/high/urgent), deadlines, notes, and file attachments; a 4-stage workflow (Pending → Accepted → In Progress → Completed) doubles as an in-app notification to the assignee, visible under Volunteers → Tasks
- 🕒 Attendance — volunteer check-in/check-out with an auto-generated hours report, under Volunteers → Attendance
- 🎖️ Volunteer badges — auto-awarded (50 Hours, Top Volunteer, Event Leader) based on real activity, no manual work
- ⭐ Favorite volunteers — Admins can star important volunteers
- 🚑 Emergency & safety info — emergency contact, blood group, medical notes, birthday per volunteer
- 🎂 Birthdays — today's birthdays surface right on the Home screen
- 📢 Announcements — Admin posts, everyone gets notified and sees it on Home
- 💬 Comments & ⭐ feedback — per-event discussion thread and star ratings
- 🖼️ Event gallery — crowd-sourced photo gallery per event, plus an optional video link
- 📌 Pinned event — Admin pins one event to the top of the list
- 📍 Google Maps — every event links straight to Maps for its location
- 🎯 NGO Goals — track non-monetary goals ("Plant 500 Trees") with progress bars, alongside the fundraising goal
- 💰 Fundraising tracker — any teammate logs donations by donor/campaign; shared dashboard with goal progress, with a one-time celebration notification when a goal is crossed
- 🔔 Notification Center — real per-user notifications (tasks, approvals, role changes, goals, announcements) with an unread badge on Home, mark-all-read
- 📜 Full activity log — every action across the org, searchable in Settings
- 🔍 Advanced filters — search + skill/role filter + Favorites-only toggle on the volunteer directory
- 📤 CSV export — volunteers, donations, and attendance, opens directly in Excel/Sheets
- 🗄️ Real database — SQLite via Node's built-in `node:sqlite` (zero native builds, zero external services)
- 📊 Home dashboard — live impact stats, quick actions, activity feed, upcoming events
- 🙋 Volunteer directory — search, filter, detail pages with skills & timeline; native-feeling bottom-sheet picker instead of a clunky HTML `<select>`
- 🤖 **Nova AI** — chat copilot proxied through your own server (API key never touches the browser) using Google's Gemini API, aware of your org's real data, with a templated offline reply if no key is configured
- 📱 Installable PWA — glass-effect nav bar, add to home screen on iOS/Android, offline app-shell caching
- 🧠 Graceful offline fallback — if no backend is reachable (e.g. previewing the raw HTML file), the app runs a fully-working local demo mode instead of breaking

### Simplified or deferred (be aware)
- **Documents** (permission letters/sponsorship PDFs) and **video uploads** aren't implemented — event galleries take photos, and videos are a pasted link (YouTube/Vimeo/etc.) rather than an upload, to avoid bloating the SQLite file with large binaries. Task file attachments are supported but capped at a few MB (also stored as base64 in SQLite).
- **Export** covers CSV only (opens fine in Excel/Sheets/Numbers) — true `.xlsx`/PDF generation isn't included.
- **Charts** — the Fundraising summary includes weekly totals in the API (`fundraising.weekly`) for a chart, but no chart is drawn on screen yet; wire it up with any small charting lib if you want the visual.
- **Group conversations** can be created via the API but the UI currently only exposes starting 1:1 direct messages from the New Message picker.

## Requirements

- **Node.js ≥ 22.5** (uses the built-in `node:sqlite` module — no native compilation, no separate database to install)

## Quick start

```bash
git clone https://github.com/<you>/ngoconnect-ai.git
cd ngoconnect-ai
npm install
cp .env.example .env      # then edit .env — see below
npm start
```

Open `http://localhost:3000` — or open it on your phone (same Wi-Fi, use your computer's LAN IP) and "Add to Home Screen" to install it like a real app.

### Configure `.env`

```ini
GEMINI_API_KEY=            # optional — leave blank for templated Nova replies
GEMINI_MODEL=gemini-2.5-flash
JWT_SECRET=some-long-random-string   # required for real deployments
PORT=3000
DB_PATH=./data.sqlite
SEED_DEMO_DATA=true        # false = new orgs start empty, no sample volunteers/events
```

Get a Gemini key at **https://aistudio.google.com/apikey**. Generate a strong `JWT_SECRET` with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## How it works

```
┌──────────────┐   REST (JSON) + SSE  ┌──────────────┐     SQL      ┌──────────────┐
│  index.html  │ ──────────────────► │  server.js   │ ───────────► │ data.sqlite  │
│  (frontend)  │ ◄────────────────── │  (Express)   │ ◄─────────── │ (node:sqlite)│
└──────────────┘  live push updates   └──────┬───────┘              └──────────────┘
                                              │
                                              ▼
                                     Google Gemini API
                                     (server-side only, via
                                      /api/nova/chat proxy)
```

One process serves both the static frontend (`public/`) and the JSON API, so there's no CORS to configure and only one command to run. The frontend also opens a Server-Sent Events connection (`/api/stream`) after signing in, so new tasks, messages, approvals, and other changes appear instantly on every connected device — no polling, no manual refresh. The frontend pings `/api/health` on load: if a server answers, it runs in full online mode (real signup/login/data); if not (e.g. you open `index.html` directly as a file, or preview it somewhere without the backend), it transparently falls back to an in-memory/localStorage demo mode so the UI is never broken.

## Project structure

```
├── server.js              # Express app — static files + REST API
├── db.js                   # SQLite schema, queries, demo-data seeding
├── auth.js                 # password hashing (scrypt) + session tokens (HMAC)
├── package.json
├── .env.example
└── public/
    ├── index.html           # the entire frontend (markup, styles, logic)
    ├── manifest.json        # PWA manifest
    ├── sw.js                # service worker — offline app-shell caching
    ├── icon-192.png / icon-512.png / apple-touch-icon.png
```

## Roles & permissions

| Action | Admin | Manager | Coordinator | Volunteer |
|---|---|---|---|---|
| View everything (volunteers, events, funds) | ✓ | ✓ | ✓ | ✓ |
| Add volunteers, log hours | ✓ | ✓ | ✓ | ✓ |
| Log donations | ✓ | ✓ | ✓ | ✓ |
| Accept/progress/complete assigned tasks | ✓ | ✓ | ✓ | ✓ |
| Create/edit events, change event cover photo | ✓ | ✓ | ✗ | ✗ |
| Invite colleagues | ✓ | ✗ | ✗ | ✗ |
| Approve/reject volunteer applications | ✓ | ✓ | ✗ | ✗ |
| Change a colleague's role | ✓ (anyone) | ✓ (not Admins) | ✗ | ✗ |
| Set fundraising goal / org settings | ✓ | ✗ | ✗ | ✗ |

Enforced server-side in `auth.js`'s `requireRole()` middleware and in `db.js`'s `updateUserRole()` (which blocks Managers from touching Admins or granting the Admin role) — hiding buttons in the UI is just politeness, not the security boundary.

## API reference

All routes except `/api/health` and `/api/auth/*` require `Authorization: Bearer <token>`. `/api/stream` (SSE) takes the token as a `?token=` query param instead, since `EventSource` can't send custom headers.

| Method | Path | Role | Body | Description |
|---|---|---|---|---|
| GET | `/api/health` | – | – | Used by the frontend to detect a live backend |
| POST | `/api/auth/signup` | – | `{name, orgName, email, password}` | Creates a **new** org (you become Admin), returns token + bootstrap |
| POST | `/api/auth/join` | – | `{inviteCode, name, email, password}` | Joins an **existing** org using an admin-issued invite code (active immediately) |
| POST | `/api/auth/apply` | – | `{orgCode, name, email, password}` | Self-serve application to join as a Volunteer using the public org code (status: pending until approved) |
| POST | `/api/auth/signin` | – | `{email, password}` | Returns token + bootstrap |
| GET | `/api/bootstrap` | any | – | Re-fetches everything (used for auto-login and after real-time updates) |
| GET | `/api/stream` | any (via `?token=`) | – | Server-Sent Events stream: `update`, `notification`, `message`, `status-change` events |
| GET | `/api/approvals` | admin/manager | – | Lists pending volunteer applications |
| POST | `/api/approvals/:userId/approve` | admin/manager | `{role?}` | Approves an application (defaults to the role they applied for) |
| POST | `/api/approvals/:userId/reject` | admin/manager | – | Rejects and deletes the application |
| PATCH | `/api/colleagues/:id/role` | admin/manager | `{role}` | Changes a colleague's role (Managers can't touch/grant Admin) |
| PATCH | `/api/org` | admin | `{name?, fundraisingGoal?}` | Updates org name / fundraising goal |
| GET | `/api/colleagues` | any | – | Lists active teammates and their roles |
| GET/POST | `/api/invites` | admin | `{role}` (POST) | List / create invite codes |
| DELETE | `/api/invites/:code` | admin | – | Revoke an unused invite |
| POST | `/api/volunteers` | any | `{name, role, skills}` | Adds a volunteer |
| POST | `/api/volunteers/:id/log-hours` | any | `{hours}` | Logs hours, updates monthly totals |
| POST | `/api/events` | admin/manager | `{title, location, date}` | Creates an event |
| POST | `/api/events/:id/join` | any | – | Increments the event's joined count |
| PATCH | `/api/events/:id/image` | admin/manager | `{imageData}` | Sets the event's cover photo (base64 data URL) |
| GET | `/api/fundraising` | any | – | Total raised, goal progress, by-campaign breakdown, recent donations |
| POST | `/api/donations` | any | `{amount, donorName?, campaign?, note?}` | Logs a donation (visible to the whole team; notifies admins/managers if it crosses the goal) |
| GET/POST | `/api/tasks` | any | `{title, assigneeId?, priority?, deadline?, notes?, fileData?, fileName?}` (POST) | List / create tasks; creating one also notifies the assignee |
| PATCH | `/api/tasks/:id` | any | `{status}` | Updates a task through pending → accepted → in_progress → completed, notifying the other side |
| GET/POST | `/api/conversations` | any | `{memberIds, isGroup?, title?}` (POST) | List your conversations / start a new direct message or group chat |
| GET/POST | `/api/conversations/:id/messages` | member only | `{text}` (POST) | List / send messages in a conversation; pushes live to other members |
| POST | `/api/nova/chat` | any | `{messages:[{role,text}]}` | Chats with Nova; templated reply if no API key configured |

## Nova AI — model & security notes

Nova calls Google's **Gemini API** through **your own server**, not the browser, so your Gemini key is never exposed to users. Default model is `gemini-2.5-flash` (good balance of quality, speed, and cost for drafting emails/reports) — configurable via `GEMINI_MODEL`.

## Security notes for production

- Set a real `JWT_SECRET` — the default is fine for local dev only.
- Serve over HTTPS (Render, Railway, Fly.io, a VPS behind Caddy/Nginx, etc. all make this easy).
- The included auth is deliberately minimal (scrypt + HMAC tokens, no refresh-token rotation, no rate limiting). Fine for a small team tool; harden it (rate limiting, email verification, password reset) before opening signups to the public internet.
- The self-serve "Apply as Volunteer" flow is intentionally low-friction (just the org code) — pending accounts have no access to org data until an Admin/Manager approves them, so treat the org code as semi-public and rely on the approval step as your gate, not code secrecy.
- `data.sqlite` is a single file — back it up. For heavier multi-region or high-write-concurrency use, migrate to Postgres (Supabase/RDS/etc.) behind the same `db.js` interface.
- The SSE connection in `/api/stream` holds one open HTTP connection per active client; if you deploy behind a proxy, make sure it allows long-lived connections and doesn't buffer `text/event-stream` responses.

## Roadmap ideas

- [ ] Password reset / email verification
- [ ] Push notifications for upcoming events (native, beyond in-app/SSE)
- [ ] True `.xlsx`/PDF export (currently CSV)
- [ ] Photo uploads for volunteers (currently just events)
- [ ] Group conversation creation UI (API already supports it)

## License

MIT — do whatever you'd like with it.
