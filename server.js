// server.js — NGOConnect AI backend.
// Serves the frontend (./public) and a small REST API backed by SQLite (db.js).
'use strict';
require('dotenv').config();
const path = require('path');
const express = require('express');
const db = require('./db');
const { hashPassword, verifyPassword, signToken, verifyToken, requireAuth, requireRole } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

app.use(express.json({ limit: '6mb' })); // event cover photos are sent as base64 in JSON

/* ------------------------------------------------------------------ */
/* Real-time (SSE): one long-lived response per connected client, grouped by org.
 * EventSource can't send custom headers, so the client authenticates via ?token=. */
const sseClients = new Map(); // orgId -> Set<{ res, userId }>
function addClient(orgId, userId, res) {
  if (!sseClients.has(orgId)) sseClients.set(orgId, new Set());
  const entry = { res, userId };
  sseClients.get(orgId).add(entry);
  return entry;
}
function removeClient(orgId, entry) {
  const set = sseClients.get(orgId);
  if (set) { set.delete(entry); if (set.size === 0) sseClients.delete(orgId); }
}
// onlineUserIds: distinct user IDs with at least one open SSE connection for this org —
// used to show "online now" presence on the Volunteers tab.
function onlineUserIds(orgId) {
  const set = sseClients.get(orgId);
  if (!set) return [];
  return Array.from(new Set(Array.from(set).map(c => c.userId)));
}
// broadcast() sends to every connected client in the org. Pass excludeUserId (almost
// always the acting user's own req.userId) so the person who just made a change doesn't
// get their own change echoed back — the HTTP response already updated their screen, and
// re-processing the same change via the SSE 'update' event caused duplicate list entries
// and needless re-renders (visible as a flicker) for the very action they just took.
function broadcast(orgId, event, data, excludeUserId) {
  const set = sseClients.get(orgId);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of set) {
    if (excludeUserId && c.userId === excludeUserId) continue;
    try { c.res.write(payload); } catch (e) { /* client gone */ }
  }
}
function pushToUser(orgId, userId, event, data) {
  const set = sseClients.get(orgId);
  if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of set) { if (c.userId === userId) { try { c.res.write(payload); } catch (e) { /* gone */ } } }
}
app.get('/api/stream', (req, res) => {
  const payload = verifyToken(req.query.token);
  if (!payload) return res.status(401).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  const entry = addClient(payload.orgId, payload.uid, res);
  // Someone just came online — let their teammates' Volunteers tab reflect it.
  broadcast(payload.orgId, 'update', { kind: 'presence-changed' }, payload.uid);
  const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, 25000);
  req.on('close', () => {
    clearInterval(keepAlive);
    removeClient(payload.orgId, entry);
    broadcast(payload.orgId, 'update', { kind: 'presence-changed' });
  });
});

// Permissive CORS — handy if you ever serve the frontend from a different origin in dev.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/* Health check — the frontend pings this to decide online vs. offline mode */
app.get('/api/health', (req, res) => res.json({ ok: true }));

/* ------------------------------------------------------------------ */
/* Auth */
app.post('/api/auth/signup', (req, res) => {
  const { name, orgName, email, password } = req.body || {};
  if (!name || !email || !password || String(password).length < 6) {
    return res.status(400).json({ error: 'Name, email, and a 6+ character password are required.' });
  }
  if (db.findUserByEmail(email)) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }
  const org = db.createOrg(orgName || `${name}'s NGO`);
  const userId = db.createUser({ orgId: org.id, name, email, passwordHash: hashPassword(password), role: 'admin', status: 'active' });
  db.seedDemoDataForOrg(org.id);
  const token = signToken({ uid: userId, orgId: org.id });
  res.status(201).json({ token, user: db.publicUser(db.getUser(userId)), ...db.bootstrapFor(org.id, userId), onlineUserIds: onlineUserIds(org.id) });
});

// Join an *existing* NGO workspace using an admin-issued invite code. Admin already
// vetted this person by handing out the code, so they go straight to 'active'.
app.post('/api/auth/join', (req, res) => {
  const { inviteCode, name, email, password } = req.body || {};
  if (!inviteCode || !name || !email || !password || String(password).length < 6) {
    return res.status(400).json({ error: 'Invite code, name, email, and a 6+ character password are required.' });
  }
  const invite = db.peekInvite(inviteCode);
  if (!invite) return res.status(404).json({ error: 'Invite code not found.' });
  if (invite.used_by) return res.status(409).json({ error: 'This invite code has already been used.' });
  if (db.findUserByEmail(email)) return res.status(409).json({ error: 'An account with that email already exists.' });

  const userId = db.createUser({ orgId: invite.org_id, name, email, passwordHash: hashPassword(password), role: invite.role, status: 'active' });
  db.consumeInvite(inviteCode, userId);
  db.addActivity(invite.org_id, { icon: 'user', color: 'purple', title: `${name} joined as ${db.ROLE_LABELS[invite.role] || invite.role}`, sub: null, actorId: userId, actorName: name });
  broadcast(invite.org_id, 'update', { kind: 'colleague-joined' });
  const token = signToken({ uid: userId, orgId: invite.org_id });
  res.status(201).json({ token, user: db.publicUser(db.getUser(userId)), ...db.bootstrapFor(invite.org_id, userId), onlineUserIds: onlineUserIds(invite.org_id) });
});

// Self-serve "Apply as Volunteer" using just the org code (no invite needed) — goes
// into a 'pending' state until an admin/manager approves.
app.post('/api/auth/apply', (req, res) => {
  const { orgCode, name, email, password } = req.body || {};
  if (!orgCode || !name || !email || !password || String(password).length < 6) {
    return res.status(400).json({ error: 'Organization code, name, email, and a 6+ character password are required.' });
  }
  const org = db.findOrgByCode(orgCode);
  if (!org) return res.status(404).json({ error: 'Organization code not found.' });
  if (db.findUserByEmail(email)) return res.status(409).json({ error: 'An account with that email already exists.' });

  const userId = db.createUser({ orgId: org.id, name, email, passwordHash: hashPassword(password), role: 'volunteer', status: 'pending' });
  db.notifyRole(org.id, ['admin', 'manager'], {
    type: 'approval', title: `${name} applied to join as a volunteer`, body: 'Review their application in Settings.', link: 'approvals',
  });
  broadcast(org.id, 'update', { kind: 'approval-requested' });
  const token = signToken({ uid: userId, orgId: org.id });
  res.status(201).json({ token, user: db.publicUser(db.getUser(userId)), ...db.bootstrapFor(org.id, userId), onlineUserIds: onlineUserIds(org.id) });
});

app.post('/api/auth/signin', (req, res) => {
  const { email, password } = req.body || {};
  const row = email && db.findUserByEmail(email);
  if (!row || !verifyPassword(password || '', row.password_hash)) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  if (row.status === 'suspended') return res.status(403).json({ error: 'Your account has been suspended. Contact your NGO admin.' });
  if (row.status === 'removed') return res.status(401).json({ error: 'Incorrect email or password.' });
  const token = signToken({ uid: row.id, orgId: row.org_id });
  res.json({ token, user: db.publicUser(row), ...db.bootstrapFor(row.org_id, row.id), onlineUserIds: onlineUserIds(row.org_id) });
});

app.get('/api/bootstrap', requireAuth, (req, res) => {
  const org = db.getOrg(req.orgId);
  if (!org) return res.status(404).json({ error: 'Organization not found.' });
  const userRow = db.getUser(req.userId);
  if (!userRow) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ user: db.publicUser(userRow), ...db.bootstrapFor(req.orgId, req.userId), onlineUserIds: onlineUserIds(req.orgId) });
});

// Activity Timeline — the full, scrollable feed (bootstrap only ships the latest 12 for
// the Home dashboard preview).
app.get('/api/activity', requireAuth, (req, res) => {
  const limit = Math.min(200, parseInt(req.query.limit, 10) || 100);
  res.json({ activity: db.listActivity(req.orgId, limit) });
});

// Impact Dashboard — headline stats + last-6-months chart series.
app.get('/api/impact', requireAuth, (req, res) => {
  res.json({ stats: db.impactStats(req.orgId), charts: db.impactCharts(req.orgId), growth: db.impactGrowth(req.orgId) });
});
app.patch('/api/impact/beneficiaries', requireAuth, requireRole('admin', 'manager'), (req, res) => {
  const value = parseFloat(req.body && req.body.beneficiariesServed);
  if (isNaN(value) || value < 0) return res.status(400).json({ error: 'Enter a valid number.' });
  const org = db.updateOrgBeneficiaries(req.orgId, value);
  broadcast(req.orgId, 'update', { kind: 'impact-updated' }, req.userId);
  res.json({ beneficiariesServed: org.beneficiaries_served });
});

// Forgot password — no email provider is configured in this project, so the reset link
// is handed back directly in the API response (and logged server-side) instead of being
// emailed. Wire up a real mail provider here before shipping this to production.
app.post('/api/auth/forgot-password', (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email is required.' });
  const result = db.createPasswordResetToken(email);
  // Always respond the same way whether or not the account exists, so this endpoint
  // can't be used to probe which emails are registered.
  if (!result) return res.json({ ok: true });
  console.log(`[auth] Password reset requested for ${email} — token: ${result.token} (valid 30 minutes)`);
  res.json({ ok: true, devToken: result.token }); // devToken: remove once real email delivery is wired up
});
app.post('/api/auth/reset-password', (req, res) => {
  const { token, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }
  const result = db.consumePasswordResetToken(token, hashPassword(newPassword));
  if (result.error === 'invalid') return res.status(400).json({ error: 'This reset link is invalid.' });
  if (result.error === 'expired') return res.status(400).json({ error: 'This reset link has expired. Request a new one.' });
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Approval workflow — admin/manager review pending volunteer applications */
app.get('/api/approvals', requireAuth, requireRole('admin', 'manager'), (req, res) => {
  res.json({ pendingApprovals: db.listPendingApprovals(req.orgId) });
});
app.post('/api/approvals/:userId/approve', requireAuth, requireRole('admin', 'manager'), (req, res) => {
  const { role } = req.body || {};
  const user = db.approveUser(req.orgId, req.params.userId, role);
  if (!user) return res.status(404).json({ error: 'Application not found.' });
  db.addActivity(req.orgId, { icon: 'user', color: 'green', title: `${user.name} approved as ${db.ROLE_LABELS[user.role] || user.role}`, sub: null, actorId: user.id, actorName: user.name });
  db.addNotification(req.orgId, req.params.userId, { type: 'approval', title: "You're approved!", body: `Welcome to the team as ${db.ROLE_LABELS[user.role] || user.role}.`, link: 'home' });
  pushToUser(req.orgId, req.params.userId, 'notification', { title: "You're approved!" });
  pushToUser(req.orgId, req.params.userId, 'status-change', { status: 'active' });
  broadcast(req.orgId, 'update', { kind: 'approval-resolved' }, req.userId);
  res.json({ user, pendingApprovals: db.listPendingApprovals(req.orgId) });
});
app.post('/api/approvals/:userId/reject', requireAuth, requireRole('admin', 'manager'), (req, res) => {
  const ok = db.rejectUser(req.orgId, req.params.userId);
  if (!ok) return res.status(404).json({ error: 'Application not found.' });
  pushToUser(req.orgId, req.params.userId, 'status-change', { status: 'rejected' });
  broadcast(req.orgId, 'update', { kind: 'approval-resolved' }, req.userId);
  res.json({ rejected: true, pendingApprovals: db.listPendingApprovals(req.orgId) });
});

/* Role changes — admin can change anyone; manager can change anyone except admins,
 * and can't grant the admin role (enforced in db.updateUserRole). */
app.patch('/api/colleagues/:id/role', requireAuth, requireRole('admin', 'manager'), (req, res) => {
  const { role } = req.body || {};
  const result = db.updateUserRole(req.orgId, req.role, req.params.id, role);
  if (result.error === 'not_found') return res.status(404).json({ error: 'Colleague not found.' });
  if (result.error === 'forbidden') return res.status(403).json({ error: 'Managers cannot change admin roles.' });
  if (result.error === 'bad_role') return res.status(400).json({ error: `Role must be one of: ${db.ROLES.join(', ')}` });
  db.addNotification(req.orgId, req.params.id, { type: 'role', title: `Your role changed to ${db.ROLE_LABELS[result.user.role] || result.user.role}`, link: 'home' });
  pushToUser(req.orgId, req.params.id, 'notification', { title: 'Your role changed' });
  broadcast(req.orgId, 'update', { kind: 'role-changed' }, req.userId);
  res.json({ user: result.user, colleagues: db.listColleagues(req.orgId) });
});

/* ------------------------------------------------------------------ */
/* Profile: edit own name/phone/bio/avatar, change password, theme preference, notifications */
app.patch('/api/me', requireAuth, (req, res) => {
  const { name, phone, bio, avatarData } = req.body || {};
  if (avatarData && (typeof avatarData !== 'string' || !avatarData.startsWith('data:image/') || avatarData.length > 2_000_000)) {
    return res.status(400).json({ error: 'Avatar image must be under ~1.5MB.' });
  }
  const user = db.updateUserProfile(req.userId, { name, phone, bio, avatarData });
  res.json({ user });
});
app.post('/api/me/password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }
  const userRow = db.getUser(req.userId);
  if (!verifyPassword(currentPassword || '', userRow.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }
  db.updateUserPasswordHash(req.userId, hashPassword(newPassword));
  res.json({ ok: true });
});
app.delete('/api/me', requireAuth, (req, res) => {
  const { password } = req.body || {};
  const userRow = db.getUser(req.userId);
  if (!verifyPassword(password || '', userRow.password_hash)) {
    return res.status(401).json({ error: 'Password is incorrect.' });
  }
  const result = db.deleteUserAccount(req.orgId, req.userId);
  if (result.error === 'sole_admin') {
    return res.status(400).json({ error: "You're the only Admin — promote another teammate to Admin before deleting your account." });
  }
  if (result.error === 'not_found') return res.status(404).json({ error: 'Account not found.' });
  broadcast(req.orgId, 'update', { kind: 'colleague-joined' }, req.userId);
  res.json({ ok: true });
});
app.patch('/api/me/theme', requireAuth, (req, res) => {
  const { theme } = req.body || {};
  if (!['dark', 'light'].includes(theme)) return res.status(400).json({ error: 'Theme must be dark or light.' });
  db.updateUserTheme(req.userId, theme);
  res.json({ theme });
});
app.get('/api/notifications', requireAuth, (req, res) => {
  res.json({ notifications: db.listNotifications(req.orgId, req.userId) });
});
app.post('/api/notifications/mark-read', requireAuth, (req, res) => {
  db.markAllNotificationsRead(req.orgId, req.userId);
  res.json({ ok: true });
});
app.get('/api/notifications/unread-count', requireAuth, (req, res) => {
  res.json({ unread: db.unreadNotifCount(req.orgId, req.userId) });
});

/* ------------------------------------------------------------------ */
/* Org settings & colleagues (admin manages; everyone can view) */
app.patch('/api/org', requireAuth, requireRole('admin'), (req, res) => {
  const { name, fundraisingGoal } = req.body || {};
  const goal = fundraisingGoal !== undefined ? parseFloat(fundraisingGoal) : undefined;
  if (fundraisingGoal !== undefined && (isNaN(goal) || goal < 0)) {
    return res.status(400).json({ error: 'Fundraising goal must be a positive number.' });
  }
  const org = db.updateOrg(req.orgId, { name, fundraisingGoal: goal });
  res.json({ orgName: org.name, fundraising: db.fundraisingSummary(req.orgId) });
});

app.get('/api/colleagues', requireAuth, (req, res) => {
  res.json({ colleagues: db.listColleagues(req.orgId) });
});

app.get('/api/invites', requireAuth, requireRole('admin'), (req, res) => {
  res.json({ invites: db.listInvites(req.orgId) });
});
app.post('/api/invites', requireAuth, requireRole('admin'), (req, res) => {
  const { role } = req.body || {};
  if (!db.ROLES.includes(role)) return res.status(400).json({ error: `Role must be one of: ${db.ROLES.join(', ')}` });
  const invite = db.createInvite(req.orgId, role, req.userId);
  res.status(201).json({ invite });
});
app.delete('/api/invites/:code', requireAuth, requireRole('admin'), (req, res) => {
  const ok = db.revokeInvite(req.orgId, req.params.code);
  if (!ok) return res.status(404).json({ error: 'Invite not found or already used.' });
  res.json({ revoked: true });
});

/* ------------------------------------------------------------------ */
/* Volunteers */
app.post('/api/volunteers', requireAuth, (req, res) => {
  const { name, role, skills, email, phone } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const skillList = Array.isArray(skills) ? skills
    : (typeof skills === 'string' && skills.trim()) ? skills.split(',').map(s => s.trim()).filter(Boolean)
    : ['General'];
  const roleFinal = role || 'Volunteer';
  const volunteer = db.insertVolunteer(req.orgId, {
    name, role: roleFinal, skills: skillList, tags: ['Field'], email, phone,
    timeline: [{ icon: 'user', color: 'blue', title: `Joined as ${roleFinal}`, sub: 'Just now' }],
  });
  const activity = db.addActivity(req.orgId, { icon: 'user', color: 'purple', title: `${name} joined NGOConnect AI`, sub: null, actorId: volunteer.userId || req.userId, actorName: name });
  broadcast(req.orgId, 'update', { kind: 'volunteer-added' }, req.userId);
  res.status(201).json({ volunteer, activity });
});

// Volunteer-selection picker: active + suspended volunteers with search-friendly fields
// (email/phone/skills), for the "+" picker in Task Assignment, Events, etc.
app.get('/api/volunteers/all', requireAuth, requireRole('admin', 'manager'), (req, res) => {
  res.json({ volunteers: db.listVolunteersForManagement(req.orgId), onlineUserIds: onlineUserIds(req.orgId) });
});

app.post('/api/volunteers/:id/log-hours', requireAuth, (req, res) => {
  const hours = parseFloat(req.body && req.body.hours);
  if (!hours || hours <= 0) return res.status(400).json({ error: 'Enter a valid number of hours.' });
  // Volunteers can only log their own hours — not anyone else's.
  const actingUser = db.getUser(req.userId);
  if (actingUser.role === 'volunteer') {
    const own = db.linkedVolunteerForUser(req.orgId, req.userId);
    if (!own || own.id !== req.params.id) return res.status(403).json({ error: 'You can only log your own hours.' });
  }
  const volunteer = db.logVolunteerHours(req.orgId, req.params.id, hours);
  if (!volunteer) return res.status(404).json({ error: 'Volunteer not found.' });
  db.bumpOrgMonthly(req.orgId, { hoursDelta: hours });
  const activity = db.addActivity(req.orgId, { icon: 'clock', color: 'green', title: `${volunteer.name} logged ${hours}h`, sub: null, actorId: req.userId, actorName: actingUser.name, actorAvatar: actingUser.avatar_data });
  const org = db.getOrg(req.orgId);
  broadcast(req.orgId, 'update', { kind: 'hours-logged' }, req.userId);
  res.json({ volunteer, activity, monthly: { volunteerHours: Math.round(org.volunteer_hours * 10) / 10, eventsOrganized: org.events_organized } });
});

// Emergency contact / blood group / medical notes / DOB / availability — admin or manager can edit any volunteer's record.
app.patch('/api/volunteers/:id', requireAuth, requireRole('admin', 'manager'), (req, res) => {
  const { emergencyContact, bloodGroup, medicalNotes, dob, availability } = req.body || {};
  const volunteer = db.updateVolunteerDetails(req.orgId, req.params.id, { emergencyContact, bloodGroup, medicalNotes, dob, availability });
  if (!volunteer) return res.status(404).json({ error: 'Volunteer not found.' });
  broadcast(req.orgId, 'update', { kind: 'volunteer-updated' }, req.userId);
  res.json({ volunteer });
});
// Starring a volunteer — admin only ("Admin can star important volunteers").
app.post('/api/volunteers/:id/favorite', requireAuth, requireRole('admin'), (req, res) => {
  const volunteer = db.toggleFavoriteVolunteer(req.orgId, req.params.id);
  if (!volunteer) return res.status(404).json({ error: 'Volunteer not found.' });
  broadcast(req.orgId, 'update', { kind: 'volunteer-updated' }, req.userId);
  res.json({ volunteer });
});
// Suspend — blocks login + new task assignments, but stays visible in the list with a badge.
app.post('/api/volunteers/:id/suspend', requireAuth, requireRole('admin', 'manager'), (req, res) => {
  const volunteer = db.suspendVolunteer(req.orgId, req.params.id);
  if (!volunteer) return res.status(404).json({ error: 'Volunteer not found.' });
  db.addActivity(req.orgId, { icon: 'user', color: 'orange', title: `${volunteer.name} was suspended`, sub: null, actorId: req.userId });
  if (volunteer.userId) {
    db.addNotification(req.orgId, volunteer.userId, { type: 'info', title: 'Your account has been suspended.', link: 'home' });
    pushToUser(req.orgId, volunteer.userId, 'notification', { title: 'Account suspended' });
  }
  broadcast(req.orgId, 'update', { kind: 'volunteer-status-changed' }, req.userId);
  res.json({ volunteer });
});
app.post('/api/volunteers/:id/reactivate', requireAuth, requireRole('admin', 'manager'), (req, res) => {
  const volunteer = db.reactivateVolunteer(req.orgId, req.params.id);
  if (!volunteer) return res.status(404).json({ error: 'Volunteer not found.' });
  db.addActivity(req.orgId, { icon: 'user', color: 'green', title: `${volunteer.name} was reactivated`, sub: null, actorId: req.userId });
  if (volunteer.userId) {
    db.addNotification(req.orgId, volunteer.userId, { type: 'info', title: 'Your account has been reactivated.', link: 'home' });
    pushToUser(req.orgId, volunteer.userId, 'notification', { title: 'Account reactivated' });
    pushToUser(req.orgId, volunteer.userId, 'status-change', { status: 'active' });
  }
  broadcast(req.orgId, 'update', { kind: 'volunteer-status-changed' }, req.userId);
  res.json({ volunteer });
});
// Remove — full removal from active lists + loses access; history is kept for auditing.
app.delete('/api/volunteers/:id', requireAuth, requireRole('admin', 'manager'), (req, res) => {
  const existing = db.listVolunteersForManagement(req.orgId).find(v => v.id === req.params.id);
  const ok = db.removeVolunteer(req.orgId, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Volunteer not found.' });
  if (existing) db.addActivity(req.orgId, { icon: 'user', color: 'red', title: `${existing.name} was removed`, sub: null, actorId: req.userId });
  if (existing && existing.userId) pushToUser(req.orgId, existing.userId, 'status-change', { status: 'removed' });
  broadcast(req.orgId, 'update', { kind: 'volunteer-status-changed' }, req.userId);
  res.json({ removed: true });
});

/* ------------------------------------------------------------------ */
/* Events (admin + manager can create/edit; coordinator can view & join only) */
app.post('/api/events', requireAuth, requireRole('admin', 'manager'), (req, res) => {
  const { title, location, date, dateIso } = req.body || {};
  if (!title || !location || !date) return res.status(400).json({ error: 'Title, location, and date are required.' });
  const event = db.insertEvent(req.orgId, { title, location, date, dateIso });
  db.bumpOrgMonthly(req.orgId, { eventsDelta: 1 });
  const activity = db.addActivity(req.orgId, { icon: 'calendar', color: 'purple', title: `New event: ${title}`, sub: location, actorId: req.userId });
  broadcast(req.orgId, 'update', { kind: 'event-added' }, req.userId);
  res.status(201).json({ event, activity });
});

app.post('/api/events/:id/join', requireAuth, (req, res) => {
  const event = db.joinEvent(req.orgId, req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  const activity = db.addActivity(req.orgId, { icon: 'calendar', color: 'green', title: `New signup for ${event.title}`, sub: event.location, actorId: req.userId });
  broadcast(req.orgId, 'update', { kind: 'event-updated' }, req.userId);
  res.json({ event, activity });
});

// Cover photo update — admin/manager only. Image comes in as a data: URL (base64), capped ~4MB.
app.patch('/api/events/:id/image', requireAuth, requireRole('admin', 'manager'), (req, res) => {
  const { imageData } = req.body || {};
  if (imageData && (typeof imageData !== 'string' || !imageData.startsWith('data:image/') || imageData.length > 6_000_000)) {
    return res.status(400).json({ error: 'Image must be a data URL under ~4MB.' });
  }
  const event = db.updateEventImage(req.orgId, req.params.id, imageData || null);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  broadcast(req.orgId, 'update', { kind: 'event-updated' }, req.userId);
  res.json({ event });
});

// Gallery photo — anyone can add a photo (crowd-sourced event gallery); admin/manager can also set a video link.
app.post('/api/events/:id/photos', requireAuth, (req, res) => {
  const { imageData } = req.body || {};
  if (!imageData || typeof imageData !== 'string' || !imageData.startsWith('data:image/') || imageData.length > 6_000_000) {
    return res.status(400).json({ error: 'Image must be a data URL under ~4MB.' });
  }
  const event = db.addEventPhoto(req.orgId, req.params.id, imageData);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  broadcast(req.orgId, 'update', { kind: 'event-updated' }, req.userId);
  res.status(201).json({ event });
});
app.patch('/api/events/:id/video', requireAuth, requireRole('admin', 'manager'), (req, res) => {
  const { videoUrl } = req.body || {};
  if (videoUrl && !/^https?:\/\//i.test(videoUrl)) return res.status(400).json({ error: 'Video URL must start with http(s)://' });
  const event = db.setEventVideoUrl(req.orgId, req.params.id, videoUrl || null);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  broadcast(req.orgId, 'update', { kind: 'event-updated' }, req.userId);
  res.json({ event });
});
// Pin an event to the top — admin only.
app.post('/api/events/:id/pin', requireAuth, requireRole('admin'), (req, res) => {
  const event = db.togglePinEvent(req.orgId, req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found.' });
  broadcast(req.orgId, 'update', { kind: 'event-updated' }, req.userId);
  res.json({ event, events: db.listEvents(req.orgId) });
});

/* ------------------------------------------------------------------ */
/* Event comments & feedback — any signed-in colleague can comment/rate */
app.get('/api/events/:id/comments', requireAuth, (req, res) => {
  res.json({ comments: db.listEventComments(req.orgId, req.params.id) });
});
app.post('/api/events/:id/comments', requireAuth, (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Comment cannot be empty.' });
  const user = db.getUser(req.userId);
  const comment = db.addEventComment(req.orgId, req.params.id, user.name, text.trim());
  broadcast(req.orgId, 'update', { kind: 'event-comment' }, req.userId);
  res.status(201).json({ comment });
});
app.get('/api/events/:id/feedback', requireAuth, (req, res) => {
  res.json(db.eventFeedbackSummary(req.orgId, req.params.id));
});
app.post('/api/events/:id/feedback', requireAuth, (req, res) => {
  const rating = parseInt(req.body && req.body.rating, 10);
  const { comment } = req.body || {};
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1-5.' });
  const user = db.getUser(req.userId);
  db.addEventFeedback(req.orgId, req.params.id, req.userId, user.name, rating, comment);
  res.status(201).json(db.eventFeedbackSummary(req.orgId, req.params.id));
});

/* ------------------------------------------------------------------ */
/* Donations / fundraising — any signed-in colleague can log a donation (transparency by design) */
app.get('/api/fundraising', requireAuth, (req, res) => {
  res.json(db.fundraisingSummary(req.orgId));
});
app.post('/api/donations', requireAuth, (req, res) => {
  const { amount, donorName, campaign, eventId, note } = req.body || {};
  const amt = parseFloat(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Enter a valid donation amount.' });
  const before = db.fundraisingSummary(req.orgId);
  const donation = db.addDonation(req.orgId, { amount: amt, donorName, campaign, eventId, note, loggedBy: req.userId });
  const label = donorName ? `Donation from ${donorName}` : 'New donation logged';
  const activity = db.addActivity(req.orgId, { icon: 'heart', color: 'green', title: `${label}: $${amt}`, sub: campaign || null, actorId: req.userId });
  const after = db.fundraisingSummary(req.orgId);
  // One-time celebration when a fundraising goal is newly crossed.
  if (after.goal > 0 && before.totalRaised < after.goal && after.totalRaised >= after.goal) {
    db.notifyRole(req.orgId, ['admin', 'manager'], { type: 'goal', title: '🎉 Fundraising goal reached!', body: `Total raised just crossed $${after.goal}.` });
    broadcast(req.orgId, 'update', { kind: 'goal-reached' }, req.userId);
  }
  broadcast(req.orgId, 'update', { kind: 'donation-added' }, req.userId);
  res.status(201).json({ donation, activity, fundraising: after });
});

/* ------------------------------------------------------------------ */
/* NGO Goals (non-monetary, e.g. "Plant 500 Trees") — admin creates/sets; any role can log progress */
app.post('/api/goals', requireAuth, requireRole('admin'), (req, res) => {
  const { title, unit, target, deadline, parentId } = req.body || {};
  const t = parseFloat(target);
  if (!title || !t || t <= 0) return res.status(400).json({ error: 'Title and a positive target are required.' });
  const goal = db.addGoal(req.orgId, { title, unit, target: t, deadline: deadline || null, parentId: parentId || null });
  db.addActivity(req.orgId, { icon: 'target', color: 'purple', title: `New campaign: ${goal.title}`, sub: `Goal: ${t} ${unit || ''}`.trim(), actorId: req.userId });
  broadcast(req.orgId, 'update', { kind: 'goal-added' }, req.userId);
  res.status(201).json({ goal });
});
app.get('/api/goals/:id', requireAuth, (req, res) => {
  const goal = db.getGoal(req.orgId, req.params.id);
  if (!goal) return res.status(404).json({ error: 'Goal not found.' });
  const updates = db.listGoalUpdates(req.params.id);
  res.json({
    goal, updates, contributors: db.goalContributors(req.params.id),
    milestones: db.goalMilestones(goal, updates), comments: db.listGoalComments(req.params.id),
  });
});
app.post('/api/goals/:id/comments', requireAuth, (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Comment text is required.' });
  const goal = db.getGoal(req.orgId, req.params.id);
  if (!goal) return res.status(404).json({ error: 'Goal not found.' });
  const actingUser = db.getUser(req.userId);
  const comment = db.addGoalComment(req.orgId, req.params.id, { actorId: req.userId, actorName: actingUser.name, text: text.trim() });
  broadcast(req.orgId, 'update', { kind: 'goal-comment', goalId: req.params.id }, req.userId);
  res.status(201).json({ comment });
});
app.patch('/api/goals/:id', requireAuth, (req, res) => {
  const current = parseFloat(req.body && req.body.current);
  const note = req.body && req.body.note;
  if (isNaN(current) || current < 0) return res.status(400).json({ error: 'Enter a valid progress value.' });
  const before = db.getGoal(req.orgId, req.params.id);
  const actingUser = db.getUser(req.userId);
  const goal = db.updateGoalProgress(req.orgId, req.params.id, current, { note, actorId: req.userId, actorName: actingUser.name });
  if (!goal) return res.status(404).json({ error: 'Goal not found.' });
  if (before && before.current < before.target && goal.current >= goal.target) {
    db.notifyRole(req.orgId, ['admin', 'manager'], { type: 'goal', title: `🎉 "${goal.title}" reached its goal!`, body: `${goal.current}/${goal.target} ${goal.unit}.` });
    db.addActivity(req.orgId, { icon: 'target', color: 'green', title: `🎉 "${goal.title}" goal reached!`, sub: `${goal.current}/${goal.target} ${goal.unit}` });
    broadcast(req.orgId, 'update', { kind: 'goal-reached' }, req.userId);
  }
  broadcast(req.orgId, 'update', { kind: 'goal-updated' }, req.userId);
  res.json({ goal });
});
app.delete('/api/goals/:id', requireAuth, requireRole('admin'), (req, res) => {
  const ok = db.deleteGoal(req.orgId, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Goal not found.' });
  res.json({ deleted: true });
});

/* ------------------------------------------------------------------ */
/* Announcements — admin posts, everyone sees */
app.post('/api/announcements', requireAuth, requireRole('admin'), (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Announcement text is required.' });
  const announcement = db.addAnnouncement(req.orgId, text.trim(), req.userId);
  const activity = db.addActivity(req.orgId, { icon: 'megaphone', color: 'purple', title: 'New announcement', sub: text.trim().slice(0, 60), actorId: req.userId });
  db.notifyRole(req.orgId, db.ROLES, { type: 'announcement', title: 'New announcement', body: text.trim().slice(0, 120), link: 'announcements' }, req.userId);
  broadcast(req.orgId, 'update', { kind: 'announcement-added' }, req.userId);
  res.status(201).json({ announcement, activity });
});
app.delete('/api/announcements/:id', requireAuth, requireRole('admin'), (req, res) => {
  const ok = db.deleteAnnouncement(req.orgId, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Announcement not found.' });
  res.json({ deleted: true });
});

/* ------------------------------------------------------------------ */
/* Tasks — any role can create/assign; the assignee drives the 4-state
 * accept → in-progress → completed workflow, admins/managers can also
 * update or cancel a task they're overseeing. */
app.post('/api/tasks', requireAuth, (req, res) => {
  const { title, assigneeId, priority, deadline, notes, fileData, fileName, recurrence, dependsOn } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'Task title is required.' });
  if (fileData && (typeof fileData !== 'string' || fileData.length > 4_000_000)) {
    return res.status(400).json({ error: 'Attached file must be under ~3MB.' });
  }
  if (assigneeId && !db.listVolunteers(req.orgId).some(v => v.id === assigneeId)) {
    return res.status(400).json({ error: 'That volunteer is inactive and can\'t be assigned a task. Reactivate them first.' });
  }
  const task = db.addTask(req.orgId, { title: title.trim(), assigneeId, priority, deadline, notes, fileData, fileName, recurrence, dependsOn });
  db.addActivity(req.orgId, { icon: 'checksquare', color: 'blue', title: `New task: ${task.title}`, sub: task.assigneeName || null, actorId: req.userId });
  // Assigning a task doubles as an in-app message to the assignee.
  if (task.assigneeId) {
    const vol = db.listVolunteers(req.orgId).find(v => v.id === task.assigneeId);
    if (vol && vol.userId) {
      const actingUser = db.getUser(req.userId);
      db.addNotification(req.orgId, vol.userId, {
        type: 'task', title: `You have been assigned a new task by ${actingUser.name}.`,
        body: `${task.title}${task.deadline ? ` — Due ${task.deadline}` : ''}`, link: 'tasks',
      });
      pushToUser(req.orgId, vol.userId, 'notification', { title: 'New task assigned' });
    }
  }
  broadcast(req.orgId, 'update', { kind: 'task-added' }, req.userId);
  res.status(201).json({ task });
});
app.post('/api/tasks/:id/dependencies', requireAuth, (req, res) => {
  const { dependsOnId } = req.body || {};
  if (!dependsOnId) return res.status(400).json({ error: 'dependsOnId is required.' });
  const result = db.addDependency(req.orgId, req.params.id, dependsOnId);
  if (result.error) return res.status(400).json({ error: result.error });
  broadcast(req.orgId, 'update', { kind: 'task-updated' }, req.userId);
  res.status(201).json({ ok: true, task: db.listTasks(req.orgId).find(t => t.id === req.params.id) });
});
app.delete('/api/tasks/:id/dependencies/:dependsOnId', requireAuth, (req, res) => {
  db.removeDependency(req.orgId, req.params.id, req.params.dependsOnId);
  broadcast(req.orgId, 'update', { kind: 'task-updated' }, req.userId);
  res.json({ task: db.listTasks(req.orgId).find(t => t.id === req.params.id) });
});
app.get('/api/tasks/:id/comments', requireAuth, (req, res) => {
  res.json({ comments: db.listTaskComments(req.params.id) });
});
app.post('/api/tasks/:id/comments', requireAuth, (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Comment text is required.' });
  const existing = db.listTasks(req.orgId).find(t => t.id === req.params.id);
  if (!existing) return res.status(404).json({ error: 'Task not found.' });
  const actingUser = db.getUser(req.userId);
  const comment = db.addTaskComment(req.orgId, req.params.id, { actorId: req.userId, actorName: actingUser.name, text: text.trim() });
  broadcast(req.orgId, 'update', { kind: 'task-comment', taskId: req.params.id }, req.userId);
  res.status(201).json({ comment });
});
app.get('/api/workload', requireAuth, (req, res) => {
  res.json({ workload: db.workloadSummary(req.orgId) });
});
app.get('/api/calendar', requireAuth, (req, res) => {
  res.json({ items: db.calendarFeed(req.orgId) });
});
app.get('/api/attachments', requireAuth, (req, res) => {
  const { entityType, entityId } = req.query;
  if (!entityType || !entityId) return res.status(400).json({ error: 'entityType and entityId are required.' });
  res.json({ attachments: db.listAttachments(req.orgId, entityType, entityId) });
});
app.post('/api/attachments', requireAuth, (req, res) => {
  const { entityType, entityId, fileName, fileData, mimeType } = req.body || {};
  if (!entityType || !entityId || !fileName || !fileData) return res.status(400).json({ error: 'entityType, entityId, fileName and fileData are required.' });
  if (typeof fileData !== 'string' || fileData.length > 6_000_000) return res.status(400).json({ error: 'Attached file must be under ~4.5MB.' });
  const actingUser = db.getUser(req.userId);
  const attachment = db.addAttachment(req.orgId, { entityType, entityId, fileName, fileData, mimeType, uploadedBy: req.userId, uploadedByName: actingUser.name });
  broadcast(req.orgId, 'update', { kind: 'attachment-added', entityType, entityId }, req.userId);
  res.status(201).json({ attachment });
});
app.delete('/api/attachments/:id', requireAuth, (req, res) => {
  const ok = db.deleteAttachment(req.orgId, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Attachment not found.' });
  res.json({ deleted: true });
});
app.get('/api/events/:id/milestones', requireAuth, (req, res) => {
  res.json({ milestones: db.listMilestones(req.orgId, req.params.id) });
});
app.post('/api/events/:id/milestones', requireAuth, requireRole('admin', 'manager'), (req, res) => {
  const { title } = req.body || {};
  if (!title || !title.trim()) return res.status(400).json({ error: 'Milestone title is required.' });
  const milestone = db.addMilestone(req.orgId, req.params.id, title.trim());
  broadcast(req.orgId, 'update', { kind: 'milestone-added', eventId: req.params.id }, req.userId);
  res.status(201).json({ milestone });
});
app.patch('/api/milestones/:id', requireAuth, (req, res) => {
  const { status } = req.body || {};
  const milestone = db.updateMilestoneStatus(req.orgId, req.params.id, status);
  if (!milestone) return res.status(400).json({ error: 'Invalid milestone or status.' });
  broadcast(req.orgId, 'update', { kind: 'milestone-updated' }, req.userId);
  res.json({ milestone });
});
app.delete('/api/milestones/:id', requireAuth, requireRole('admin', 'manager'), (req, res) => {
  const ok = db.deleteMilestone(req.orgId, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Milestone not found.' });
  broadcast(req.orgId, 'update', { kind: 'milestone-deleted' }, req.userId);
  res.json({ deleted: true });
});
app.patch('/api/tasks/:id', requireAuth, (req, res) => {
  const { status } = req.body || {};
  if (!db.TASK_STATUSES.includes(status)) {
    return res.status(400).json({ error: `Status must be one of: ${db.TASK_STATUSES.join(', ')}` });
  }
  const existing = db.listTasks(req.orgId).find(t => t.id === req.params.id);
  if (!existing) return res.status(404).json({ error: 'Task not found.' });
  if ((status === 'in_progress' || status === 'completed') && existing.blocked) {
    return res.status(400).json({ error: 'This task is blocked by an unfinished dependency.' });
  }
  const task = db.updateTaskStatus(req.orgId, req.params.id, status);
  // A completed recurring task immediately spins up its next occurrence.
  let spawned = null;
  if (status === 'completed' && task.recurrence && task.recurrence !== 'none') {
    spawned = db.spawnNextRecurrence(req.orgId, task);
  }
  // Assignee accepting/progressing/completing notifies whoever's overseeing (admin/manager);
  // an admin/manager changing status (e.g. reassigning) notifies the assignee.
  const actingUser = db.getUser(req.userId);
  const assigneeVol = existing.assigneeId ? db.listVolunteers(req.orgId).find(v => v.id === existing.assigneeId) : null;
  const isAssignee = assigneeVol && assigneeVol.userId === req.userId;
  if (isAssignee) {
    db.notifyRole(req.orgId, ['admin', 'manager'], { type: 'task', title: `${actingUser.name} marked "${task.title}" as ${status.replace('_', ' ')}`, link: 'tasks' });
  } else if (assigneeVol && assigneeVol.userId) {
    db.addNotification(req.orgId, assigneeVol.userId, { type: 'task', title: `Task "${task.title}" updated to ${status.replace('_', ' ')}`, link: 'tasks' });
    pushToUser(req.orgId, assigneeVol.userId, 'notification', { title: 'Task updated' });
  }
  broadcast(req.orgId, 'update', { kind: 'task-updated' }, req.userId);
  res.json({ task, spawned });
});
app.delete('/api/tasks/:id', requireAuth, (req, res) => {
  const ok = db.deleteTask(req.orgId, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Task not found.' });
  broadcast(req.orgId, 'update', { kind: 'task-deleted' }, req.userId);
  res.json({ deleted: true });
});

/* ------------------------------------------------------------------ */
/* Attendance — volunteers check in/out; admin sees the report (report = the same list, everyone can view for transparency) */
app.post('/api/attendance/check-in', requireAuth, (req, res) => {
  const { volunteerId, eventId } = req.body || {};
  if (!volunteerId) return res.status(400).json({ error: 'volunteerId is required.' });
  const actingUser = db.getUser(req.userId);
  if (actingUser.role === 'volunteer') {
    const own = db.linkedVolunteerForUser(req.orgId, req.userId);
    if (!own || own.id !== volunteerId) return res.status(403).json({ error: 'You can only check yourself in.' });
  }
  const result = db.checkIn(req.orgId, volunteerId, eventId);
  if (result && result.error === 'already_checked_in') return res.status(409).json({ error: 'This volunteer is already checked in.' });
  broadcast(req.orgId, 'update', { kind: 'attendance-changed' }, req.userId);
  res.status(201).json({ attendance: result });
});
app.post('/api/attendance/:id/check-out', requireAuth, (req, res) => {
  const actingUser = db.getUser(req.userId);
  if (actingUser.role === 'volunteer') {
    const own = db.linkedVolunteerForUser(req.orgId, req.userId);
    const record = db.listAttendance(req.orgId).find(a => a.id === req.params.id);
    if (!own || !record || record.volunteerId !== own.id) return res.status(403).json({ error: 'You can only check yourself out.' });
  }
  const result = db.checkOut(req.orgId, req.params.id);
  if (!result) return res.status(404).json({ error: 'Attendance record not found.' });
  if (result.error === 'already_checked_out') return res.status(409).json({ error: 'This record is already checked out.' });
  broadcast(req.orgId, 'update', { kind: 'attendance-changed' }, req.userId);
  res.json({ attendance: result, monthly: (() => { const o = db.getOrg(req.orgId); return { volunteerHours: Math.round(o.volunteer_hours * 10) / 10, eventsOrganized: o.events_organized }; })() });
});
app.get('/api/attendance', requireAuth, (req, res) => {
  res.json({ attendance: db.listAttendance(req.orgId) });
});

/* ------------------------------------------------------------------ */
/* Messaging — direct messages and simple group conversations between colleagues */
app.get('/api/conversations', requireAuth, (req, res) => {
  res.json({ conversations: db.listConversations(req.orgId, req.userId) });
});
app.post('/api/conversations', requireAuth, (req, res) => {
  const { memberIds, title, isGroup } = req.body || {};
  const ids = Array.isArray(memberIds) ? memberIds.filter(Boolean) : [];
  if (ids.length === 0) return res.status(400).json({ error: 'At least one other member is required.' });
  // Direct message: reuse an existing 1:1 conversation instead of creating duplicates.
  if (!isGroup && ids.length === 1) {
    const convo = db.findOrCreateDirectConversation(req.orgId, req.userId, ids[0], req.userId);
    return res.status(201).json({ conversation: convo });
  }
  const convo = db.createConversation(req.orgId, [req.userId, ...ids], { isGroup: true, title: title || 'Group chat', createdBy: req.userId });
  for (const memberId of ids) {
    pushToUser(req.orgId, memberId, 'update', { kind: 'conversation-added' });
  }
  res.status(201).json({ conversation: convo });
});
app.get('/api/conversations/:id/messages', requireAuth, (req, res) => {
  if (!db.isConversationMember(req.params.id, req.userId)) return res.status(403).json({ error: 'Not a member of this conversation.' });
  db.markConversationRead(req.params.id, req.userId);
  // Let the other member(s) know their messages were just read, so an open thread on
  // their screen can flip single ticks to double ticks without needing a refresh.
  const memberIds = db.conversationMemberIds(req.params.id);
  for (const memberId of memberIds) {
    if (memberId === req.userId) continue;
    pushToUser(req.orgId, memberId, 'read-receipt', { conversationId: req.params.id, readAt: new Date().toISOString() });
  }
  res.json({ messages: db.listMessages(req.params.id, req.orgId), otherLastReadAt: db.conversationReadInfo(req.params.id, req.userId) });
});
app.post('/api/conversations/:id/messages', requireAuth, (req, res) => {
  const { text } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Message text is required.' });
  if (!db.isConversationMember(req.params.id, req.userId)) return res.status(403).json({ error: 'Not a member of this conversation.' });
  const sender = db.getUser(req.userId);
  const message = db.addMessage(req.params.id, req.orgId, req.userId, sender.name, text.trim());
  const memberIds = db.conversationMemberIds(req.params.id);
  for (const memberId of memberIds) {
    if (memberId === req.userId) continue;
    pushToUser(req.orgId, memberId, 'message', { conversationId: req.params.id, message });
  }
  res.status(201).json({ message });
});
// Typing indicator — fire-and-forget; the frontend calls this (debounced) while the
// person is actively typing, and other members show a "X is typing…" bubble briefly.
app.post('/api/conversations/:id/typing', requireAuth, (req, res) => {
  if (!db.isConversationMember(req.params.id, req.userId)) return res.status(403).json({ error: 'Not a member of this conversation.' });
  const sender = db.getUser(req.userId);
  const memberIds = db.conversationMemberIds(req.params.id);
  for (const memberId of memberIds) {
    if (memberId === req.userId) continue;
    pushToUser(req.orgId, memberId, 'typing', { conversationId: req.params.id, userId: req.userId, name: sender.name });
  }
  res.json({ ok: true });
});

/* ------------------------------------------------------------------ */
/* Nova AI chat proxy — keeps the Gemini API key server-side only. */
app.post('/api/nova/chat', requireAuth, async (req, res) => {
  const messages = Array.isArray(req.body && req.body.messages) ? req.body.messages : [];
  const org = db.getOrg(req.orgId);
  const volunteers = db.listVolunteers(req.orgId);
  const events = db.listEvents(req.orgId);

  if (!GEMINI_API_KEY) {
    return res.json({ reply: localFallback(messages, org, volunteers, events), offline: true });
  }

  try {
    const system = buildNovaSystemPrompt(org, volunteers, events);
    // Gemini has no separate "assistant" role — it uses 'model'. System instructions go
    // in their own top-level field rather than as a message.
    const geminiContents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.text }],
    }));
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: geminiContents,
        generationConfig: { maxOutputTokens: 1000 },
      }),
    });
    if (!response.ok) throw new Error(`Gemini API error ${response.status}`);
    const data = await response.json();
    const candidate = (data.candidates || [])[0];
    const text = ((candidate && candidate.content && candidate.content.parts) || []).map(p => p.text || '').join('\n').trim();
    if (!text) throw new Error('Empty response');
    res.json({ reply: text, offline: false });
  } catch (err) {
    console.error('[nova] falling back to local reply:', err.message);
    res.json({ reply: localFallback(messages, org, volunteers, events), offline: true });
  }
});

function buildNovaSystemPrompt(org, volunteers, events) {
  const vNames = volunteers.map(v => `${v.name} (${v.role}, ${v.hours}h)`).join('; ') || 'none yet';
  const eNames = events.map(e => `${e.title} at ${e.location} on ${e.date}`).join('; ') || 'none yet';
  return `You are Nova, an AI copilot embedded inside an NGO management app called NGOConnect AI, helping the team at "${org.name}". ` +
    `Be warm, concise, and practical. Use the organization's real data when relevant. ` +
    `Current volunteers: ${vNames}. Current events: ${eNames}. ` +
    `This month: ${org.volunteer_hours}h logged, ${org.events_organized} events organized, ${volunteers.length} active volunteers. ` +
    `When asked for an email, report, or social post, write the actual finished copy, not a description of what you would write. Keep responses reasonably concise.`;
}
function localFallback(messages, org, volunteers, events) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  const t = (lastUser && lastUser.text || '').toLowerCase();
  const upcoming = events.filter(e => e.status === 'upcoming').length;
  if (t.includes('report')) {
    return `Monthly Impact Report — ${org.name}\n\n` +
      `• Volunteer hours logged: ${org.volunteer_hours}h\n` +
      `• Events organized: ${org.events_organized}\n` +
      `• Active volunteers: ${volunteers.length}\n` +
      `• Upcoming in next 30 days: ${upcoming}\n\n` +
      `Highlights: ${volunteers.slice(0, 2).map(v => `${v.name} contributed ${v.hours}h as ${v.role}`).join('; ')}.\n\n` +
      `(No GEMINI_API_KEY configured on the server — this is a templated draft. Add one to .env for real AI-written copy.)`;
  }
  if (t.includes('email') || t.includes('donor') || t.includes('thank')) {
    return `Subject: Thank you for believing in our work\n\n` +
      `Dear friend,\n\nYour generosity this month helped power ${volunteers.length} volunteers across ${org.events_organized} events, ` +
      `totaling ${org.volunteer_hours} hours of hands-on impact. Because of you, our community is stronger.\n\n` +
      `With gratitude,\n${org.name}\n\n(No GEMINI_API_KEY configured on the server — this is a templated draft.)`;
  }
  if (t.includes('social') || t.includes('post') || t.includes('instagram') || t.includes('linkedin')) {
    return `🌍 Big things happening at ${org.name}! This month our ${volunteers.length} volunteers logged ${org.volunteer_hours} hours ` +
      `across ${org.events_organized} events. Want to join us? Link in bio. 💜\n\n#Volunteer #CommunityImpact\n\n(No GEMINI_API_KEY configured on the server.)`;
  }
  return `Nova here — no GEMINI_API_KEY is configured on the server yet, so I can't have a full conversation. ` +
    `Quick facts: ${org.name} has ${volunteers.length} active volunteers, ${org.volunteer_hours}h logged this month, and ${upcoming} upcoming events. ` +
    `Add your key to .env to unlock real AI replies.`;
}

/* ------------------------------------------------------------------ */
// SPA fallback: any non-API GET serves index.html (keeps deep-linking simple).
app.get(/^(?!\/api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`NGOConnect AI running at http://localhost:${PORT}`);
  if (!GEMINI_API_KEY) {
    console.log('  ↳ GEMINI_API_KEY not set — Nova will use templated offline replies. See .env.example.');
  }
});
