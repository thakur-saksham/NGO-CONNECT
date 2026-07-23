// db.js — SQLite persistence for NGOConnect AI.
// Uses Node's built-in node:sqlite (requires Node >= 22.5). No native build step,
// no external database service — the whole app runs from a single process.
'use strict';
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.sqlite');
const SEED_DEMO_DATA = process.env.SEED_DEMO_DATA !== 'false';

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  org_code TEXT UNIQUE NOT NULL,
  volunteer_hours REAL NOT NULL DEFAULT 0,
  events_organized INTEGER NOT NULL DEFAULT 0,
  fundraising_goal REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin', -- 'admin' | 'manager' | 'coordinator'
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  role TEXT NOT NULL,
  created_by TEXT,
  used_by TEXT,
  created_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS volunteers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  role TEXT,
  hours REAL NOT NULL DEFAULT 0,
  events INTEGER NOT NULL DEFAULT 0,
  certs INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '[]',
  skills TEXT NOT NULL DEFAULT '[]',
  grad TEXT NOT NULL DEFAULT '',
  timeline TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  title TEXT NOT NULL,
  location TEXT,
  date_text TEXT,
  status TEXT NOT NULL DEFAULT 'upcoming',
  joined INTEGER NOT NULL DEFAULT 0,
  grad TEXT NOT NULL DEFAULT '',
  image_data TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  icon TEXT,
  color TEXT,
  title TEXT NOT NULL,
  sub TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS donations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  amount REAL NOT NULL,
  donor_name TEXT,
  campaign TEXT,
  event_id TEXT REFERENCES events(id),
  note TEXT,
  logged_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  title TEXT NOT NULL,
  assignee_id TEXT REFERENCES volunteers(id),
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'in_progress' | 'completed'
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  volunteer_id TEXT NOT NULL REFERENCES volunteers(id),
  event_id TEXT REFERENCES events(id),
  check_in_at TEXT NOT NULL,
  check_out_at TEXT
);

CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  title TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT '',
  target REAL NOT NULL DEFAULT 0,
  current REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  text TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_comments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  user_name TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_feedback (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  user_id TEXT,
  user_name TEXT,
  rating INTEGER NOT NULL,
  comment TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  is_group INTEGER NOT NULL DEFAULT 0,
  title TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  last_read_at TEXT,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  org_id TEXT NOT NULL REFERENCES orgs(id),
  sender_id TEXT,
  sender_name TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_volunteers_org ON volunteers(org_id);
CREATE INDEX IF NOT EXISTS idx_events_org ON events(org_id);
CREATE INDEX IF NOT EXISTS idx_activity_org ON activity(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_donations_org ON donations(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invites_org ON invites(org_id);
CREATE INDEX IF NOT EXISTS idx_tasks_org ON tasks(org_id);
CREATE INDEX IF NOT EXISTS idx_attendance_org ON attendance(org_id, check_in_at DESC);
CREATE INDEX IF NOT EXISTS idx_goals_org ON goals(org_id);
CREATE INDEX IF NOT EXISTS idx_announcements_org ON announcements(org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_event ON event_comments(event_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_feedback_event ON event_feedback(event_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(org_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conv_members_user ON conversation_members(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at ASC);
`);

// Lightweight migration for DBs created before roles/org_code/images/donations existed.
function columnExists(table, col){
  return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
}
if(!columnExists('orgs','org_code')){
  db.exec(`ALTER TABLE orgs ADD COLUMN org_code TEXT`);
  const rows = db.prepare('SELECT id, name FROM orgs').all();
  for(const r of rows){
    db.prepare('UPDATE orgs SET org_code = ? WHERE id = ?').run(makeOrgCode(r.name), r.id);
  }
}
if(!columnExists('orgs','fundraising_goal')) db.exec(`ALTER TABLE orgs ADD COLUMN fundraising_goal REAL NOT NULL DEFAULT 0`);
if(!columnExists('users','role')) db.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'admin'`);
if(!columnExists('events','image_data')) db.exec(`ALTER TABLE events ADD COLUMN image_data TEXT`);
// Profile fields
if(!columnExists('users','phone')) db.exec(`ALTER TABLE users ADD COLUMN phone TEXT`);
if(!columnExists('users','bio')) db.exec(`ALTER TABLE users ADD COLUMN bio TEXT`);
if(!columnExists('users','avatar_data')) db.exec(`ALTER TABLE users ADD COLUMN avatar_data TEXT`);
if(!columnExists('users','notif_last_read_at')) db.exec(`ALTER TABLE users ADD COLUMN notif_last_read_at TEXT`);
if(!columnExists('users','theme')) db.exec(`ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'dark'`);
// Volunteer safety/emergency + extras
if(!columnExists('volunteers','emergency_contact')) db.exec(`ALTER TABLE volunteers ADD COLUMN emergency_contact TEXT`);
if(!columnExists('volunteers','blood_group')) db.exec(`ALTER TABLE volunteers ADD COLUMN blood_group TEXT`);
if(!columnExists('volunteers','medical_notes')) db.exec(`ALTER TABLE volunteers ADD COLUMN medical_notes TEXT`);
if(!columnExists('volunteers','dob')) db.exec(`ALTER TABLE volunteers ADD COLUMN dob TEXT`);
if(!columnExists('volunteers','availability')) db.exec(`ALTER TABLE volunteers ADD COLUMN availability TEXT`);
if(!columnExists('volunteers','is_favorite')) db.exec(`ALTER TABLE volunteers ADD COLUMN is_favorite INTEGER NOT NULL DEFAULT 0`);
// Event calendar date, pin, video, photos
if(!columnExists('events','date_iso')) db.exec(`ALTER TABLE events ADD COLUMN date_iso TEXT`);
if(!columnExists('events','pinned')) db.exec(`ALTER TABLE events ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
if(!columnExists('events','video_url')) db.exec(`ALTER TABLE events ADD COLUMN video_url TEXT`);
if(!columnExists('events','photos')) db.exec(`ALTER TABLE events ADD COLUMN photos TEXT NOT NULL DEFAULT '[]'`);
// Approval workflow: users can be 'active' or 'pending' (self-serve volunteer applications).
if(!columnExists('users','status')) db.exec(`ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
// Volunteers can now be linked back to a login (user_id), and carry the same approval status.
if(!columnExists('volunteers','user_id')) db.exec(`ALTER TABLE volunteers ADD COLUMN user_id TEXT`);
if(!columnExists('volunteers','status')) db.exec(`ALTER TABLE volunteers ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
// Task workflow: priority/deadline/notes/file attachment, plus the 4-state accept workflow.
if(!columnExists('tasks','priority')) db.exec(`ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'`);
if(!columnExists('tasks','deadline')) db.exec(`ALTER TABLE tasks ADD COLUMN deadline TEXT`);
if(!columnExists('tasks','notes')) db.exec(`ALTER TABLE tasks ADD COLUMN notes TEXT`);
if(!columnExists('tasks','file_data')) db.exec(`ALTER TABLE tasks ADD COLUMN file_data TEXT`);
if(!columnExists('tasks','file_name')) db.exec(`ALTER TABLE tasks ADD COLUMN file_name TEXT`);
// Password reset (forgot password) — short-lived token stored on the user row.
if(!columnExists('users','reset_token')) db.exec(`ALTER TABLE users ADD COLUMN reset_token TEXT`);
if(!columnExists('users','reset_token_expires')) db.exec(`ALTER TABLE users ADD COLUMN reset_token_expires TEXT`);
// Volunteers that don't have a linked login (manually added by an admin) can still
// carry their own contact info + photo, so they're searchable/assignable like anyone else.
if(!columnExists('volunteers','email')) db.exec(`ALTER TABLE volunteers ADD COLUMN email TEXT`);
if(!columnExists('volunteers','phone')) db.exec(`ALTER TABLE volunteers ADD COLUMN phone TEXT`);
if(!columnExists('volunteers','avatar_data')) db.exec(`ALTER TABLE volunteers ADD COLUMN avatar_data TEXT`);
// Last-active timestamp, bumped on hours logged / check-in / check-out / task activity.
if(!columnExists('volunteers','last_active_at')) db.exec(`ALTER TABLE volunteers ADD COLUMN last_active_at TEXT`);
// Activity Timeline — who did it, so the timeline can show an avatar per entry.
if(!columnExists('activity','actor_id')) db.exec(`ALTER TABLE activity ADD COLUMN actor_id TEXT`);
if(!columnExists('activity','actor_name')) db.exec(`ALTER TABLE activity ADD COLUMN actor_name TEXT`);
if(!columnExists('activity','actor_avatar')) db.exec(`ALTER TABLE activity ADD COLUMN actor_avatar TEXT`);
// Goals & Progress — optional deadline, plus a running log of updates for the detail page.
if(!columnExists('goals','deadline')) db.exec(`ALTER TABLE goals ADD COLUMN deadline TEXT`);
db.exec(`
CREATE TABLE IF NOT EXISTS goal_updates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  goal_id TEXT NOT NULL REFERENCES goals(id),
  delta REAL NOT NULL,
  current_after REAL NOT NULL,
  note TEXT,
  actor_id TEXT,
  actor_name TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goal_updates_goal ON goal_updates(goal_id, created_at ASC);
`);
// Impact Dashboard — a clean, timestamped log of every hour contributed (manual "Log Hours"
// entries and auto-logged check-out durations both land here), so hours can be charted by month.
db.exec(`
CREATE TABLE IF NOT EXISTS hours_log (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  volunteer_id TEXT REFERENCES volunteers(id),
  hours REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hours_log_org ON hours_log(org_id, created_at ASC);
`);
// Impact Dashboard — beneficiaries served isn't derivable from existing data, so it's a
// number the NGO enters directly (like the fundraising goal).
if(!columnExists('orgs','beneficiaries_served')) db.exec(`ALTER TABLE orgs ADD COLUMN beneficiaries_served REAL NOT NULL DEFAULT 0`);
// A tiny history so "Beneficiaries" can show a month-over-month growth arrow like the
// other Impact Dashboard cards, instead of just a static number.
db.exec(`
CREATE TABLE IF NOT EXISTS beneficiaries_log (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  value REAL NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_beneficiaries_log_org ON beneficiaries_log(org_id, created_at ASC);
`);
// Goal comments — the "Comments" tab on a goal's detail page.
db.exec(`
CREATE TABLE IF NOT EXISTS goal_comments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  goal_id TEXT NOT NULL REFERENCES goals(id),
  actor_id TEXT,
  actor_name TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_goal_comments_goal ON goal_comments(goal_id, created_at ASC);
`);

/* ==================== Productivity suite: Goals hierarchy, Milestones,
 * Dependencies, Recurring tasks, Workload, Calendar, Board, Comments,
 * Attachments. ==================== */

// Goals: parent_id turns the flat goal list into a tree (Annual Goal -> monthly
// sub-goals), like ClickUp's nested Goals.
if(!columnExists('goals','parent_id')) db.exec(`ALTER TABLE goals ADD COLUMN parent_id TEXT REFERENCES goals(id)`);

// Tasks: recurrence (auto re-created on completion) + a link back to the
// recurring "series" it belongs to, so the UI can show "Repeats weekly".
if(!columnExists('tasks','recurrence')) db.exec(`ALTER TABLE tasks ADD COLUMN recurrence TEXT NOT NULL DEFAULT 'none'`);
if(!columnExists('tasks','recurrence_parent_id')) db.exec(`ALTER TABLE tasks ADD COLUMN recurrence_parent_id TEXT`);

db.exec(`
-- Milestones: a per-event checklist ("Planning -> Volunteer Recruitment -> ...").
CREATE TABLE IF NOT EXISTS milestones (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_milestones_event ON milestones(event_id, position ASC);

-- Dependencies: "Task B can't start until Task A is completed."
CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  depends_on_id TEXT NOT NULL REFERENCES tasks(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_id)
);
CREATE INDEX IF NOT EXISTS idx_taskdeps_task ON task_dependencies(task_id);
CREATE INDEX IF NOT EXISTS idx_taskdeps_dep ON task_dependencies(depends_on_id);

-- Comments — a lightweight thread on any task (Goals/Events already have their own).
CREATE TABLE IF NOT EXISTS task_comments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  actor_id TEXT,
  actor_name TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, created_at ASC);

-- Attachments — generic multi-file attachments (photos/PDF/Excel/budget/video link)
-- for events, tasks, or goals, beyond the single legacy task file / event photo array.
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_data TEXT NOT NULL,
  mime_type TEXT,
  uploaded_by TEXT,
  uploaded_by_name TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity_type, entity_id, created_at DESC);
`);

function slugify(name){
  return String(name || 'NGO').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 10) || 'NGO';
}
function makeOrgCode(name){
  let code;
  do {
    code = `${slugify(name)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
  } while (db.prepare('SELECT 1 FROM orgs WHERE org_code = ?').get(code));
  return code;
}
function makeInviteCode(){
  let code;
  do {
    code = crypto.randomBytes(5).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  } while (!code || db.prepare('SELECT 1 FROM invites WHERE code = ?').get(code));
  return code;
}
const ROLES = ['admin', 'manager', 'coordinator', 'volunteer'];
const ROLE_LABELS = { admin: 'Admin', manager: 'Manager', coordinator: 'Volunteer Coordinator', volunteer: 'Volunteer' };
const TASK_STATUSES = ['pending', 'accepted', 'in_progress', 'completed', 'archived'];
const RECURRENCE_OPTIONS = ['none', 'daily', 'weekly', 'monthly'];
const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'];

function uid(prefix) {
  return `${prefix}_${crypto.randomBytes(9).toString('hex')}`;
}
function nowIso() {
  return new Date().toISOString();
}
function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'now';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  return `${day}d`;
}

const GRADS_VOLUNTEER = [
  'linear-gradient(135deg,#f472b6,#c026d3)',
  'linear-gradient(135deg,#60a5fa,#3730a3)',
  'linear-gradient(135deg,#34d399,#0891b2)',
  'linear-gradient(135deg,#fbbf24,#ea580c)',
  'linear-gradient(135deg,#a78bfa,#4338ca)',
];
const GRADS_EVENT = [
  'linear-gradient(135deg,#0f2b1f,#1a3a2a 40%,#0b1a14)',
  'linear-gradient(135deg,#2b1a3a,#3a2050 40%,#160c22)',
  'linear-gradient(135deg,#1a2340,#20305a 40%,#0c1226)',
];
function randomGrad(list) { return list[Math.floor(Math.random() * list.length)]; }

/* ---------------- orgs & users ---------------- */
function createOrg(name) {
  const id = uid('org');
  const orgCode = makeOrgCode(name);
  db.prepare('INSERT INTO orgs (id, name, org_code, volunteer_hours, events_organized, fundraising_goal, created_at) VALUES (?, ?, ?, 0, 0, 0, ?)')
    .run(id, name, orgCode, nowIso());
  return { id, orgCode };
}
function findOrgByCode(orgCode) {
  return db.prepare('SELECT * FROM orgs WHERE org_code = ?').get(String(orgCode || '').toUpperCase());
}
function createUser({ orgId, name, email, passwordHash, role = 'admin', status = 'active' }) {
  const id = uid('u');
  db.prepare('INSERT INTO users (id, org_id, name, email, password_hash, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, orgId, name, email.toLowerCase(), passwordHash, role, status, nowIso());
  // Every teammate — admin, manager, coordinator, or volunteer — gets a linked volunteer
  // record automatically, so everyone (including admins/managers) shows up by name in the
  // Volunteers directory and Attendance tab, and can log their own hours / check in.
  const vid = uid('v');
  db.prepare(`INSERT INTO volunteers (id, org_id, name, role, hours, events, certs, tags, skills, grad, timeline, created_at, user_id, status, email)
              VALUES (?, ?, ?, ?, 0, 0, 0, '["Field"]', '["General"]', ?, '[]', ?, ?, ?, ?)`)
    .run(vid, orgId, name, ROLE_LABELS[role] || role, randomGrad(GRADS_VOLUNTEER), nowIso(), id, status, email.toLowerCase());
  return id;
}
// Lazily backfills a linked volunteer row for accounts created before every role got one
// (e.g. admins/managers/coordinators from older data). Safe to call on every login/bootstrap.
function ensureLinkedVolunteer(orgId, userId) {
  const existing = linkedVolunteerForUser(orgId, userId);
  if (existing) return existing;
  const user = getUser(userId);
  if (!user) return null;
  const vid = uid('v');
  db.prepare(`INSERT INTO volunteers (id, org_id, name, role, hours, events, certs, tags, skills, grad, timeline, created_at, user_id, status, email)
              VALUES (?, ?, ?, ?, 0, 0, 0, '["Field"]', '["General"]', ?, '[]', ?, ?, ?, ?)`)
    .run(vid, orgId, user.name, ROLE_LABELS[user.role] || user.role, randomGrad(GRADS_VOLUNTEER), nowIso(), userId, user.status || 'active', user.email);
  return rowToVolunteer(db.prepare('SELECT * FROM volunteers WHERE id = ?').get(vid));
}
function linkedVolunteerForUser(orgId, userId) {
  return db.prepare('SELECT * FROM volunteers WHERE org_id = ? AND user_id = ?').get(orgId, userId);
}
function listPendingApprovals(orgId) {
  return db.prepare(`SELECT id, name, email, role, created_at FROM users WHERE org_id = ? AND status = 'pending' ORDER BY created_at ASC`)
    .all(orgId).map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, roleLabel: ROLE_LABELS[u.role] || u.role, createdAt: u.created_at }));
}
function approveUser(orgId, userId, role) {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND org_id = ?').get(userId, orgId);
  if (!user) return null;
  const finalRole = (role && ROLES.includes(role)) ? role : user.role;
  db.prepare('UPDATE users SET status = \'active\', role = ? WHERE id = ?').run(finalRole, userId);
  db.prepare('UPDATE volunteers SET status = \'active\', role = ? WHERE user_id = ?').run(ROLE_LABELS[finalRole] || finalRole, userId);
  return publicUser(getUser(userId));
}
function rejectUser(orgId, userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND org_id = ?').get(userId, orgId);
  if (!user) return false;
  db.prepare('DELETE FROM volunteers WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  return true;
}
function updateUserRole(orgId, actingRole, targetUserId, newRole) {
  if (!ROLES.includes(newRole)) return { error: 'bad_role' };
  const target = db.prepare('SELECT * FROM users WHERE id = ? AND org_id = ?').get(targetUserId, orgId);
  if (!target) return { error: 'not_found' };
  // Managers can promote/demote coordinators & volunteers, but can't touch admins
  // or grant the admin role themselves — only an existing admin can do that.
  if (actingRole === 'manager' && (target.role === 'admin' || newRole === 'admin')) {
    return { error: 'forbidden' };
  }
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(newRole, targetUserId);
  db.prepare('UPDATE volunteers SET role = ? WHERE user_id = ?').run(ROLE_LABELS[newRole] || newRole, targetUserId);
  return { user: publicUser(getUser(targetUserId)) };
}
function findUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
}
function getUser(userId) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}
function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, email: row.email, role: row.role, status: row.status || 'active',
    phone: row.phone || '', bio: row.bio || '', avatarData: row.avatar_data || null,
    theme: row.theme || 'dark',
  };
}
function updateUserProfile(userId, { name, phone, bio, avatarData }) {
  if (name !== undefined) db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, userId);
  if (phone !== undefined) db.prepare('UPDATE users SET phone = ? WHERE id = ?').run(phone, userId);
  if (bio !== undefined) db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(bio, userId);
  if (avatarData !== undefined) db.prepare('UPDATE users SET avatar_data = ? WHERE id = ?').run(avatarData, userId);
  return publicUser(getUser(userId));
}
function updateUserPasswordHash(userId, passwordHash) {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, userId);
}
// ---- Forgot password ----
// No email provider is wired up in this project, so the reset token is returned directly
// to the caller (see server.js /api/auth/forgot-password) instead of being emailed out.
function createPasswordResetToken(email) {
  const user = findUserByEmail(email);
  if (!user) return null;
  const token = crypto.randomBytes(24).toString('base64url');
  const expires = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 minutes
  db.prepare('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?').run(token, expires, user.id);
  return { token, user };
}
function consumePasswordResetToken(token, newPasswordHash) {
  if (!token) return { error: 'invalid' };
  const user = db.prepare('SELECT * FROM users WHERE reset_token = ?').get(token);
  if (!user) return { error: 'invalid' };
  if (!user.reset_token_expires || new Date(user.reset_token_expires).getTime() < Date.now()) return { error: 'expired' };
  db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?')
    .run(newPasswordHash, user.id);
  return { user: publicUser(getUser(user.id)) };
}
// ---- Delete account ----
// Removes the login entirely. If the user has a linked volunteer record, that record is
// soft-removed too (status 'removed') so historical tasks/attendance/activity referencing
// it are preserved for auditing, matching how admin-initiated volunteer removal works.
function deleteUserAccount(orgId, userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND org_id = ?').get(userId, orgId);
  if (!user) return { error: 'not_found' };
  if (user.role === 'admin') {
    const otherAdmins = db.prepare(`SELECT COUNT(*) AS c FROM users WHERE org_id = ? AND role = 'admin' AND status = 'active' AND id != ?`).get(orgId, userId).c;
    if (otherAdmins === 0) return { error: 'sole_admin' };
  }
  const vol = linkedVolunteerForUser(orgId, userId);
  if (vol) db.prepare(`UPDATE volunteers SET status = 'removed' WHERE id = ?`).run(vol.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  return { ok: true };
}
function updateUserTheme(userId, theme) {
  db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(theme, userId);
}
function listColleagues(orgId) {
  return db.prepare(`SELECT id, name, email, role, status, created_at FROM users WHERE org_id = ? AND status = 'active' ORDER BY created_at ASC`).all(orgId)
    .map(u => ({ id: u.id, name: u.name, email: u.email, role: u.role, roleLabel: ROLE_LABELS[u.role] || u.role, status: u.status }));
}

/* ---------------- notifications ---------------- */
function addNotification(orgId, userId, { type, title, body, link }) {
  const id = uid('nt');
  db.prepare('INSERT INTO notifications (id, org_id, user_id, type, title, body, link, is_read, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)')
    .run(id, orgId, userId, type || 'info', title, body || null, link || null, nowIso());
  return rowToNotification(db.prepare('SELECT * FROM notifications WHERE id = ?').get(id));
}
function rowToNotification(row) {
  return { id: row.id, type: row.type, title: row.title, body: row.body, link: row.link, read: !!row.is_read, time: timeAgo(row.created_at), createdAt: row.created_at };
}
function listNotifications(orgId, userId, limit = 50) {
  return db.prepare('SELECT * FROM notifications WHERE org_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(orgId, userId, limit).map(rowToNotification);
}
function markAllNotificationsRead(orgId, userId) {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE org_id = ? AND user_id = ?').run(orgId, userId);
}
function unreadNotifCount(orgId, userId) {
  return db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE org_id = ? AND user_id = ? AND is_read = 0').get(orgId, userId).c;
}
function notifyRole(orgId, roles, { type, title, body, link }, excludeUserId) {
  const rows = db.prepare(`SELECT id FROM users WHERE org_id = ? AND status = 'active' AND role IN (${roles.map(() => '?').join(',')})`)
    .all(orgId, ...roles);
  const out = [];
  for (const r of rows) {
    if (excludeUserId && r.id === excludeUserId) continue;
    out.push(addNotification(orgId, r.id, { type, title, body, link }));
  }
  return out;
}

/* ---------------- messaging ---------------- */
function conversationReadInfo(conversationId, forUserId) {
  const members = db.prepare('SELECT user_id, last_read_at FROM conversation_members WHERE conversation_id = ?').all(conversationId);
  const others = members.filter(m => m.user_id !== forUserId);
  if (!others.length) return null;
  // "Read" only once every other member has read past that point — a conservative
  // definition that also works sensibly for group conversations.
  return others.reduce((min, m) => {
    const t = m.last_read_at || '1970-01-01T00:00:00.000Z';
    return (!min || t < min) ? t : min;
  }, null);
}
function rowToConversation(row, orgId, forUserId) {
  const members = db.prepare('SELECT u.id, u.name, cm.last_read_at FROM conversation_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = ?').all(row.id);
  const lastMsg = db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1').get(row.id);
  const mine = members.find(m => m.id === forUserId);
  const since = (mine && mine.last_read_at) || '1970-01-01T00:00:00.000Z';
  const unread = forUserId ? db.prepare('SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND created_at > ? AND (sender_id IS NULL OR sender_id != ?)').get(row.id, since, forUserId).c : 0;
  const title = row.title || (row.is_group ? 'Group' : (members.find(m => m.id !== forUserId) || {}).name || 'Conversation');
  return {
    id: row.id, isGroup: !!row.is_group, title,
    members: members.map(m => ({ id: m.id, name: m.name })),
    lastMessage: lastMsg ? { text: lastMsg.text, senderName: lastMsg.sender_name, time: timeAgo(lastMsg.created_at), createdAt: lastMsg.created_at } : null,
    unread,
    otherLastReadAt: conversationReadInfo(row.id, forUserId),
  };
}
function listConversations(orgId, userId) {
  const rows = db.prepare(`SELECT c.* FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id WHERE c.org_id = ? AND cm.user_id = ?`).all(orgId, userId);
  return rows.map(r => rowToConversation(r, orgId, userId))
    .sort((a, b) => new Date((b.lastMessage && b.lastMessage.createdAt) || 0) - new Date((a.lastMessage && a.lastMessage.createdAt) || 0));
}
function createConversation(orgId, memberIds, { isGroup = false, title = null, createdBy } = {}) {
  const id = uid('cv');
  db.prepare('INSERT INTO conversations (id, org_id, is_group, title, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, orgId, isGroup ? 1 : 0, title, createdBy || null, nowIso());
  const uniqueIds = Array.from(new Set(memberIds));
  for (const uidMember of uniqueIds) {
    db.prepare('INSERT INTO conversation_members (conversation_id, user_id, last_read_at) VALUES (?, ?, ?)').run(id, uidMember, nowIso());
  }
  return rowToConversation(db.prepare('SELECT * FROM conversations WHERE id = ?').get(id), orgId, createdBy);
}
function findOrCreateDirectConversation(orgId, userId1, userId2, createdBy) {
  const existing = db.prepare(`
    SELECT c.id FROM conversations c
    WHERE c.org_id = ? AND c.is_group = 0
      AND EXISTS (SELECT 1 FROM conversation_members m1 WHERE m1.conversation_id = c.id AND m1.user_id = ?)
      AND EXISTS (SELECT 1 FROM conversation_members m2 WHERE m2.conversation_id = c.id AND m2.user_id = ?)
      AND (SELECT COUNT(*) FROM conversation_members m WHERE m.conversation_id = c.id) = 2
  `).get(orgId, userId1, userId2);
  if (existing) return rowToConversation(db.prepare('SELECT * FROM conversations WHERE id = ?').get(existing.id), orgId, userId1);
  return createConversation(orgId, [userId1, userId2], { isGroup: false, createdBy: createdBy || userId1 });
}
function isConversationMember(conversationId, userId) {
  return !!db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(conversationId, userId);
}
function conversationMemberIds(conversationId) {
  return db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?').all(conversationId).map(r => r.user_id);
}
function listMessages(conversationId, orgId, limit = 200) {
  return db.prepare('SELECT * FROM messages WHERE conversation_id = ? AND org_id = ? ORDER BY created_at ASC LIMIT ?')
    .all(conversationId, orgId, limit)
    .map(m => ({ id: m.id, conversationId: m.conversation_id, senderId: m.sender_id, senderName: m.sender_name, text: m.text, time: timeAgo(m.created_at), createdAt: m.created_at }));
}
function addMessage(conversationId, orgId, senderId, senderName, text) {
  const id = uid('msg');
  db.prepare('INSERT INTO messages (id, conversation_id, org_id, sender_id, sender_name, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, conversationId, orgId, senderId, senderName, text, nowIso());
  db.prepare('UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?').run(nowIso(), conversationId, senderId);
  return { id, conversationId, senderId, senderName, text, time: 'now', createdAt: nowIso() };
}
function markConversationRead(conversationId, userId) {
  db.prepare('UPDATE conversation_members SET last_read_at = ? WHERE conversation_id = ? AND user_id = ?').run(nowIso(), conversationId, userId);
}
function totalUnreadMessages(orgId, userId) {
  const convos = listConversations(orgId, userId);
  return convos.reduce((a, c) => a + c.unread, 0);
}
function getOrg(orgId) {
  return db.prepare('SELECT * FROM orgs WHERE id = ?').get(orgId);
}
function updateOrg(orgId, { name, fundraisingGoal }) {
  if (name !== undefined) db.prepare('UPDATE orgs SET name = ? WHERE id = ?').run(name, orgId);
  if (fundraisingGoal !== undefined) db.prepare('UPDATE orgs SET fundraising_goal = ? WHERE id = ?').run(fundraisingGoal, orgId);
  return getOrg(orgId);
}
function updateOrgBeneficiaries(orgId, beneficiariesServed) {
  db.prepare('UPDATE orgs SET beneficiaries_served = ? WHERE id = ?').run(beneficiariesServed, orgId);
  db.prepare('INSERT INTO beneficiaries_log (id, org_id, value, created_at) VALUES (?, ?, ?, ?)')
    .run(uid('bl'), orgId, beneficiariesServed, nowIso());
  return getOrg(orgId);
}
function bumpOrgMonthly(orgId, { hoursDelta = 0, eventsDelta = 0 }) {
  db.prepare('UPDATE orgs SET volunteer_hours = volunteer_hours + ?, events_organized = events_organized + ? WHERE id = ?')
    .run(hoursDelta, eventsDelta, orgId);
}

/* ---------------- invites ---------------- */
function createInvite(orgId, role, createdBy) {
  const code = makeInviteCode();
  db.prepare('INSERT INTO invites (code, org_id, role, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(code, orgId, role, createdBy, nowIso());
  return { code, role, roleLabel: ROLE_LABELS[role] || role };
}
function listInvites(orgId) {
  return db.prepare('SELECT * FROM invites WHERE org_id = ? ORDER BY created_at DESC').all(orgId).map(i => ({
    code: i.code, role: i.role, roleLabel: ROLE_LABELS[i.role] || i.role,
    used: !!i.used_by, createdAt: i.created_at,
  }));
}
function consumeInvite(code, usedByUserId) {
  const row = db.prepare('SELECT * FROM invites WHERE code = ?').get(String(code || '').toUpperCase());
  if (!row || row.used_by) return null;
  db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?').run(usedByUserId, nowIso(), row.code);
  return row;
}
function peekInvite(code) {
  return db.prepare('SELECT * FROM invites WHERE code = ?').get(String(code || '').toUpperCase());
}
function revokeInvite(orgId, code) {
  const res = db.prepare('DELETE FROM invites WHERE code = ? AND org_id = ? AND used_by IS NULL').run(String(code || '').toUpperCase(), orgId);
  return res.changes > 0;
}

/* ---------------- donations / fundraising ---------------- */
function addDonation(orgId, { amount, donorName, campaign, eventId, note, loggedBy }) {
  const id = uid('d');
  db.prepare(`INSERT INTO donations (id, org_id, amount, donor_name, campaign, event_id, note, logged_by, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, orgId, amount, donorName || null, campaign || null, eventId || null, note || null, loggedBy || null, nowIso());
  return rowToDonation(db.prepare('SELECT * FROM donations WHERE id = ?').get(id));
}
function rowToDonation(row) {
  return {
    id: row.id, amount: row.amount, donorName: row.donor_name, campaign: row.campaign,
    eventId: row.event_id, note: row.note, time: timeAgo(row.created_at), createdAt: row.created_at,
  };
}
function listDonations(orgId, limit = 200) {
  return db.prepare('SELECT * FROM donations WHERE org_id = ? ORDER BY created_at DESC LIMIT ?').all(orgId, limit).map(rowToDonation);
}
function fundraisingSummary(orgId) {
  const org = getOrg(orgId);
  const donations = listDonations(orgId);
  const totalRaised = Math.round(donations.reduce((a, d) => a + d.amount, 0) * 100) / 100;
  const byCampaignMap = {};
  const events = listEvents(orgId);
  const eventTitleById = Object.fromEntries(events.map(e => [e.id, e.title]));
  for (const d of donations) {
    const key = d.campaign || (d.eventId && eventTitleById[d.eventId]) || 'General';
    byCampaignMap[key] = (byCampaignMap[key] || 0) + d.amount;
  }
  const byCampaign = Object.entries(byCampaignMap)
    .map(([campaign, total]) => ({ campaign, total: Math.round(total * 100) / 100 }))
    .sort((a, b) => b.total - a.total);
  // Weekly buckets (last 8 weeks) for the simple hours/donations chart.
  const weekly = [];
  const now = Date.now();
  for (let i = 7; i >= 0; i--) {
    const weekEnd = now - i * 7 * 86400000;
    const weekStart = weekEnd - 7 * 86400000;
    const total = donations
      .filter(d => { const t = new Date(d.createdAt).getTime(); return t > weekStart && t <= weekEnd; })
      .reduce((a, d) => a + d.amount, 0);
    weekly.push({ label: `W${8 - i}`, total: Math.round(total * 100) / 100 });
  }
  return {
    totalRaised,
    goal: org.fundraising_goal,
    progressPct: org.fundraising_goal > 0 ? Math.min(100, Math.round((totalRaised / org.fundraising_goal) * 1000) / 10) : null,
    byCampaign,
    weekly,
    recent: donations.slice(0, 20),
  };
}

/* ---------------- impact dashboard ---------------- */
function monthBuckets(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: d.toLocaleDateString('en-US', { month: 'short' }) });
  }
  return out;
}
function monthKey(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function impactStats(orgId) {
  const org = getOrg(orgId);
  const volunteers = listVolunteers(orgId);
  const events = listEvents(orgId);
  const fundraising = fundraisingSummary(orgId);
  return {
    totalVolunteers: volunteers.length,
    eventsConducted: events.filter(e => e.status === 'past').length || events.length,
    totalFundsRaised: fundraising.totalRaised,
    beneficiariesServed: org.beneficiaries_served || 0,
    volunteerHours: Math.round((org.volunteer_hours || 0) * 10) / 10,
  };
}
function impactCharts(orgId) {
  const buckets = monthBuckets(6);
  const volunteers = db.prepare(`SELECT created_at FROM volunteers WHERE org_id = ? AND status != 'removed'`).all(orgId);
  const donations = db.prepare(`SELECT amount, created_at FROM donations WHERE org_id = ?`).all(orgId);
  const events = db.prepare(`SELECT joined, created_at FROM events WHERE org_id = ?`).all(orgId);
  const hours = db.prepare(`SELECT hours, created_at FROM hours_log WHERE org_id = ?`).all(orgId);

  const volByMonth = {}; for (const v of volunteers) volByMonth[monthKey(v.created_at)] = (volByMonth[monthKey(v.created_at)] || 0) + 1;
  const donByMonth = {}; for (const d of donations) donByMonth[monthKey(d.created_at)] = (donByMonth[monthKey(d.created_at)] || 0) + d.amount;
  const attByMonth = {}; for (const e of events) attByMonth[monthKey(e.created_at)] = (attByMonth[monthKey(e.created_at)] || 0) + (e.joined || 0);
  const hrsByMonth = {}; for (const h of hours) hrsByMonth[monthKey(h.created_at)] = (hrsByMonth[monthKey(h.created_at)] || 0) + h.hours;

  // Volunteers already on the roster before the charted window count toward the starting total.
  const earliestBucketKey = buckets[0].key;
  let cumulative = volunteers.filter(v => monthKey(v.created_at) < earliestBucketKey).length;
  const volunteerGrowth = buckets.map(b => { cumulative += (volByMonth[b.key] || 0); return { label: b.label, value: cumulative }; });
  const monthlyDonations = buckets.map(b => ({ label: b.label, value: Math.round((donByMonth[b.key] || 0) * 100) / 100 }));
  const eventAttendance = buckets.map(b => ({ label: b.label, value: attByMonth[b.key] || 0 }));
  const impactByMonth = buckets.map(b => ({ label: b.label, value: Math.round((hrsByMonth[b.key] || 0) * 10) / 10 }));
  return { volunteerGrowth, monthlyDonations, eventAttendance, impactByMonth };
}
function pctChange(curr, prev) {
  if (!prev || prev <= 0) return curr > 0 ? null : 0; // null = "new" (nothing to compare against)
  return Math.round(((curr - prev) / prev) * 1000) / 10;
}
function beneficiariesGrowth(orgId, currentValue) {
  const rows = db.prepare('SELECT value, created_at FROM beneficiaries_log WHERE org_id = ? ORDER BY created_at ASC').all(orgId);
  if (rows.length < 2) return null;
  const cutoff = Date.now() - 25 * 24 * 60 * 60 * 1000; // ~last month
  let baseline = rows[0];
  for (const r of rows) { if (new Date(r.created_at).getTime() <= cutoff) baseline = r; else break; }
  return pctChange(currentValue, baseline.value);
}
function impactGrowth(orgId) {
  const charts = impactCharts(orgId);
  const stats = impactStats(orgId);
  const last = arr => arr[arr.length - 1].value;
  const prev = arr => arr[arr.length - 2].value;
  const volunteerGrowthPct = pctChange(last(charts.volunteerGrowth), prev(charts.volunteerGrowth));
  const donationGrowthPct = pctChange(last(charts.monthlyDonations), prev(charts.monthlyDonations));
  const hoursGrowthPct = pctChange(last(charts.impactByMonth), prev(charts.impactByMonth));
  const beneficiariesGrowthPct = beneficiariesGrowth(orgId, stats.beneficiariesServed);

  const available = [volunteerGrowthPct, donationGrowthPct, hoursGrowthPct, beneficiariesGrowthPct].filter(v => v !== null);
  const avgGrowth = available.length ? available.reduce((a, b) => a + b, 0) / available.length : 0;
  const impactScore = Math.max(0, Math.min(100, Math.round(50 + avgGrowth / 2)));

  // A couple of plain-English sentences highlighting the biggest movers, so the
  // dashboard reads like a briefing rather than a spreadsheet.
  const insights = [];
  const newVolunteersThisMonth = last(charts.volunteerGrowth) - prev(charts.volunteerGrowth);
  if (newVolunteersThisMonth > 0) insights.push(`${newVolunteersThisMonth} new volunteer${newVolunteersThisMonth === 1 ? '' : 's'} joined this month.`);
  if (donationGrowthPct !== null && donationGrowthPct !== 0) insights.push(`Donations are ${donationGrowthPct > 0 ? 'up' : 'down'} ${Math.abs(donationGrowthPct)}% compared to last month.`);
  else if (donationGrowthPct === null && last(charts.monthlyDonations) > 0) insights.push(`First donations logged this month — off to a great start.`);
  if (hoursGrowthPct !== null && hoursGrowthPct !== 0) insights.push(`Volunteer hours ${hoursGrowthPct > 0 ? 'grew' : 'dropped'} ${Math.abs(hoursGrowthPct)}% month-over-month.`);
  if (beneficiariesGrowthPct !== null && beneficiariesGrowthPct !== 0) insights.push(`Beneficiaries served ${beneficiariesGrowthPct > 0 ? 'increased' : 'decreased'} ${Math.abs(beneficiariesGrowthPct)}%.`);
  if (!insights.length) insights.push('Log a few donations, hours, or new volunteers to start seeing monthly trends here.');

  return {
    volunteerGrowthPct, donationGrowthPct, hoursGrowthPct, beneficiariesGrowthPct,
    impactScore, insights: insights.slice(0, 3),
  };
}

/* ---------------- goals (non-monetary NGO goals, e.g. "Plant 500 Trees") ---------------- */
function rowToGoal(row) {
  return {
    id: row.id, title: row.title, unit: row.unit, target: row.target, current: row.current,
    deadline: row.deadline || null, createdAt: row.created_at, parentId: row.parent_id || null,
    progressPct: row.target > 0 ? Math.min(100, Math.round((row.current / row.target) * 1000) / 10) : 0,
  };
}
function listGoals(orgId) {
  return db.prepare('SELECT * FROM goals WHERE org_id = ? ORDER BY created_at ASC').all(orgId).map(rowToGoal);
}
// Nested tree of goals for the "ClickUp Goals" hierarchical view — each node gets a
// `children` array, and a parent goal's own progress is rolled up from its children
// when it has any (so "Plant 1000 Trees" reflects July + August + September automatically).
function goalTree(orgId) {
  const all = listGoals(orgId);
  const byId = Object.fromEntries(all.map(g => [g.id, { ...g, children: [] }]));
  const roots = [];
  for (const g of all) {
    if (g.parentId && byId[g.parentId]) byId[g.parentId].children.push(byId[g.id]);
    else roots.push(byId[g.id]);
  }
  const rollUp = (node) => {
    node.children.forEach(rollUp);
    if (node.children.length) {
      node.current = node.children.reduce((a, c) => a + c.current, 0);
      node.target = node.children.reduce((a, c) => a + c.target, 0) || node.target;
      node.progressPct = node.target > 0 ? Math.min(100, Math.round((node.current / node.target) * 1000) / 10) : 0;
    }
  };
  roots.forEach(rollUp);
  return roots;
}
function getGoal(orgId, goalId) {
  const row = db.prepare('SELECT * FROM goals WHERE id = ? AND org_id = ?').get(goalId, orgId);
  return row ? rowToGoal(row) : null;
}
function addGoal(orgId, { title, unit, target, deadline, parentId }) {
  const id = uid('g');
  const parent = parentId ? db.prepare('SELECT id FROM goals WHERE id = ? AND org_id = ?').get(parentId, orgId) : null;
  db.prepare('INSERT INTO goals (id, org_id, title, unit, target, current, created_at, deadline, parent_id) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)')
    .run(id, orgId, title, unit || '', target || 0, nowIso(), deadline || null, parent ? parent.id : null);
  return rowToGoal(db.prepare('SELECT * FROM goals WHERE id = ?').get(id));
}
// Sets progress to an absolute value and logs the delta as a goal_updates row, so the
// goal's detail page has a running history of who moved the needle and by how much.
function updateGoalProgress(orgId, goalId, current, { note, actorId, actorName } = {}) {
  const row = db.prepare('SELECT * FROM goals WHERE id = ? AND org_id = ?').get(goalId, orgId);
  if (!row) return null;
  const delta = current - row.current;
  db.prepare('UPDATE goals SET current = ? WHERE id = ?').run(current, goalId);
  if (delta !== 0) {
    db.prepare('INSERT INTO goal_updates (id, org_id, goal_id, delta, current_after, note, actor_id, actor_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(uid('gu'), orgId, goalId, delta, current, note || null, actorId || null, actorName || null, nowIso());
  }
  return rowToGoal(db.prepare('SELECT * FROM goals WHERE id = ?').get(goalId));
}
function deleteGoal(orgId, goalId) {
  const children = db.prepare('SELECT id FROM goals WHERE parent_id = ? AND org_id = ?').all(goalId, orgId);
  for (const c of children) deleteGoal(orgId, c.id);
  return db.prepare('DELETE FROM goals WHERE id = ? AND org_id = ?').run(goalId, orgId).changes > 0;
}
function listGoalUpdates(goalId) {
  return db.prepare('SELECT * FROM goal_updates WHERE goal_id = ? ORDER BY created_at DESC').all(goalId)
    .map(r => ({ id: r.id, delta: r.delta, currentAfter: r.current_after, note: r.note, actorName: r.actor_name || 'Someone', createdAt: r.created_at, time: timeAgo(r.created_at) }));
}
// Contributors: who has logged positive progress on this goal, and how much of the total
// they're responsible for — the "contributors" list on the goal detail page.
function goalContributors(goalId) {
  const rows = db.prepare(`SELECT actor_name, SUM(delta) AS total, COUNT(*) AS updates, MAX(created_at) AS lastAt
                            FROM goal_updates WHERE goal_id = ? AND delta > 0 AND actor_name IS NOT NULL
                            GROUP BY actor_name ORDER BY total DESC`).all(goalId);
  return rows.map(r => ({ name: r.actor_name, total: r.total, updates: r.updates, lastAt: r.lastAt }));
}
// Milestones: the 25/50/75/100% marks, each stamped with when it was actually crossed
// (derived from the update history) or left open if not reached yet.
function goalMilestones(goal, updates) {
  const chronological = updates.slice().reverse(); // updates come back newest-first
  const thresholds = [25, 50, 75, 100];
  return thresholds.map(pct => {
    const targetValue = (goal.target * pct) / 100;
    const hit = chronological.find(u => u.currentAfter >= targetValue);
    return { pct, reached: !!hit, at: hit ? hit.createdAt : null };
  });
}
function listGoalComments(goalId) {
  return db.prepare('SELECT * FROM goal_comments WHERE goal_id = ? ORDER BY created_at ASC').all(goalId)
    .map(r => ({ id: r.id, text: r.text, actorId: r.actor_id, actorName: r.actor_name, createdAt: r.created_at, time: timeAgo(r.created_at) }));
}
function addGoalComment(orgId, goalId, { actorId, actorName, text }) {
  const id = uid('gc');
  const createdAt = nowIso();
  db.prepare('INSERT INTO goal_comments (id, org_id, goal_id, actor_id, actor_name, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, orgId, goalId, actorId || null, actorName, text, createdAt);
  return { id, text, actorId: actorId || null, actorName, createdAt, time: 'now' };
}

/* ---------------- announcements ---------------- */
function addAnnouncement(orgId, text, createdBy) {
  const id = uid('an');
  db.prepare('INSERT INTO announcements (id, org_id, text, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, orgId, text, createdBy, nowIso());
  return rowToAnnouncement(db.prepare('SELECT * FROM announcements WHERE id = ?').get(id));
}
function rowToAnnouncement(row) {
  return { id: row.id, text: row.text, time: timeAgo(row.created_at), createdAt: row.created_at };
}
function listAnnouncements(orgId, limit = 20) {
  return db.prepare('SELECT * FROM announcements WHERE org_id = ? ORDER BY created_at DESC LIMIT ?').all(orgId, limit).map(rowToAnnouncement);
}
function deleteAnnouncement(orgId, id) {
  return db.prepare('DELETE FROM announcements WHERE id = ? AND org_id = ?').run(id, orgId).changes > 0;
}

/* ---------------- tasks ---------------- */
function taskDependencyInfo(taskId, statusById) {
  const deps = db.prepare('SELECT depends_on_id FROM task_dependencies WHERE task_id = ?').all(taskId)
    .map(r => r.depends_on_id);
  const dependents = db.prepare('SELECT task_id FROM task_dependencies WHERE depends_on_id = ?').all(taskId)
    .map(r => r.task_id);
  const blocked = deps.some(id => statusById[id] && statusById[id] !== 'completed' && statusById[id] !== 'archived');
  return { dependsOn: deps, dependents, blocked };
}
function rowToTask(row, volunteerNameById, statusById) {
  const depInfo = statusById ? taskDependencyInfo(row.id, statusById) : { dependsOn: [], dependents: [], blocked: false };
  return {
    id: row.id, title: row.title, status: row.status,
    assigneeId: row.assignee_id, assigneeName: (volunteerNameById && volunteerNameById[row.assignee_id]) || null,
    priority: row.priority || 'normal', deadline: row.deadline || null, notes: row.notes || '',
    fileData: row.file_data || null, fileName: row.file_name || null,
    recurrence: row.recurrence || 'none', recurrenceParentId: row.recurrence_parent_id || null,
    dependsOn: depInfo.dependsOn, dependents: depInfo.dependents, blocked: depInfo.blocked,
    createdAt: row.created_at,
  };
}
function listTasks(orgId) {
  const vols = listVolunteers(orgId);
  const nameById = Object.fromEntries(vols.map(v => [v.id, v.name]));
  const rows = db.prepare('SELECT * FROM tasks WHERE org_id = ? ORDER BY created_at DESC').all(orgId);
  const statusById = Object.fromEntries(rows.map(r => [r.id, r.status]));
  return rows.map(r => rowToTask(r, nameById, statusById));
}
function addTask(orgId, { title, assigneeId, priority, deadline, notes, fileData, fileName, recurrence, dependsOn }) {
  const id = uid('task');
  const pr = TASK_PRIORITIES.includes(priority) ? priority : 'normal';
  const rec = RECURRENCE_OPTIONS.includes(recurrence) ? recurrence : 'none';
  db.prepare(`INSERT INTO tasks (id, org_id, title, assignee_id, status, priority, deadline, notes, file_data, file_name, recurrence, created_at)
              VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, orgId, title, assigneeId || null, pr, deadline || null, notes || null, fileData || null, fileName || null, rec, nowIso());
  if (Array.isArray(dependsOn)) {
    for (const depId of dependsOn) {
      if (depId === id) continue;
      const exists = db.prepare('SELECT id FROM tasks WHERE id = ? AND org_id = ?').get(depId, orgId);
      if (exists) db.prepare('INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id, created_at) VALUES (?, ?, ?)').run(id, depId, nowIso());
    }
  }
  const vols = listVolunteers(orgId);
  const nameById = Object.fromEntries(vols.map(v => [v.id, v.name]));
  const statusById = Object.fromEntries(db.prepare('SELECT id, status FROM tasks WHERE org_id = ?').all(orgId).map(r => [r.id, r.status]));
  return rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id), nameById, statusById);
}
// addDependency: "task can't start until dependsOnId is completed". Rejects self-references
// and direct cycles (A depends on B, which already depends on A).
function addDependency(orgId, taskId, dependsOnId) {
  if (taskId === dependsOnId) return { error: 'A task can\'t depend on itself.' };
  const both = db.prepare('SELECT id FROM tasks WHERE id IN (?, ?) AND org_id = ?').all(taskId, dependsOnId, orgId);
  if (both.length !== 2) return { error: 'Task not found.' };
  const reverse = db.prepare('SELECT 1 FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?').get(dependsOnId, taskId);
  if (reverse) return { error: 'That would create a circular dependency.' };
  db.prepare('INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id, created_at) VALUES (?, ?, ?)').run(taskId, dependsOnId, nowIso());
  return { ok: true };
}
function removeDependency(orgId, taskId, dependsOnId) {
  return db.prepare('DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?').run(taskId, dependsOnId).changes > 0;
}
const RECURRENCE_DAYS = { daily: 1, weekly: 7, monthly: 30 };
function addDaysIso(dateStr, days) {
  const d = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
  if (isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
// Called after a recurring task is marked completed — spins up the next occurrence
// (same title/assignee/priority, deadline pushed forward) so admins never have to
// recreate "Weekly Meeting" or "Monthly Report" by hand.
function spawnNextRecurrence(orgId, task) {
  if (!task.recurrence || task.recurrence === 'none') return null;
  const days = RECURRENCE_DAYS[task.recurrence];
  if (!days) return null;
  const nextDeadline = addDaysIso(task.deadline, days);
  const id = uid('task');
  db.prepare(`INSERT INTO tasks (id, org_id, title, assignee_id, status, priority, deadline, notes, recurrence, recurrence_parent_id, created_at)
              VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`)
    .run(id, orgId, task.title, task.assigneeId || null, task.priority, nextDeadline, task.notes || null,
         task.recurrence, task.recurrenceParentId || task.id, nowIso());
  const vols = listVolunteers(orgId);
  const nameById = Object.fromEntries(vols.map(v => [v.id, v.name]));
  const statusById = Object.fromEntries(db.prepare('SELECT id, status FROM tasks WHERE org_id = ?').all(orgId).map(r => [r.id, r.status]));
  return rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id), nameById, statusById);
}
function updateTaskStatus(orgId, taskId, status) {
  if (!TASK_STATUSES.includes(status)) return null;
  const row = db.prepare('SELECT * FROM tasks WHERE id = ? AND org_id = ?').get(taskId, orgId);
  if (!row) return null;
  db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, taskId);
  const vols = listVolunteers(orgId);
  const nameById = Object.fromEntries(vols.map(v => [v.id, v.name]));
  const statusById = Object.fromEntries(db.prepare('SELECT id, status FROM tasks WHERE org_id = ?').all(orgId).map(r => [r.id, r.status]));
  return rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId), nameById, statusById);
}
function deleteTask(orgId, taskId) {
  db.prepare('DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_id = ?').run(taskId, taskId);
  db.prepare('DELETE FROM task_comments WHERE task_id = ?').run(taskId);
  return db.prepare('DELETE FROM tasks WHERE id = ? AND org_id = ?').run(taskId, orgId).changes > 0;
}
function listTaskComments(taskId) {
  return db.prepare('SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC').all(taskId)
    .map(r => ({ id: r.id, text: r.text, actorId: r.actor_id, actorName: r.actor_name, createdAt: r.created_at, time: timeAgo(r.created_at) }));
}
function addTaskComment(orgId, taskId, { actorId, actorName, text }) {
  const id = uid('tc');
  const createdAt = nowIso();
  db.prepare('INSERT INTO task_comments (id, org_id, task_id, actor_id, actor_name, text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, orgId, taskId, actorId || null, actorName, text, createdAt);
  return { id, text, actorId: actorId || null, actorName, createdAt, time: 'now' };
}
// Workload view: how many open tasks (not completed/archived) each active volunteer is
// carrying right now, so a manager can spot who's overloaded at a glance.
function workloadSummary(orgId) {
  const vols = listVolunteers(orgId);
  const rows = db.prepare('SELECT assignee_id, status FROM tasks WHERE org_id = ?').all(orgId);
  return vols.map(v => {
    const mine = rows.filter(r => r.assignee_id === v.id);
    const active = mine.filter(r => r.status !== 'completed' && r.status !== 'archived').length;
    return { volunteerId: v.id, name: v.name, avatarData: v.avatarData, grad: v.grad, activeTasks: active, totalTasks: mine.length };
  }).sort((a, b) => b.activeTasks - a.activeTasks);
}
// Calendar: merges events, task deadlines, volunteer birthdays, and goal deadlines into
// one dated feed the calendar view can drop dots on.
function calendarFeed(orgId) {
  const items = [];
  for (const e of listEvents(orgId)) {
    if (e.dateIso) items.push({ date: e.dateIso, type: 'event', title: e.title, id: e.id, color: 'purple' });
  }
  for (const t of listTasks(orgId)) {
    if (t.deadline) items.push({ date: t.deadline, type: 'task', title: t.title, id: t.id, color: t.status === 'completed' ? 'green' : 'blue' });
  }
  for (const v of listVolunteers(orgId)) {
    if (v.dob) {
      const md = v.dob.slice(5); // MM-DD, recurs every year
      items.push({ date: md, type: 'birthday', title: `${v.name}'s birthday`, id: v.id, color: 'orange', recursYearly: true });
    }
  }
  for (const g of listGoals(orgId)) {
    if (g.deadline) items.push({ date: g.deadline, type: 'goal', title: `Goal deadline: ${g.title}`, id: g.id, color: 'red' });
  }
  return items;
}

/* ---------------- attendance ---------------- */
function rowToAttendance(row, volunteerNameById) {
  const durationMin = row.check_out_at ? Math.round((new Date(row.check_out_at) - new Date(row.check_in_at)) / 60000) : null;
  return {
    id: row.id, volunteerId: row.volunteer_id, volunteerName: (volunteerNameById && volunteerNameById[row.volunteer_id]) || 'Unknown',
    eventId: row.event_id, checkInAt: row.check_in_at, checkOutAt: row.check_out_at, durationMin,
  };
}
function listAttendance(orgId, limit = 100) {
  const vols = listVolunteers(orgId);
  const nameById = Object.fromEntries(vols.map(v => [v.id, v.name]));
  return db.prepare('SELECT * FROM attendance WHERE org_id = ? ORDER BY check_in_at DESC LIMIT ?').all(orgId, limit).map(r => rowToAttendance(r, nameById));
}
function checkIn(orgId, volunteerId, eventId) {
  const openExisting = db.prepare('SELECT * FROM attendance WHERE org_id = ? AND volunteer_id = ? AND check_out_at IS NULL').get(orgId, volunteerId);
  if (openExisting) return { error: 'already_checked_in' };
  const id = uid('att');
  db.prepare('INSERT INTO attendance (id, org_id, volunteer_id, event_id, check_in_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, orgId, volunteerId, eventId || null, nowIso());
  touchVolunteerLastActive(orgId, volunteerId);
  const vols = listVolunteers(orgId);
  const nameById = Object.fromEntries(vols.map(v => [v.id, v.name]));
  return rowToAttendance(db.prepare('SELECT * FROM attendance WHERE id = ?').get(id), nameById);
}
function checkOut(orgId, attendanceId) {
  const row = db.prepare('SELECT * FROM attendance WHERE id = ? AND org_id = ?').get(attendanceId, orgId);
  if (!row) return null;
  if (row.check_out_at) return { error: 'already_checked_out' };
  db.prepare('UPDATE attendance SET check_out_at = ? WHERE id = ?').run(nowIso(), attendanceId);
  touchVolunteerLastActive(orgId, row.volunteer_id);
  const vols = listVolunteers(orgId);
  const nameById = Object.fromEntries(vols.map(v => [v.id, v.name]));
  const updated = rowToAttendance(db.prepare('SELECT * FROM attendance WHERE id = ?').get(attendanceId), nameById);
  if (updated.durationMin) {
    const hours = Math.round((updated.durationMin / 60) * 10) / 10;
    if (hours > 0) {
      logVolunteerHours(orgId, row.volunteer_id, hours);
      bumpOrgMonthly(orgId, { hoursDelta: hours });
    }
  }
  return updated;
}

/* ---------------- volunteer badges (computed automatically, no storage needed) ---------------- */
function computeBadges(volunteer, orgEvents) {
  const badges = [];
  if (volunteer.hours >= 50) badges.push({ icon: '🏅', label: '50 Hours' });
  if (volunteer.hours >= 100) badges.push({ icon: '🥇', label: 'Top Volunteer' });
  if (volunteer.events >= 5) badges.push({ icon: '⭐', label: 'Event Leader' });
  return badges;
}

/* ---------------- volunteers ---------------- */
function rowToVolunteer(row) {
  return {
    id: row.id, name: row.name, role: row.role, hours: row.hours,
    events: row.events, certs: row.certs,
    tags: JSON.parse(row.tags), skills: JSON.parse(row.skills),
    grad: row.grad, timeline: JSON.parse(row.timeline),
    emergencyContact: row.emergency_contact || '', bloodGroup: row.blood_group || '',
    medicalNotes: row.medical_notes || '', dob: row.dob || '', availability: row.availability || '',
    isFavorite: !!row.is_favorite,
    userId: row.user_id || null, status: row.status || 'active',
    email: row.email || '', phone: row.phone || '', avatarData: row.avatar_data || null,
    lastActiveAt: row.last_active_at || row.created_at, createdAt: row.created_at,
    badges: computeBadges({ hours: row.hours, events: row.events }),
  };
}
function listVolunteers(orgId) {
  return db.prepare(`SELECT * FROM volunteers WHERE org_id = ? AND status = 'active' ORDER BY created_at ASC`).all(orgId).map(rowToVolunteer);
}
// Active + suspended (never removed) — used by the volunteer-selection picker and the
// admin volunteer-management screen, so suspended people are visible (but not assignable).
function listVolunteersForManagement(orgId) {
  return db.prepare(`SELECT * FROM volunteers WHERE org_id = ? AND status IN ('active','suspended') ORDER BY created_at ASC`).all(orgId).map(rowToVolunteer);
}
function touchVolunteerLastActive(orgId, volunteerId) {
  db.prepare('UPDATE volunteers SET last_active_at = ? WHERE id = ? AND org_id = ?').run(nowIso(), volunteerId, orgId);
}
function suspendVolunteer(orgId, volunteerId) {
  const row = db.prepare('SELECT * FROM volunteers WHERE id = ? AND org_id = ?').get(volunteerId, orgId);
  if (!row) return null;
  db.prepare(`UPDATE volunteers SET status = 'suspended' WHERE id = ?`).run(volunteerId);
  if (row.user_id) db.prepare(`UPDATE users SET status = 'suspended' WHERE id = ?`).run(row.user_id);
  return rowToVolunteer(db.prepare('SELECT * FROM volunteers WHERE id = ?').get(volunteerId));
}
function reactivateVolunteer(orgId, volunteerId) {
  const row = db.prepare('SELECT * FROM volunteers WHERE id = ? AND org_id = ?').get(volunteerId, orgId);
  if (!row) return null;
  db.prepare(`UPDATE volunteers SET status = 'active' WHERE id = ?`).run(volunteerId);
  if (row.user_id) db.prepare(`UPDATE users SET status = 'active' WHERE id = ?`).run(row.user_id);
  return rowToVolunteer(db.prepare('SELECT * FROM volunteers WHERE id = ?').get(volunteerId));
}
function removeVolunteer(orgId, volunteerId) {
  const row = db.prepare('SELECT * FROM volunteers WHERE id = ? AND org_id = ?').get(volunteerId, orgId);
  if (!row) return null;
  // Soft delete: history (tasks/attendance/activity referencing this volunteer) is kept
  // for auditing, but they drop out of every active list and lose access if they had a login.
  db.prepare(`UPDATE volunteers SET status = 'removed' WHERE id = ?`).run(volunteerId);
  if (row.user_id) db.prepare(`UPDATE users SET status = 'removed' WHERE id = ?`).run(row.user_id);
  return true;
}
function insertVolunteer(orgId, { name, role, skills, tags, timeline, email, phone }) {
  const id = uid('v');
  db.prepare(`INSERT INTO volunteers (id, org_id, name, role, hours, events, certs, tags, skills, grad, timeline, created_at, email, phone)
              VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, orgId, name, role, JSON.stringify(tags || ['Field']), JSON.stringify(skills || ['General']),
      randomGrad(GRADS_VOLUNTEER), JSON.stringify(timeline || []), nowIso(), email || null, phone || null);
  return rowToVolunteer(db.prepare('SELECT * FROM volunteers WHERE id = ?').get(id));
}
function logVolunteerHours(orgId, volunteerId, hours) {
  const row = db.prepare('SELECT * FROM volunteers WHERE id = ? AND org_id = ?').get(volunteerId, orgId);
  if (!row) return null;
  const timeline = JSON.parse(row.timeline);
  timeline.unshift({ icon: 'clock', color: 'green', title: `Logged ${hours}h`, sub: 'Just now' });
  db.prepare('UPDATE volunteers SET hours = hours + ?, timeline = ?, last_active_at = ? WHERE id = ?')
    .run(hours, JSON.stringify(timeline), nowIso(), volunteerId);
  db.prepare('INSERT INTO hours_log (id, org_id, volunteer_id, hours, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(uid('hl'), orgId, volunteerId, hours, nowIso());
  return rowToVolunteer(db.prepare('SELECT * FROM volunteers WHERE id = ?').get(volunteerId));
}
function updateVolunteerDetails(orgId, volunteerId, fields) {
  const row = db.prepare('SELECT * FROM volunteers WHERE id = ? AND org_id = ?').get(volunteerId, orgId);
  if (!row) return null;
  const map = {
    emergencyContact: 'emergency_contact', bloodGroup: 'blood_group', medicalNotes: 'medical_notes',
    dob: 'dob', availability: 'availability',
  };
  for (const [key, col] of Object.entries(map)) {
    if (fields[key] !== undefined) db.prepare(`UPDATE volunteers SET ${col} = ? WHERE id = ?`).run(fields[key], volunteerId);
  }
  return rowToVolunteer(db.prepare('SELECT * FROM volunteers WHERE id = ?').get(volunteerId));
}
function toggleFavoriteVolunteer(orgId, volunteerId) {
  const row = db.prepare('SELECT * FROM volunteers WHERE id = ? AND org_id = ?').get(volunteerId, orgId);
  if (!row) return null;
  db.prepare('UPDATE volunteers SET is_favorite = ? WHERE id = ?').run(row.is_favorite ? 0 : 1, volunteerId);
  return rowToVolunteer(db.prepare('SELECT * FROM volunteers WHERE id = ?').get(volunteerId));
}
function todaysBirthdays(orgId) {
  const vols = listVolunteers(orgId);
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return vols.filter(v => v.dob && v.dob.slice(5, 7) === mm && v.dob.slice(8, 10) === dd);
}

/* ---------------- events ---------------- */
function rowToEvent(row) {
  return {
    id: row.id, title: row.title, location: row.location, date: row.date_text, dateIso: row.date_iso || null,
    status: row.status, joined: row.joined, grad: row.grad, imageData: row.image_data || null,
    pinned: !!row.pinned, videoUrl: row.video_url || null,
    photos: row.photos ? JSON.parse(row.photos) : [],
    mapsUrl: row.location ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(row.location)}` : null,
  };
}
function listEvents(orgId) {
  return db.prepare('SELECT * FROM events WHERE org_id = ? ORDER BY pinned DESC, created_at ASC').all(orgId).map(rowToEvent);
}
function insertEvent(orgId, { title, location, date, dateIso }) {
  const id = uid('e');
  db.prepare(`INSERT INTO events (id, org_id, title, location, date_text, date_iso, status, joined, grad, created_at)
              VALUES (?, ?, ?, ?, ?, ?, 'upcoming', 0, ?, ?)`)
    .run(id, orgId, title, location, date, dateIso || null, randomGrad(GRADS_EVENT), nowIso());
  return rowToEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(id));
}
function joinEvent(orgId, eventId) {
  const row = db.prepare('SELECT * FROM events WHERE id = ? AND org_id = ?').get(eventId, orgId);
  if (!row) return null;
  db.prepare('UPDATE events SET joined = joined + 1 WHERE id = ?').run(eventId);
  return rowToEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(eventId));
}
function updateEventImage(orgId, eventId, imageData) {
  const row = db.prepare('SELECT * FROM events WHERE id = ? AND org_id = ?').get(eventId, orgId);
  if (!row) return null;
  db.prepare('UPDATE events SET image_data = ? WHERE id = ?').run(imageData || null, eventId);
  return rowToEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(eventId));
}
function addEventPhoto(orgId, eventId, imageData) {
  const row = db.prepare('SELECT * FROM events WHERE id = ? AND org_id = ?').get(eventId, orgId);
  if (!row) return null;
  const photos = row.photos ? JSON.parse(row.photos) : [];
  photos.unshift(imageData);
  db.prepare('UPDATE events SET photos = ? WHERE id = ?').run(JSON.stringify(photos.slice(0, 30)), eventId);
  return rowToEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(eventId));
}
function setEventVideoUrl(orgId, eventId, videoUrl) {
  const row = db.prepare('SELECT * FROM events WHERE id = ? AND org_id = ?').get(eventId, orgId);
  if (!row) return null;
  db.prepare('UPDATE events SET video_url = ? WHERE id = ?').run(videoUrl || null, eventId);
  return rowToEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(eventId));
}
function togglePinEvent(orgId, eventId) {
  const row = db.prepare('SELECT * FROM events WHERE id = ? AND org_id = ?').get(eventId, orgId);
  if (!row) return null;
  // Only one pinned event per org at a time.
  db.prepare('UPDATE events SET pinned = 0 WHERE org_id = ?').run(orgId);
  db.prepare('UPDATE events SET pinned = ? WHERE id = ?').run(row.pinned ? 0 : 1, eventId);
  return rowToEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(eventId));
}

/* ---------------- event comments & feedback ---------------- */
function addEventComment(orgId, eventId, userName, text) {
  const id = uid('cm');
  db.prepare('INSERT INTO event_comments (id, org_id, event_id, user_name, text, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, orgId, eventId, userName, text, nowIso());
  return rowToComment(db.prepare('SELECT * FROM event_comments WHERE id = ?').get(id));
}
function rowToComment(row) {
  return { id: row.id, userName: row.user_name, text: row.text, time: timeAgo(row.created_at) };
}
function listEventComments(orgId, eventId) {
  return db.prepare('SELECT * FROM event_comments WHERE org_id = ? AND event_id = ? ORDER BY created_at ASC').all(orgId, eventId).map(rowToComment);
}
function addEventFeedback(orgId, eventId, userId, userName, rating, comment) {
  const id = uid('fb');
  db.prepare('INSERT INTO event_feedback (id, org_id, event_id, user_id, user_name, rating, comment, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, orgId, eventId, userId, userName, rating, comment || null, nowIso());
  return rowToFeedback(db.prepare('SELECT * FROM event_feedback WHERE id = ?').get(id));
}
function rowToFeedback(row) {
  return { id: row.id, userName: row.user_name, rating: row.rating, comment: row.comment, time: timeAgo(row.created_at) };
}
function eventFeedbackSummary(orgId, eventId) {
  const rows = db.prepare('SELECT * FROM event_feedback WHERE org_id = ? AND event_id = ? ORDER BY created_at DESC').all(orgId, eventId);
  const avg = rows.length ? Math.round((rows.reduce((a, r) => a + r.rating, 0) / rows.length) * 10) / 10 : 0;
  return { average: avg, count: rows.length, recent: rows.map(rowToFeedback) };
}

/* ---------------- milestones (per-event checklist) ---------------- */
function rowToMilestone(row) {
  return { id: row.id, eventId: row.event_id, title: row.title, status: row.status, position: row.position, createdAt: row.created_at };
}
function listMilestones(orgId, eventId) {
  return db.prepare('SELECT * FROM milestones WHERE org_id = ? AND event_id = ? ORDER BY position ASC, created_at ASC')
    .all(orgId, eventId).map(rowToMilestone);
}
function addMilestone(orgId, eventId, title) {
  const id = uid('ms');
  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM milestones WHERE event_id = ?').get(eventId).m;
  db.prepare('INSERT INTO milestones (id, org_id, event_id, title, status, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, orgId, eventId, title, 'pending', maxPos + 1, nowIso());
  return rowToMilestone(db.prepare('SELECT * FROM milestones WHERE id = ?').get(id));
}
function updateMilestoneStatus(orgId, milestoneId, status) {
  if (!['pending', 'in_progress', 'done'].includes(status)) return null;
  const row = db.prepare('SELECT * FROM milestones WHERE id = ? AND org_id = ?').get(milestoneId, orgId);
  if (!row) return null;
  db.prepare('UPDATE milestones SET status = ? WHERE id = ?').run(status, milestoneId);
  return rowToMilestone(db.prepare('SELECT * FROM milestones WHERE id = ?').get(milestoneId));
}
function deleteMilestone(orgId, milestoneId) {
  return db.prepare('DELETE FROM milestones WHERE id = ? AND org_id = ?').run(milestoneId, orgId).changes > 0;
}

/* ---------------- attachments (generic, multi-file) ---------------- */
function rowToAttachment(row) {
  return {
    id: row.id, entityType: row.entity_type, entityId: row.entity_id,
    fileName: row.file_name, fileData: row.file_data, mimeType: row.mime_type || '',
    uploadedBy: row.uploaded_by, uploadedByName: row.uploaded_by_name, createdAt: row.created_at, time: timeAgo(row.created_at),
  };
}
function listAttachments(orgId, entityType, entityId) {
  return db.prepare('SELECT * FROM attachments WHERE org_id = ? AND entity_type = ? AND entity_id = ? ORDER BY created_at DESC')
    .all(orgId, entityType, entityId).map(rowToAttachment);
}
function addAttachment(orgId, { entityType, entityId, fileName, fileData, mimeType, uploadedBy, uploadedByName }) {
  const id = uid('att');
  const createdAt = nowIso();
  db.prepare(`INSERT INTO attachments (id, org_id, entity_type, entity_id, file_name, file_data, mime_type, uploaded_by, uploaded_by_name, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, orgId, entityType, entityId, fileName, fileData, mimeType || null, uploadedBy || null, uploadedByName || null, createdAt);
  return rowToAttachment(db.prepare('SELECT * FROM attachments WHERE id = ?').get(id));
}
function deleteAttachment(orgId, id) {
  return db.prepare('DELETE FROM attachments WHERE id = ? AND org_id = ?').run(id, orgId).changes > 0;
}

/* ---------------- activity ---------------- */
function listActivity(orgId, limit = 12) {
  return db.prepare(`SELECT a.*, u.name AS user_name, u.avatar_data AS user_avatar
                      FROM activity a LEFT JOIN users u ON u.id = a.actor_id
                      WHERE a.org_id = ? ORDER BY a.created_at DESC LIMIT ?`)
    .all(orgId, limit)
    .map(row => ({
      id: row.id, icon: row.icon, color: row.color, title: row.title, sub: row.sub,
      time: timeAgo(row.created_at), createdAt: row.created_at,
      actorId: row.actor_id || null,
      actorName: row.user_name || row.actor_name || null,
      actorAvatar: row.user_avatar || row.actor_avatar || null,
    }));
}
function addActivity(orgId, { icon, color, title, sub, actorId, actorName, actorAvatar }) {
  const id = uid('a');
  const createdAt = nowIso();
  db.prepare('INSERT INTO activity (id, org_id, icon, color, title, sub, created_at, actor_id, actor_name, actor_avatar) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, orgId, icon, color, title, sub || null, createdAt, actorId || null, actorName || null, actorAvatar || null);
  return { id, icon, color, title, sub: sub || null, time: 'now', createdAt, actorId: actorId || null, actorName: actorName || null, actorAvatar: actorAvatar || null };
}

/* ---------------- bootstrap payload ---------------- */
function bootstrapFor(orgId, userId) {
  const org = getOrg(orgId);
  const userRow = userId ? getUser(userId) : null;
  if (userId) ensureLinkedVolunteer(orgId, userId);
  const canSeeApprovals = userRow && (userRow.role === 'admin' || userRow.role === 'manager');
  return {
    orgName: org.name,
    orgCode: org.org_code,
    volunteers: listVolunteers(orgId),
    events: listEvents(orgId),
    activity: listActivity(orgId),
    monthly: { volunteerHours: Math.round(org.volunteer_hours * 10) / 10, eventsOrganized: org.events_organized },
    fundraising: fundraisingSummary(orgId),
    colleagues: listColleagues(orgId),
    goals: listGoals(orgId),
    goalTree: goalTree(orgId),
    announcements: listAnnouncements(orgId),
    tasks: listTasks(orgId),
    workload: workloadSummary(orgId),
    calendarFeed: calendarFeed(orgId),
    attendance: listAttendance(orgId),
    birthdaysToday: todaysBirthdays(orgId),
    notifications: userId ? listNotifications(orgId, userId) : [],
    unreadNotifications: userId ? unreadNotifCount(orgId, userId) : 0,
    conversations: userId ? listConversations(orgId, userId) : [],
    unreadMessages: userId ? totalUnreadMessages(orgId, userId) : 0,
    pendingApprovals: canSeeApprovals ? listPendingApprovals(orgId) : [],
  };
}

/* ---------------- demo seed ---------------- */
function seedDemoDataForOrg(orgId) {
  if (!SEED_DEMO_DATA) return;
  const volunteers = [
    { name: 'Aditi Sharma', role: 'Field Coordinator', hours: 34, events: 5, certs: 0, tags: ['Field'], skills: ['Logistics', 'Community'], dob: '1996-07-22',
      timeline: [
        { icon: 'user', color: 'blue', title: 'Joined as Field Coordinator', sub: '4 months ago' },
        { icon: 'calendar', color: 'purple', title: 'Attended 5 events', sub: 'This year' },
        { icon: 'clock', color: 'green', title: 'Logged 34 hours', sub: 'Total' }] },
    { name: 'Rohan Verma', role: 'Photographer', hours: 18, events: 3, certs: 0, tags: ['Photography'], skills: ['Photography', 'Editing'],
      timeline: [
        { icon: 'user', color: 'blue', title: 'Joined as Photographer', sub: '3 months ago' },
        { icon: 'calendar', color: 'purple', title: 'Attended 3 events', sub: 'This year' },
        { icon: 'clock', color: 'green', title: 'Logged 18 hours', sub: 'Total' }] },
    { name: 'Fatima Sheikh', role: 'Educator · Teacher', hours: 46, events: 7, certs: 1, tags: ['Teaching'], skills: ['Teaching', 'STEM', 'Mentorship'],
      timeline: [
        { icon: 'user', color: 'blue', title: 'Joined as Educator', sub: '6 months ago' },
        { icon: 'calendar', color: 'purple', title: 'Attended 7 events', sub: 'This year' },
        { icon: 'award', color: 'orange', title: 'Earned Teaching Certification', sub: '2 months ago' },
        { icon: 'clock', color: 'green', title: 'Logged 46 hours', sub: 'Total' }] },
    { name: 'Priya Nair', role: 'Fundraiser · Outreach', hours: 28, events: 4, certs: 0, tags: ['Fundraising'], skills: ['Fundraising', 'Outreach'], dob: '1994-08-03',
      timeline: [
        { icon: 'user', color: 'blue', title: 'Joined as Fundraiser', sub: '5 months ago' },
        { icon: 'calendar', color: 'purple', title: 'Attended 4 events', sub: 'This year' },
        { icon: 'clock', color: 'green', title: 'Logged 28 hours', sub: 'Total' }] },
    { name: 'Karan Mehta', role: 'Logistics Lead', hours: 39, events: 6, certs: 0, tags: ['Field'], skills: ['Logistics', 'Driving'],
      timeline: [
        { icon: 'user', color: 'blue', title: 'Joined as Logistics Lead', sub: '7 months ago' },
        { icon: 'calendar', color: 'purple', title: 'Attended 6 events', sub: 'This year' },
        { icon: 'clock', color: 'green', title: 'Logged 39 hours', sub: 'Total' }] },
    { name: 'Meera Pillai', role: 'Volunteer Coordinator', hours: 22, events: 4, certs: 0, tags: ['Field', 'Fundraising'], skills: ['Coordination', 'Outreach'],
      timeline: [
        { icon: 'user', color: 'blue', title: 'Joined as Volunteer Coordinator', sub: '3 months ago' },
        { icon: 'calendar', color: 'purple', title: 'Attended 4 events', sub: 'This year' },
        { icon: 'clock', color: 'green', title: 'Logged 22 hours', sub: 'Total' }] },
    { name: 'Ananya Iyer', role: 'New Volunteer', hours: 6, events: 1, certs: 0, tags: ['Field'], skills: ['General'],
      timeline: [
        { icon: 'user', color: 'blue', title: 'Joined NGOConnect AI', sub: '2 days ago' },
        { icon: 'clock', color: 'green', title: 'Logged 6 hours', sub: 'Total' }] },
  ];
  const volIds = {}; // name -> id, so tasks/goals below can reference real volunteers
  for (const v of volunteers) {
    const id = uid('v');
    volIds[v.name] = id;
    db.prepare(`INSERT INTO volunteers (id, org_id, name, role, hours, events, certs, tags, skills, grad, timeline, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, v.name, v.role, v.hours, v.events, v.certs, JSON.stringify(v.tags), JSON.stringify(v.skills),
        randomGrad(GRADS_VOLUNTEER), JSON.stringify(v.timeline), nowIso());
    if (v.dob) db.prepare('UPDATE volunteers SET dob = ? WHERE id = ?').run(v.dob, id);
  }
  // Real, freely-licensed photos from Wikimedia Commons (Special:FilePath — Commons' own
  // stable endpoint for direct/hotlinked reuse of a file) so each demo event looks real.
  const IMG = {
    treePlanting: 'https://commons.wikimedia.org/wiki/Special:FilePath/India%20-%20Kids%20-%20Planting%20trees%20for%20her%20future%20(4040009491).jpg',
    ruralMeal: 'https://commons.wikimedia.org/wiki/Special:FilePath/Children%20at%20a%20rural%20school%20provided%20with%20lunch%20Uttar%20Pradesh%20India.jpg',
    middayMeal: 'https://commons.wikimedia.org/wiki/Special:FilePath/Students%20receiving%20mid%20day%20meals%20at%20Vaithi%20Kuppam%20Tsunami%20hit%20village%20in%20Pondicherry.jpg',
    classroom: 'https://commons.wikimedia.org/wiki/Special:FilePath/A%20Classroom%20in%20a%20Government%20Primary%20school%20in%20Kerala.jpg',
  };
  const events = [
    { title: 'Tree Plantation Drive — Sanjay Van', location: 'Sanjay Van, New Delhi', date: 'Wed, Jul 22, 8:00 AM', dateIso: '2026-07-22', image: IMG.treePlanting },
    { title: 'Winter Meal Packing', location: 'Yamuna Ghat Community Kitchen, Delhi', date: 'Fri, Jul 24, 5:00 PM', dateIso: '2026-07-24', image: IMG.ruralMeal },
    { title: 'Food Drive — Dharavi', location: 'Dharavi Community Hall, Mumbai', date: 'Sat, Jul 25, 9:00 AM', dateIso: '2026-07-25', image: IMG.middayMeal },
    { title: 'STEM Workshop for Kids', location: 'Govt. Primary School, Indiranagar, Bengaluru', date: 'Sat, Aug 1, 10:00 AM', dateIso: '2026-08-01', image: IMG.classroom },
    { title: 'Old Clothes & Blanket Collection Drive', location: 'Sector 21 Community Centre, Noida', date: 'Sun, Aug 9, 11:00 AM', dateIso: '2026-08-09', image: null },
  ];
  const eventIds = {};
  for (const e of events) {
    const created = insertEvent(orgId, { title: e.title, location: e.location, date: e.date, dateIso: e.dateIso });
    eventIds[e.title] = created.id;
    if (e.image) updateEventImage(orgId, created.id, e.image);
  }
  const foodDriveId = eventIds['Food Drive — Dharavi'];

  /* ---- Goals: annual goal with monthly sub-goals (rolls up automatically) ---- */
  const treesGoal = addGoal(orgId, { title: 'Plant 1000 Trees', unit: 'trees', target: 1000, deadline: '2026-12-31' });
  const julyTrees = addGoal(orgId, { title: 'July', unit: 'trees', target: 300, parentId: treesGoal.id });
  const augTrees = addGoal(orgId, { title: 'August', unit: 'trees', target: 250, parentId: treesGoal.id });
  const sepTrees = addGoal(orgId, { title: 'September', unit: 'trees', target: 450, parentId: treesGoal.id });
  updateGoalProgress(orgId, julyTrees.id, 210, { note: 'Sanjay Van planting day', actorId: null, actorName: 'Aditi Sharma' });
  updateGoalProgress(orgId, augTrees.id, 60, { note: 'Community nursery batch', actorId: null, actorName: 'Karan Mehta' });
  addGoal(orgId, { title: 'Feed 5,000 People', unit: 'meals', target: 5000, deadline: '2026-12-31' });
  const fundsGoal = addGoal(orgId, { title: 'Raise ₹10 Lakhs', unit: 'INR', target: 1000000, deadline: '2026-11-30' });
  updateGoalProgress(orgId, fundsGoal.id, 386500, { note: 'Q3 donor drive', actorId: null, actorName: 'Priya Nair' });

  /* ---- Milestones: a per-event checklist ---- */
  if (foodDriveId) {
    addMilestone(orgId, foodDriveId, 'Planning');
    addMilestone(orgId, foodDriveId, 'Volunteer Recruitment');
    addMilestone(orgId, foodDriveId, 'Food Collection');
    addMilestone(orgId, foodDriveId, 'Distribution');
    addMilestone(orgId, foodDriveId, 'Report');
    const ms = listMilestones(orgId, foodDriveId);
    updateMilestoneStatus(orgId, ms[0].id, 'done');
    updateMilestoneStatus(orgId, ms[1].id, 'done');
    updateMilestoneStatus(orgId, ms[2].id, 'in_progress');
    // A tiny attachment on the event, so Attachments doesn't look empty in the demo.
    addAttachment(orgId, {
      entityType: 'event', entityId: foodDriveId, fileName: 'Food_Drive_Budget.csv',
      fileData: 'data:text/csv;base64,' + Buffer.from('Item,Amount (INR)\nRice (50kg bags),12000\nCooking oil,4500\nTransport,3000\n').toString('base64'),
      mimeType: 'text/csv', uploadedByName: 'Priya Nair',
    });
  }

  /* ---- Tasks: dependencies, recurrence, comments, and every board column ---- */
  const collectFood = addTask(orgId, { title: 'Food Collection — Dharavi Drive', assigneeId: volIds['Karan Mehta'], priority: 'high', deadline: '2026-07-24', notes: 'Coordinate pickup with 3 partner grocers.' });
  updateTaskStatus(orgId, collectFood.id, 'in_progress');
  const distributeFood = addTask(orgId, { title: 'Food Distribution — Dharavi Drive', assigneeId: volIds['Aditi Sharma'], priority: 'high', deadline: '2026-07-25', notes: 'Distribute at Dharavi Community Hall, 9am start.', dependsOn: [collectFood.id] });
  addTaskComment(orgId, distributeFood.id, { actorName: 'Aditi Sharma', text: 'Waiting on the collection count before I finalize volunteer shifts.' });
  addTaskComment(orgId, distributeFood.id, { actorName: 'Karan Mehta', text: 'Should have final numbers by Thursday evening.' });

  const weeklyMeeting = addTask(orgId, { title: 'Weekly Team Meeting', assigneeId: volIds['Aditi Sharma'], priority: 'normal', deadline: '2026-07-20', recurrence: 'weekly', notes: 'Standing Monday sync — agenda in shared doc.' });
  addTask(orgId, { title: 'Monthly Impact Report', assigneeId: volIds['Priya Nair'], priority: 'normal', deadline: '2026-07-31', recurrence: 'monthly' });
  addTask(orgId, { title: 'Volunteer Training Session', assigneeId: volIds['Fatima Sheikh'], priority: 'normal', deadline: '2026-07-19', recurrence: 'weekly', notes: 'Every Saturday — onboarding + safety refresher.' });

  const buySupplies = addTask(orgId, { title: 'Buy plantation saplings', assigneeId: volIds['Rohan Verma'], priority: 'low', deadline: '2026-07-21' });
  updateTaskStatus(orgId, buySupplies.id, 'accepted');
  const contactDonors = addTask(orgId, { title: 'Contact major donors', assigneeId: volIds['Priya Nair'], priority: 'urgent', deadline: '2026-07-22' });
  const socialPost = addTask(orgId, { title: 'Post STEM workshop recap', assigneeId: volIds['Rohan Verma'], priority: 'normal' });
  updateTaskStatus(orgId, socialPost.id, 'completed');
  const oldBanner = addTask(orgId, { title: 'Design old campaign banner', priority: 'low' });
  updateTaskStatus(orgId, oldBanner.id, 'archived');
  addTask(orgId, { title: 'Arrange volunteer transport', assigneeId: volIds['Karan Mehta'], priority: 'normal', deadline: '2026-07-23' });
  addTask(orgId, { title: 'Confirm venue permit', assigneeId: volIds['Meera Pillai'], priority: 'high', deadline: '2026-07-21' });

  const activity = [
    { icon: 'calendar', color: 'purple', title: 'New event: Food Drive — Dharavi', sub: 'Dharavi Community Hall, Mumbai' },
    { icon: 'target', color: 'green', title: '"July" sub-goal updated', sub: '210 / 300 trees' },
    { icon: 'checksquare', color: 'blue', title: 'New task: Food Distribution — Dharavi Drive', sub: 'Aditi Sharma' },
    { icon: 'clock', color: 'green', title: 'Fatima Sheikh logged 12h', sub: 'STEM Workshop prep' },
    { icon: 'users', color: 'blue', title: '7 volunteers active this month', sub: null },
  ];
  for (const a of activity) {
    const id = uid('a');
    db.prepare('INSERT INTO activity (id, org_id, icon, color, title, sub, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, orgId, a.icon, a.color, a.title, a.sub, nowIso());
  }
  bumpOrgMonthly(orgId, { hoursDelta: 193, eventsDelta: 5 });
}

module.exports = {
  db, uid, nowIso, ROLES, ROLE_LABELS, TASK_STATUSES, TASK_PRIORITIES, RECURRENCE_OPTIONS,
  createOrg, createUser, findUserByEmail, findOrgByCode, getUser, publicUser, updateUserProfile, updateUserPasswordHash,
  updateUserTheme, createPasswordResetToken, consumePasswordResetToken, deleteUserAccount,
  linkedVolunteerForUser, ensureLinkedVolunteer, listPendingApprovals, approveUser, rejectUser, updateUserRole,
  listColleagues, getOrg, updateOrg, updateOrgBeneficiaries, bumpOrgMonthly,
  createInvite, listInvites, consumeInvite, peekInvite, revokeInvite,
  addDonation, listDonations, fundraisingSummary,
  listGoals, getGoal, addGoal, updateGoalProgress, deleteGoal, listGoalUpdates, goalContributors, goalMilestones,
  listGoalComments, addGoalComment, goalTree,
  addAnnouncement, listAnnouncements, deleteAnnouncement,
  listTasks, addTask, updateTaskStatus, deleteTask,
  addDependency, removeDependency, spawnNextRecurrence,
  listTaskComments, addTaskComment, workloadSummary, calendarFeed,
  listMilestones, addMilestone, updateMilestoneStatus, deleteMilestone,
  listAttachments, addAttachment, deleteAttachment,
  listAttendance, checkIn, checkOut,
  listVolunteers, listVolunteersForManagement, insertVolunteer, logVolunteerHours, updateVolunteerDetails,
  toggleFavoriteVolunteer, todaysBirthdays, suspendVolunteer, reactivateVolunteer, removeVolunteer,
  listEvents, insertEvent, joinEvent, updateEventImage, addEventPhoto, setEventVideoUrl, togglePinEvent,
  addEventComment, listEventComments, addEventFeedback, eventFeedbackSummary,
  listActivity, addActivity, impactStats, impactCharts, impactGrowth,
  addNotification, listNotifications, markAllNotificationsRead, unreadNotifCount, notifyRole,
  listConversations, createConversation, findOrCreateDirectConversation, isConversationMember,
  conversationMemberIds, listMessages, addMessage, markConversationRead, totalUnreadMessages, conversationReadInfo,
  bootstrapFor, seedDemoDataForOrg,
};
