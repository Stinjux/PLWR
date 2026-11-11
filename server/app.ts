import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { serveStatic } from '@hono/node-server/serve-static';
import { DateTime } from 'luxon';
import { all, get, run, uid, nowIso, parseJson, tx } from './db.ts';
import { config, pushEnabled, pushState } from './config.ts';
import {
  createSession,
  destroySession,
  hashPassword,
  verifyPassword,
  rateLimit,
  requireUser,
  rowToUser,
  userFromRequest,
  verifyToken,
  loadUser,
  DEFAULT_SETTINGS,
  type User,
} from './auth.ts';
import { dayBounds, today, toUtcIso } from './time.ts';
import {
  createEvent,
  deleteOccurrence,
  getOccurrence,
  listOccurrences,
  listUnscheduled,
  parseOccId,
  updateOccurrence,
  type EventInput,
} from './services/events.ts';
import { proposePlan } from './services/planner.ts';
import { goalHistory, goalProgress, listEntries, rowToGoal, upsertBlockEntry, formatGoalValue } from './services/goals.ts';
import {
  budgetSummary,
  getTransaction,
  insertTransaction,
  listBudgets,
  listCategories,
  listTransactions,
  setAllocation,
  updateTransaction,
  categoryRemaining,
  learnMerchant,
} from './services/budget.ts';
import { cancelDraft, confirmDraft, createDraft, DuplicateError, getDraft, listPendingDrafts, pendingCount, updateDraft } from './services/drafts.ts';
import { addMessage, handleChat, listMessages } from './services/chat.ts';
import { processImport, serializeImport } from './services/imports.ts';
import { computeReminders, deliver, snooze } from './services/reminders.ts';
import { createDefaults, createSamples, deleteSamples, hasSamples } from './services/seed.ts';
import { VisionError } from './vision/types.ts';
import {
  COLORS,
  acceptInvite,
  allowedParticipants,
  canEdit,
  colorOf,
  createInvite,
  describeInvite,
  isRole,
  nextColor,
  occurrenceFor,
  ownerOf,
  people,
  removeMember,
  revokeInvite,
  setMemberRole,
  setShareLink,
  sharingState,
  visibleOccurrences,
} from './services/sharing.ts';
import {
  authUrl,
  clearCredentials,
  disconnect as disconnectGoogle,
  googleStatus,
  handleCallback as googleCallback,
  queueSync,
  saveCredentials,
  setExport,
  syncUser,
} from './services/google.ts';
import { formatMoney } from './time.ts';

export const app = new Hono();

// ---------- En-têtes de sécurité ----------
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'same-origin');
  c.header('X-Frame-Options', 'DENY');
  c.header('Permissions-Policy', 'geolocation=(), microphone=()');
  c.header(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  if (c.req.path.startsWith('/api/')) c.header('Cache-Control', 'no-store');
});

app.onError((err, c) => {
  if (err instanceof DuplicateError) return c.json({ error: 'Doublon possible : cette dépense semble déjà enregistrée.', duplicates: err.hints, code: 'duplicate' }, 409);
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  if (err instanceof VisionError) return c.json({ error: err.message, manualEntry: true }, 422);
  const msg = err instanceof Error ? err.message : 'Erreur';
  if (!/introuvable|invalide|doit|manque|choisis|déjà|positif|inconnue|refus|importe|connect|google/i.test(msg)) console.error(err);
  return c.json({ error: msg }, /introuvable/i.test(msg) ? 404 : 400);
});

const body = async <T = any>(c: any): Promise<T> => {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HTTPException(400, { message: 'JSON invalide' });
  }
};

// ---------- Authentification ----------
app.get('/api/auth/status', (c) => {
  const hasUsers = Boolean(get('SELECT 1 FROM users LIMIT 1'));
  return c.json({ hasUsers, signupOpen: !hasUsers || config.allowSignup });
});

app.post('/api/auth/register', async (c) => {
  if (c.req.header('x-plwr') !== '1') throw new HTTPException(403, { message: 'Requête refusée' });
  const hasUsers = Boolean(get('SELECT 1 FROM users LIMIT 1'));
  const b = await body<{ email: string; password: string; name?: string; samples?: boolean; invite?: string }>(c);
  // Une invitation valide permet de créer un compte même quand les inscriptions sont fermées
  const invite = b.invite ? describeInvite(b.invite) : null;
  if (b.invite && !invite) throw new HTTPException(400, { message: 'Invitation invalide ou expirée' });
  if (hasUsers && !config.allowSignup && !invite) throw new HTTPException(403, { message: 'Les inscriptions sont fermées' });
  const email = String(b.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HTTPException(400, { message: 'Courriel invalide' });
  if (String(b.password || '').length < 10) throw new HTTPException(400, { message: 'Le mot de passe doit contenir au moins 10 caractères' });
  if (get('SELECT 1 FROM users WHERE email = ?', email)) throw new HTTPException(400, { message: 'Ce courriel est déjà utilisé' });
  if (invite?.email && invite.email !== email) throw new HTTPException(400, { message: `Cette invitation est destinée à ${invite.email}` });
  const id = uid();
  run(
    'INSERT INTO users (id, email, name, password_hash, timezone, settings, created_at) VALUES (?,?,?,?,?,?,?)',
    id,
    email,
    String(b.name || '').trim().slice(0, 80),
    hashPassword(b.password),
    config.defaultTimezone,
    JSON.stringify({ ...DEFAULT_SETTINGS, color: nextColor() }),
    nowIso(),
  );
  createDefaults(id);
  if (b.invite) acceptInvite(b.invite, id);
  if (b.samples !== false) createSamples(loadUser(id)!);
  createSession(c, id);
  return c.json({ ok: true });
});

app.post('/api/auth/login', async (c) => {
  if (c.req.header('x-plwr') !== '1') throw new HTTPException(403, { message: 'Requête refusée' });
  const b = await body<{ email: string; password: string }>(c);
  const email = String(b.email || '').trim().toLowerCase();
  const ip = c.req.header('x-forwarded-for')?.split(',')[0] || 'local';
  if (!rateLimit(`${ip}:${email}`)) throw new HTTPException(429, { message: 'Trop de tentatives, réessaie dans 15 minutes' });
  const row = get('SELECT * FROM users WHERE email = ?', email);
  if (!row || !verifyPassword(String(b.password || ''), row.password_hash)) throw new HTTPException(401, { message: 'Courriel ou mot de passe incorrect' });
  createSession(c, row.id);
  return c.json({ ok: true });
});

app.post('/api/auth/logout', (c) => {
  destroySession(c);
  return c.json({ ok: true });
});

// ---------- Invitation à un agenda (lecture publique : nom du propriétaire et rôle seulement) ----------
app.get('/api/invites/:token', (c) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0] || 'local';
  if (!rateLimit(`invite:${ip}`, 60)) throw new HTTPException(429, { message: 'Trop de tentatives, réessaie plus tard' });
  const d = describeInvite(c.req.param('token'));
  if (!d) throw new HTTPException(404, { message: 'Invitation invalide ou expirée' });
  return c.json(d);
});

// ---------- Retour de l'écran de consentement Google (navigation du navigateur, cookie de session) ----------
app.get('/api/google/callback', async (c) => {
  const back = (q: string) => c.redirect(`/reglages/google?${q}`);
  const u = userFromRequest(c);
  if (!u) return c.redirect('/?google=session');
  const err = c.req.query('error');
  if (err) return back(`erreur=${encodeURIComponent(err === 'access_denied' ? 'Tu as refusé l’accès sur l’écran de Google.' : `Google : ${err}`)}`);
  try {
    await googleCallback(u.id, c.req.query('code') || '', c.req.query('state') || '');
    syncUser(u.id).catch(() => {});
    return back('ok=1');
  } catch (e) {
    return back(`erreur=${encodeURIComponent(e instanceof Error ? e.message : 'Erreur Google')}`);
  }
});

// ---------- Action « Reporter » d'une notification (jeton signé, sans cookie) ----------
app.post('/api/push/snooze', async (c) => {
  const b = await body<{ token: string; minutes?: number }>(c);
  const t = verifyToken<{ u: string; n: string }>(b.token);
  if (!t) throw new HTTPException(401, { message: 'Lien expiré' });
  const user = loadUser(t.u);
  if (!user) throw new HTTPException(401, { message: 'Lien expiré' });
  const minutes = Math.min(24 * 60, Math.max(5, Number(b.minutes) || user.settings.snoozeMinutes || 10));
  const s = snooze(user.id, t.n, minutes);
  return c.json({ ok: true, fireAt: s.fireAt, minutes });
});

// ---------- Tout le reste exige une session ----------
const api = new Hono();
api.use('*', requireUser);

const U = (c: any): User => c.get('user');

api.get('/me', (c) => {
  const u = U(c);
  return c.json({
    user: { id: u.id, email: u.email, name: u.name, timezone: u.timezone, color: colorOf({ id: u.id, settings: JSON.stringify(u.settings) }) },
    settings: u.settings,
    push: { enabled: pushEnabled(), error: pushState.error || null, publicKey: pushEnabled() ? config.push.publicKey : null, subscriptions: get<{ n: number }>('SELECT COUNT(*) n FROM push_subscriptions WHERE user_id = ?', u.id)!.n },
    vision: { provider: config.vision.provider, configured: config.vision.provider !== 'anthropic' || Boolean(config.vision.anthropicKey), redactCardNumbers: config.vision.redactCardNumbers },
    hasSamples: hasSamples(u.id),
    today: today(u.timezone),
  });
});

api.patch('/me/settings', async (c) => {
  const u = U(c);
  const b = await body<any>(c);
  const s = { ...u.settings };
  const hhmm = (v: any) => (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v) ? v : undefined);
  if (hhmm(b.dayStart)) s.dayStart = b.dayStart;
  if (hhmm(b.dayEnd)) s.dayEnd = b.dayEnd;
  if (b.bufferMinutes !== undefined) s.bufferMinutes = Math.max(0, Math.min(60, Number(b.bufferMinutes) || 0));
  if (Array.isArray(b.breaks)) s.breaks = b.breaks.filter((x: any) => hhmm(x.start) && hhmm(x.end)).map((x: any) => ({ label: String(x.label || 'Pause').slice(0, 40), start: x.start, end: x.end }));
  if (b.quietHours) s.quietHours = { enabled: Boolean(b.quietHours.enabled), start: hhmm(b.quietHours.start) || s.quietHours.start, end: hhmm(b.quietHours.end) || s.quietHours.end };
  if (b.defaultReminderMinutes !== undefined) s.defaultReminderMinutes = Math.max(0, Number(b.defaultReminderMinutes) || 0);
  if (b.snoozeMinutes !== undefined) s.snoozeMinutes = Math.max(5, Number(b.snoozeMinutes) || 10);
  if (b.keepImages !== undefined) s.keepImages = Boolean(b.keepImages);
  if (b.color !== undefined && (COLORS as readonly string[]).includes(b.color)) (s as any).color = b.color;
  if (typeof b.name === 'string') run('UPDATE users SET name = ? WHERE id = ?', b.name.trim().slice(0, 80), u.id);
  if (b.simulateVisionError !== undefined) (s as any).simulateVisionError = Boolean(b.simulateVisionError);
  run('UPDATE users SET settings = ? WHERE id = ?', JSON.stringify(s), u.id);
  return c.json({ settings: s });
});

// ---------- Aujourd'hui ----------
api.get('/today', (c) => {
  const u = U(c);
  const d = today(u.timezone);
  const { start, end } = dayBounds(d, u.timezone);
  const nowS = new Date().toISOString();
  const occ = listOccurrences(u.id, u.timezone, start, end);
  const upcoming = listOccurrences(u.id, u.timezone, nowS, DateTime.now().plus({ days: 14 }).toUTC().toISO()!).filter((o) => o.kind === 'fixed' && o.status === 'active' && o.start! >= nowS);
  const unscheduled = listUnscheduled(u.id, d);
  const tasks = [...occ.filter((o) => o.kind === 'flexible'), ...unscheduled.filter((o) => o.planDate === d || (o.dueAt && o.dueAt < end))];
  const focus = tasks.filter((t) => t.focusDate === d);
  const priorities = [...focus, ...tasks.filter((t) => t.focusDate !== d && t.status === 'active').sort((a, b) => a.priority - b.priority || (a.dueAt || 'z').localeCompare(b.dueAt || 'z'))].slice(0, 3);
  const goals = all('SELECT * FROM goals WHERE user_id = ? AND archived = 0 ORDER BY created_at', u.id).map(rowToGoal);
  const plan = proposePlan(u.id, u.timezone, u.settings, d);
  return c.json({
    date: d,
    nextEvent: upcoming[0] || null,
    priorities,
    tasks,
    agenda: occ,
    goals: goals.map((g) => ({ ...g, progress: goalProgress(g, u.timezone, d) })).filter((g) => g.metric === 'check' || g.period !== 'once' || !g.progress.completed),
    pendingDrafts: pendingCount(u.id),
    overload: { overloaded: plan.overloaded, freeMinutes: plan.freeMinutes, neededMinutes: plan.neededMinutes, postponed: plan.postponed.length },
  });
});

// ---------- Agenda ----------
api.get('/events', (c) => {
  const u = U(c);
  const from = c.req.query('from'), to = c.req.query('to');
  if (!from || !to) throw new HTTPException(400, { message: 'Paramètres from/to requis' });
  const occurrences = visibleOccurrences(u, toUtcIso(from), toUtcIso(to));
  const unscheduled = listUnscheduled(u.id).map((o) => ({ ...o, canEdit: true, redacted: false }));
  return c.json({ occurrences, unscheduled, people: people(u.id) });
});

/** Propriétaire de l'élément, en vérifiant que u peut le modifier. */
function editableOwner(u: User, id: string): string {
  const ownerId = ownerOf(id);
  const o = ownerId ? occurrenceFor(u.id, id) : undefined;
  if (!ownerId || !o) throw new HTTPException(404, { message: 'Élément introuvable' });
  if (o.source === 'google') throw new HTTPException(403, { message: 'Cet événement vient de Google Agenda : modifie-le dans Google Agenda, il se mettra à jour ici.' });
  if (!canEdit(u.id, ownerId)) throw new HTTPException(403, { message: 'Tu peux consulter cet agenda, mais pas le modifier' });
  return ownerId;
}

function cleanSharing(u: User, ownerId: string, b: EventInput & { ownerId?: string }) {
  delete b.ownerId;
  b.participantIds = allowedParticipants(u.id, ownerId, b.participantIds);
  if (b.visibility !== undefined && b.visibility !== 'busy') b.visibility = 'details';
  // Les objectifs appartiennent au propriétaire de l'agenda : on ne les touche pas depuis l'agenda d'un autre
  if (ownerId !== u.id) delete b.goalIds;
}

api.get('/people', (c) => c.json(people(U(c).id)));

api.post('/events', async (c) => {
  const u = U(c);
  const b = await body<EventInput & { ownerId?: string }>(c);
  const ownerId = b.ownerId ? String(b.ownerId) : u.id;
  if (!canEdit(u.id, ownerId)) throw new HTTPException(403, { message: 'Tu ne peux pas ajouter dans cet agenda' });
  cleanSharing(u, ownerId, b);
  const owner = ownerId === u.id ? u : loadUser(ownerId)!;
  if (b.reminders === undefined && b.start) b.reminders = [owner.settings.defaultReminderMinutes];
  const created = createEvent(ownerId, b);
  queueSync(ownerId);
  return c.json(occurrenceFor(u.id, created.id), 201);
});

function withReminders(u: User, occId: string) {
  const o = occurrenceFor(u.id, occId);
  if (!o) throw new HTTPException(404, { message: 'Élément introuvable' });
  if (o.ownerId !== u.id && !o.participantIds.includes(u.id)) return { ...o, nextReminders: [] };
  const now = new Date().toISOString();
  const horizon = DateTime.now().plus({ days: 60 }).toUTC().toISO()!;
  const reminders = computeReminders(u, now, horizon).filter((r) => r.refId === o.id || r.refId === o.eventId);
  return { ...o, nextReminders: reminders.slice(0, 5).map((r) => ({ fireAt: r.fireAt, title: r.title, deferredByQuietHours: r.deferredByQuietHours, kind: r.kind })) };
}

api.get('/events/:id', (c) => c.json(withReminders(U(c), c.req.param('id'))));

api.patch('/events/:id', async (c) => {
  const u = U(c);
  const b = await body<EventInput>(c);
  const scope = c.req.query('scope') === 'all' ? 'all' : 'this';
  const ownerId = editableOwner(u, c.req.param('id'));
  cleanSharing(u, ownerId, b);
  const o = updateOccurrence(ownerId, c.req.param('id'), b, scope);
  queueSync(ownerId);
  return c.json(withReminders(u, o.id));
});

api.delete('/events/:id', (c) => {
  const u = U(c);
  const ownerId = editableOwner(u, c.req.param('id'));
  deleteOccurrence(ownerId, c.req.param('id'), c.req.query('scope') === 'all' ? 'all' : 'this');
  queueSync(ownerId);
  return c.json({ ok: true });
});

// ---------- Google Agenda ----------
api.get('/google/status', (c) => c.json(googleStatus(U(c).id)));

/** Identifiants OAuth importés par la personne (ID client + code secret, ou fichier JSON lu côté navigateur). */
api.put('/google/credentials', async (c) => {
  const b = await body<{ clientId: string; clientSecret: string }>(c);
  saveCredentials(U(c).id, b.clientId, b.clientSecret);
  return c.json(googleStatus(U(c).id));
});

api.delete('/google/credentials', async (c) => {
  await disconnectGoogle(U(c).id);
  clearCredentials(U(c).id);
  return c.json(googleStatus(U(c).id));
});

/** Ouvre l'écran de consentement de Google. */
api.get('/google/connect', (c) => c.redirect(authUrl(U(c).id)));

api.post('/google/sync', async (c) => {
  const u = U(c);
  const r = await syncUser(u.id);
  if (!r) throw new HTTPException(400, { message: 'Google Agenda n’est pas connecté' });
  return c.json({ result: r, status: googleStatus(u.id) });
});

api.patch('/google/settings', async (c) => {
  const b = await body<{ export?: boolean }>(c);
  if (b.export !== undefined) setExport(U(c).id, Boolean(b.export));
  queueSync(U(c).id);
  return c.json(googleStatus(U(c).id));
});

api.post('/google/disconnect', async (c) => {
  await disconnectGoogle(U(c).id);
  return c.json(googleStatus(U(c).id));
});

// ---------- Partage de l'agenda ----------
api.get('/sharing', (c) => c.json(sharingState(U(c).id)));

api.post('/sharing/invites', async (c) => {
  const u = U(c);
  const b = await body<{ email: string; role?: string }>(c);
  return c.json(createInvite(u.id, String(b.email || ''), isRole(b.role) ? b.role : 'view'), 201);
});

api.delete('/sharing/invites/:id', (c) => {
  revokeInvite(U(c).id, c.req.param('id'));
  return c.json({ ok: true });
});

api.post('/sharing/link', async (c) => {
  const b = await body<{ enabled: boolean }>(c);
  return c.json({ link: setShareLink(U(c).id, Boolean(b.enabled)) });
});

api.patch('/sharing/members/:id', async (c) => {
  const b = await body<{ role: string }>(c);
  if (!isRole(b.role)) throw new HTTPException(400, { message: 'Rôle invalide' });
  setMemberRole(U(c).id, c.req.param('id'), b.role);
  return c.json(sharingState(U(c).id));
});

/** Retirer quelqu'un de mon agenda. */
api.delete('/sharing/members/:id', (c) => {
  removeMember(U(c).id, c.req.param('id'));
  return c.json(sharingState(U(c).id));
});

/** Quitter l'agenda de quelqu'un d'autre. */
api.delete('/sharing/shared/:ownerId', (c) => {
  removeMember(c.req.param('ownerId'), U(c).id);
  return c.json(sharingState(U(c).id));
});

api.post('/invites/:token/accept', (c) => {
  const u = U(c);
  return c.json(acceptInvite(c.req.param('token'), u.id));
});

api.post('/events/:id/focus', async (c) => {
  const u = U(c);
  const b = await body<{ on: boolean }>(c);
  const d = today(u.timezone);
  if (b.on) {
    const n = listUnscheduled(u.id).concat(listOccurrences(u.id, u.timezone, dayBounds(d, u.timezone).start, dayBounds(d, u.timezone).end)).filter((o) => o.focusDate === d).length;
    if (n >= 3) throw new HTTPException(400, { message: 'Tu as déjà trois priorités aujourd’hui' });
  }
  return c.json(updateOccurrence(u.id, c.req.param('id'), { focusDate: b.on ? d : null }, 'this'));
});

/** Terminer un bloc : statut « fait » + résultats réels pour chaque objectif lié. */
api.post('/events/:id/complete', async (c) => {
  const u = U(c);
  const id = c.req.param('id');
  const b = await body<{ results?: { goalId: string; value: number; planned?: number | null }[]; note?: string; undo?: boolean }>(c);
  const o = getOccurrence(u.id, id);
  if (!o) throw new HTTPException(404, { message: 'Élément introuvable' });
  const { eventId } = parseOccId(id);
  const occKey = o.recurrenceId || o.start || 'unscheduled';
  const date = o.start ? DateTime.fromISO(o.start).setZone(u.timezone).toISODate()! : today(u.timezone);
  tx(() => {
    if (b.undo) {
      run('DELETE FROM goal_entries WHERE event_id = ? AND occurrence = ? AND user_id = ?', eventId, occKey, u.id);
    } else {
      for (const r of b.results || []) {
        if (!o.goalIds.includes(r.goalId)) continue;
        const v = Number(r.value);
        if (!Number.isFinite(v) || v < 0) throw new Error('Résultat invalide');
        upsertBlockEntry(u.id, r.goalId, eventId, occKey, date, v, r.planned ?? null, b.note);
      }
    }
  });
  const updated = updateOccurrence(u.id, id, { status: b.undo ? 'active' : 'done' }, 'this');
  const goals = o.goalIds.map((g) => rowToGoal(get('SELECT * FROM goals WHERE id = ?', g))).map((g) => {
    const p = goalProgress(g, u.timezone, date);
    return { id: g.id, title: g.title, progress: p, text: `${formatGoalValue(g, p.done)} sur ${formatGoalValue(g, g.target)} · reste ${formatGoalValue(g, p.remaining)}` };
  });
  return c.json({ occurrence: updated, goals });
});

// ---------- Réorganiser ma journée ----------
api.post('/planner/propose', async (c) => {
  const u = U(c);
  const b = await body<{ date?: string; keepBreaks?: string[]; dayStart?: string; dayEnd?: string }>(c);
  return c.json(proposePlan(u.id, u.timezone, u.settings, b.date || today(u.timezone), b));
});

api.post('/planner/apply', async (c) => {
  const u = U(c);
  const b = await body<{ changes: { id: string; start: string; end: string }[]; postponed?: { id: string; start?: string | null; end?: string | null; planDate?: string | null }[] }>(c);
  const applied: string[] = [];
  for (const ch of b.changes || []) {
    updateOccurrence(u.id, ch.id, { start: ch.start, end: ch.end }, 'this');
    applied.push(ch.id);
  }
  for (const p of b.postponed || []) {
    const o = getOccurrence(u.id, p.id);
    if (!o) continue;
    if (p.start && p.end) updateOccurrence(u.id, p.id, { start: p.start, end: p.end }, 'this');
    else if (!o.recurrenceId) updateOccurrence(u.id, p.id, { start: null, planDate: p.planDate || DateTime.now().setZone(u.timezone).plus({ days: 1 }).toISODate() }, 'this');
    applied.push(p.id);
  }
  return c.json({ ok: true, applied });
});

// ---------- Objectifs ----------
api.get('/goals', (c) => {
  const u = U(c);
  const rows = all('SELECT * FROM goals WHERE user_id = ? AND archived = ? ORDER BY created_at', u.id, c.req.query('archived') === '1' ? 1 : 0).map(rowToGoal);
  return c.json(rows.map((g) => ({ ...g, progress: goalProgress(g, u.timezone), linkedBlocks: get<{ n: number }>('SELECT COUNT(*) n FROM goal_links WHERE goal_id = ?', g.id)!.n })));
});

function goalInput(b: any) {
  const metric = ['check', 'quantity', 'duration', 'amount'].includes(b.metric) ? b.metric : 'quantity';
  const period = ['once', 'daily', 'weekly', 'monthly'].includes(b.period) ? b.period : 'once';
  const target = metric === 'check' ? Number(b.target) || 1 : Number(b.target);
  if (!b.title?.trim()) throw new Error('Donne un titre à l’objectif');
  if (!(target > 0)) throw new Error('La cible doit être positive');
  return { title: String(b.title).trim().slice(0, 120), metric, target, unit: String(b.unit || '').slice(0, 20), period, deadline: b.deadline || null, reminder_days: b.reminderDays ?? null, start_date: b.startDate || null };
}

api.post('/goals', async (c) => {
  const u = U(c);
  const g = goalInput(await body(c));
  const id = uid();
  run(
    'INSERT INTO goals (id, user_id, title, metric, target, unit, period, start_date, deadline, reminder_days, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    id, u.id, g.title, g.metric, g.target, g.unit, g.period, g.start_date || today(u.timezone), g.deadline, g.reminder_days, nowIso(),
  );
  return c.json(rowToGoal(get('SELECT * FROM goals WHERE id = ?', id)), 201);
});

api.get('/goals/:id', (c) => {
  const u = U(c);
  const r = get('SELECT * FROM goals WHERE id = ? AND user_id = ?', c.req.param('id'), u.id);
  if (!r) throw new HTTPException(404, { message: 'Objectif introuvable' });
  const g = rowToGoal(r);
  const links = all('SELECT e.* FROM goal_links l JOIN events e ON e.id = l.event_id WHERE l.goal_id = ?', g.id).map((e) => ({ id: e.id, title: e.title, kind: e.kind, recurring: Boolean(e.rrule), start: e.start_at, durationMin: e.duration_min }));
  return c.json({
    ...g,
    progress: goalProgress(g, u.timezone),
    history: { week: goalHistory(g, u.timezone, 'week'), month: goalHistory(g, u.timezone, 'month', 6) },
    entries: listEntries(g.id),
    links,
  });
});

api.patch('/goals/:id', async (c) => {
  const u = U(c);
  const r = get('SELECT * FROM goals WHERE id = ? AND user_id = ?', c.req.param('id'), u.id);
  if (!r) throw new HTTPException(404, { message: 'Objectif introuvable' });
  const b = await body<any>(c);
  if (b.archived !== undefined && Object.keys(b).length === 1) {
    run('UPDATE goals SET archived = ? WHERE id = ?', b.archived ? 1 : 0, r.id);
  } else {
    const g = goalInput({ ...rowToGoal(r), ...b });
    run('UPDATE goals SET title=?, metric=?, target=?, unit=?, period=?, deadline=?, reminder_days=? WHERE id = ?', g.title, g.metric, g.target, g.unit, g.period, g.deadline, g.reminder_days, r.id);
  }
  return c.json(rowToGoal(get('SELECT * FROM goals WHERE id = ?', r.id)));
});

api.delete('/goals/:id', (c) => {
  run('DELETE FROM goals WHERE id = ? AND user_id = ?', c.req.param('id'), U(c).id);
  return c.json({ ok: true });
});

api.post('/goals/:id/entries', async (c) => {
  const u = U(c);
  const g = get('SELECT * FROM goals WHERE id = ? AND user_id = ?', c.req.param('id'), u.id);
  if (!g) throw new HTTPException(404, { message: 'Objectif introuvable' });
  const b = await body<{ date?: string; value: number; note?: string }>(c);
  const v = Number(b.value);
  if (!Number.isFinite(v)) throw new Error('Valeur invalide');
  run('INSERT INTO goal_entries (id, user_id, goal_id, date, value, note, created_at) VALUES (?,?,?,?,?,?,?)', uid(), u.id, g.id, b.date || today(u.timezone), v, b.note || null, nowIso());
  return c.json({ progress: goalProgress(rowToGoal(g), u.timezone) }, 201);
});

api.delete('/goals/:id/entries/:entryId', (c) => {
  run('DELETE FROM goal_entries WHERE id = ? AND goal_id = ? AND user_id = ?', c.req.param('entryId'), c.req.param('id'), U(c).id);
  return c.json({ ok: true });
});

/** Cocher / décocher un objectif « à cocher » pour aujourd'hui. */
api.post('/goals/:id/check', async (c) => {
  const u = U(c);
  const g = get('SELECT * FROM goals WHERE id = ? AND user_id = ?', c.req.param('id'), u.id);
  if (!g) throw new HTTPException(404, { message: 'Objectif introuvable' });
  const d = today(u.timezone);
  const b = await body<{ checked: boolean }>(c);
  run('DELETE FROM goal_entries WHERE goal_id = ? AND date = ? AND event_id IS NULL', g.id, d);
  if (b.checked) run('INSERT INTO goal_entries (id, user_id, goal_id, date, value, created_at) VALUES (?,?,?,?,1,?)', uid(), u.id, g.id, d, nowIso());
  return c.json({ progress: goalProgress(rowToGoal(g), u.timezone) });
});

// ---------- Budget ----------
api.get('/budget/categories', (c) => c.json({ budgets: listBudgets(U(c).id), categories: listCategories(U(c).id) }));

api.post('/budget/categories', async (c) => {
  const u = U(c);
  const b = await body<{ budgetKey: string; grp: string; name: string; kind?: string; defaultAmountCents?: number; keywords?: string }>(c);
  const bud = get('SELECT id FROM budgets WHERE user_id = ? AND key = ?', u.id, b.budgetKey);
  if (!bud) throw new Error('Budget inconnu');
  if (!b.name?.trim()) throw new Error('Nom de catégorie requis');
  const id = uid();
  run('INSERT INTO categories (id, user_id, budget_id, grp, name, kind, default_amount_cents, keywords, sort) VALUES (?,?,?,?,?,?,?,?,99)', id, u.id, bud.id, (b.grp || b.name).trim(), b.name.trim(), b.kind === 'income' ? 'income' : 'expense', Math.max(0, Math.round(b.defaultAmountCents || 0)), b.keywords || '');
  return c.json({ id }, 201);
});

api.patch('/budget/categories/:id', async (c) => {
  const u = U(c);
  const cat = get('SELECT * FROM categories WHERE id = ? AND user_id = ?', c.req.param('id'), u.id);
  if (!cat) throw new HTTPException(404, { message: 'Catégorie introuvable' });
  const b = await body<any>(c);
  run(
    'UPDATE categories SET grp = ?, name = ?, default_amount_cents = ?, keywords = ?, archived = ? WHERE id = ?',
    b.grp ?? cat.grp,
    b.name ?? cat.name,
    b.defaultAmountCents ?? cat.default_amount_cents,
    b.keywords ?? cat.keywords,
    b.archived === undefined ? cat.archived : b.archived ? 1 : 0,
    cat.id,
  );
  return c.json({ ok: true });
});

api.get('/budget/summary', (c) => {
  const u = U(c);
  const month = c.req.query('month') || today(u.timezone).slice(0, 7);
  const view = (['perso', 'mondaix', 'all'].includes(c.req.query('view') || '') ? c.req.query('view') : 'all') as any;
  return c.json({ ...budgetSummary(u.id, month, view), pendingDrafts: pendingCount(u.id) });
});

/** Modifier une enveloppe en cours de mois (ce mois seulement, ou aussi les mois suivants). */
api.put('/budget/allocations', async (c) => {
  const u = U(c);
  const b = await body<{ categoryId: string; month: string; amountCents: number; applyToFuture?: boolean }>(c);
  const cat = get('SELECT * FROM categories WHERE id = ? AND user_id = ?', b.categoryId, u.id);
  if (!cat) throw new HTTPException(404, { message: 'Catégorie introuvable' });
  if (!/^\d{4}-\d{2}$/.test(b.month)) throw new Error('Mois invalide');
  setAllocation(cat.id, b.month, b.amountCents);
  if (b.applyToFuture) {
    run('UPDATE categories SET default_amount_cents = ? WHERE id = ?', Math.max(0, Math.round(b.amountCents)), cat.id);
    run('DELETE FROM allocations WHERE category_id = ? AND month > ?', cat.id, b.month);
  }
  return c.json(categoryRemaining(u.id, cat.id, b.month));
});

api.get('/transactions', (c) => {
  const u = U(c);
  return c.json(listTransactions(u.id, { month: c.req.query('month'), view: (c.req.query('view') as any) || 'all', categoryId: c.req.query('categoryId') }));
});

function txInputFrom(b: any) {
  return {
    date: b.date,
    merchant: b.merchant || '',
    amountCents: Math.round(Number(b.amountCents)),
    type: b.type,
    note: b.note ?? null,
    refundOf: b.refundOf ?? null,
    origAmountCents: b.origAmountCents ?? null,
    origCurrency: b.origCurrency ?? null,
    splits: (b.splits || []).map((s: any) => ({ categoryId: s.categoryId, amountCents: Math.round(Number(s.amountCents)) })),
  };
}

api.post('/transactions', async (c) => {
  const u = U(c);
  const b = await body<any>(c);
  const id = insertTransaction(u.id, { ...txInputFrom(b), source: 'manuel' });
  if (b.merchant) for (const s of b.splits || []) learnMerchant(u.id, b.merchant, s.categoryId);
  return c.json(getTransaction(u.id, id), 201);
});

api.get('/transactions/:id', (c) => {
  const t = getTransaction(U(c).id, c.req.param('id'));
  if (!t) throw new HTTPException(404, { message: 'Transaction introuvable' });
  return c.json(t);
});

api.patch('/transactions/:id', async (c) => {
  const u = U(c);
  const b = await body<any>(c);
  const existing = getTransaction(u.id, c.req.param('id'));
  if (!existing) throw new HTTPException(404, { message: 'Transaction introuvable' });
  updateTransaction(u.id, existing.id, txInputFrom({ ...existing, ...b }));
  if (b.merchant || b.splits) for (const s of b.splits || existing.splits) learnMerchant(u.id, b.merchant || existing.merchant, s.categoryId);
  return c.json(getTransaction(u.id, existing.id));
});

api.delete('/transactions/:id', (c) => {
  run('DELETE FROM transactions WHERE id = ? AND user_id = ?', c.req.param('id'), U(c).id);
  return c.json({ ok: true });
});

/** Remboursement lié à une transaction confirmée. */
api.post('/transactions/:id/refund', async (c) => {
  const u = U(c);
  const orig = getTransaction(u.id, c.req.param('id'));
  if (!orig) throw new HTTPException(404, { message: 'Transaction introuvable' });
  const b = await body<{ amountCents: number; date?: string; note?: string; categoryId?: string }>(c);
  const amount = Math.round(Number(b.amountCents));
  if (!(amount > 0)) throw new Error('Montant de remboursement invalide');
  if (amount > orig.amountCents - orig.refundedCents) throw new Error('Le remboursement dépasse le montant restant de la transaction');
  // Répartit le remboursement au prorata des catégories d'origine (ou sur une catégorie choisie)
  let splits = b.categoryId
    ? [{ categoryId: b.categoryId, amountCents: amount }]
    : orig.splits.map((s: any) => ({ categoryId: s.categoryId, amountCents: Math.floor((s.amountCents * amount) / orig.amountCents) }));
  const diff = amount - splits.reduce((s: number, x: any) => s + x.amountCents, 0);
  splits[0].amountCents += diff;
  splits = splits.filter((s: any) => s.amountCents > 0);
  const id = insertTransaction(u.id, { date: b.date || today(u.timezone), merchant: orig.merchant, amountCents: amount, type: 'refund', refundOf: orig.id, note: b.note || `Remboursement ${orig.merchant}`, splits, source: 'manuel' });
  return c.json(getTransaction(u.id, id), 201);
});

// Paiements récurrents
function nextDate(d: string, f: string): string {
  const x = DateTime.fromISO(d);
  return (f === 'weekly' ? x.plus({ weeks: 1 }) : f === 'biweekly' ? x.plus({ weeks: 2 }) : f === 'yearly' ? x.plus({ years: 1 }) : x.plus({ months: 1 })).toISODate()!;
}
const recOut = (u: User) => (r: any) => ({
  id: r.id, name: r.name, merchant: r.merchant, amountCents: r.amount_cents, categoryId: r.category_id, kind: r.kind, frequency: r.frequency,
  nextDate: r.next_date, reminderDays: r.reminder_days, active: Boolean(r.active), sample: Boolean(r.sample),
  categoryLabel: listCategories(u.id, true).find((c) => c.id === r.category_id)?.label || null,
});
api.get('/recurring', (c) => c.json(all('SELECT * FROM recurring WHERE user_id = ? ORDER BY next_date', U(c).id).map(recOut(U(c)))));
api.post('/recurring', async (c) => {
  const u = U(c);
  const b = await body<any>(c);
  if (!b.name || !(b.amountCents > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(b.nextDate || '')) throw new Error('Nom, montant et prochaine date requis');
  const id = uid();
  run(
    'INSERT INTO recurring (id, user_id, name, merchant, amount_cents, category_id, kind, frequency, next_date, reminder_days, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    id, u.id, b.name, b.merchant || b.name, Math.round(b.amountCents), b.categoryId || null, b.kind === 'income' ? 'income' : 'expense',
    ['weekly', 'biweekly', 'monthly', 'yearly'].includes(b.frequency) ? b.frequency : 'monthly', b.nextDate, b.reminderDays ?? null, nowIso(),
  );
  return c.json({ id }, 201);
});
api.patch('/recurring/:id', async (c) => {
  const u = U(c);
  const r = get('SELECT * FROM recurring WHERE id = ? AND user_id = ?', c.req.param('id'), u.id);
  if (!r) throw new HTTPException(404, { message: 'Paiement introuvable' });
  const b = await body<any>(c);
  run(
    'UPDATE recurring SET name=?, merchant=?, amount_cents=?, category_id=?, frequency=?, next_date=?, reminder_days=?, active=? WHERE id=?',
    b.name ?? r.name, b.merchant ?? r.merchant, b.amountCents ?? r.amount_cents, b.categoryId ?? r.category_id, b.frequency ?? r.frequency,
    b.nextDate ?? r.next_date, b.reminderDays === undefined ? r.reminder_days : b.reminderDays, b.active === undefined ? r.active : b.active ? 1 : 0, r.id,
  );
  return c.json(recOut(u)(get('SELECT * FROM recurring WHERE id = ?', r.id)));
});
api.delete('/recurring/:id', (c) => {
  run('DELETE FROM recurring WHERE id = ? AND user_id = ?', c.req.param('id'), U(c).id);
  return c.json({ ok: true });
});
/** Marquer un paiement récurrent comme payé (ou reçu) : crée la transaction et passe à la prochaine échéance. */
api.post('/recurring/:id/pay', async (c) => {
  const u = U(c);
  const r = get('SELECT * FROM recurring WHERE id = ? AND user_id = ?', c.req.param('id'), u.id);
  if (!r) throw new HTTPException(404, { message: 'Paiement introuvable' });
  if (!r.category_id) throw new Error('Associe une catégorie à ce paiement');
  const b = await body<{ date?: string; amountCents?: number; dueDate: string }>(c);
  if (b.dueDate !== r.next_date) return c.json({ ok: true, already: true }); // double pression
  const id = tx(() => {
    const t = insertTransaction(u.id, { date: b.date || today(u.timezone), merchant: r.merchant || r.name, amountCents: b.amountCents || r.amount_cents, type: r.kind === 'income' ? 'income' : 'expense', splits: [{ categoryId: r.category_id, amountCents: b.amountCents || r.amount_cents }], source: 'recurrent', recurringId: r.id });
    run('UPDATE recurring SET next_date = ? WHERE id = ?', nextDate(r.next_date, r.frequency), r.id);
    return t;
  });
  return c.json({ ok: true, transaction: getTransaction(u.id, id) });
});

/** Solde jusqu'à la prochaine paie (revenus prévus vs factures à venir). */
api.get('/budget/until-payday', (c) => {
  const u = U(c);
  const d = today(u.timezone);
  const pay = get("SELECT * FROM recurring WHERE user_id = ? AND active = 1 AND kind = 'income' ORDER BY next_date LIMIT 1", u.id);
  if (!pay) return c.json({ configured: false });
  const bills = all("SELECT * FROM recurring WHERE user_id = ? AND active = 1 AND kind = 'expense' AND next_date >= ? AND next_date < ?", u.id, d, pay.next_date);
  const month = d.slice(0, 7);
  const s = budgetSummary(u.id, month, 'perso');
  return c.json({
    configured: true,
    payday: pay.next_date,
    payName: pay.name,
    bills: bills.map((b) => ({ name: b.name, amountCents: b.amount_cents, date: b.next_date })),
    billsTotal: bills.reduce((x, b) => x + b.amount_cents, 0),
    envelopeRemaining: s.totals.remaining,
  });
});

// ---------- Fiches de dépenses (chatbot et import) ----------
api.get('/drafts', (c) => c.json(listPendingDrafts(U(c).id)));
api.post('/drafts', async (c) => {
  const u = U(c);
  const b = await body<any>(c);
  const d = createDraft(u, { date: b.date, merchant: b.merchant || null, amountCents: b.amountCents ? Math.round(b.amountCents) : null, categoryId: b.categoryId || null, budgetKey: b.budgetKey, type: b.type || 'expense', note: b.note || null, rawText: b.rawText }, { source: 'manuel', importId: b.importId || null });
  if (b.fromChat) addMessage(u.id, 'assistant', 'Fiche créée en saisie manuelle. Vérifie-la puis confirme.', { draftIds: [d.id] });
  return c.json(d, 201);
});
api.patch('/drafts/:id', async (c) => c.json(updateDraft(U(c).id, c.req.param('id'), await body(c))));
api.post('/drafts/:id/confirm', async (c) => {
  const u = U(c);
  const b = await body<{ force?: boolean }>(c).catch(() => ({}) as any);
  const r = confirmDraft(u, c.req.param('id'), { force: b.force });
  if (!r.already && r.draft && ['chat', 'manuel'].includes(r.draft.source) && c.req.query('from') === 'chat') {
    addMessage(u.id, 'assistant', `Dépense enregistrée : ${formatMoney(r.draft.fields.amountCents!)} · ${r.draft.fields.merchant || ''}. ${r.remaining.map((x) => x.text).join(' ')}`, { confirmation: { transactionId: r.transactionId, text: r.remaining.map((x) => x.text).join(' ') } });
  }
  return c.json(r);
});
api.post('/drafts/:id/cancel', (c) => c.json(cancelDraft(U(c), c.req.param('id'))));
api.post('/drafts/confirm-many', async (c) => {
  const u = U(c);
  const b = await body<{ ids: string[]; force?: boolean }>(c);
  const results = (b.ids || []).map((id) => {
    try {
      return { id, ok: true, ...confirmDraft(u, id, { force: b.force }) };
    } catch (e: any) {
      return { id, ok: false, error: e.message, duplicate: e instanceof DuplicateError, duplicates: e instanceof DuplicateError ? e.hints : undefined };
    }
  });
  const okCount = results.filter((r) => r.ok && !(r as any).already).length;
  if (c.req.query('from') === 'chat' && okCount) {
    const texts = [...new Set(results.flatMap((r: any) => (r.remaining || []).map((x: any) => x.text)))];
    addMessage(u.id, 'assistant', `${okCount} dépense(s) enregistrée(s). ${texts.join(' ')}`);
  }
  return c.json({ results });
});

// ---------- Chatbot ----------
api.get('/chat', (c) => c.json({ messages: listMessages(U(c).id), pendingDrafts: pendingCount(U(c).id) }));
api.post('/chat', async (c) => {
  const u = U(c);
  const b = await body<{ text: string; reply?: { value: string } }>(c);
  const text = String(b.text || '').trim().slice(0, 2000);
  if (!text) throw new Error('Message vide');
  const r = handleChat(u, text, b.reply);
  return c.json({ messages: listMessages(u.id) , new: r.messages.map((m) => m.id) });
});

async function readImage(c: any) {
  const form = await c.req.parseBody();
  const f = form['file'];
  if (!f || typeof f === 'string') throw new HTTPException(400, { message: 'Aucune image reçue' });
  const file = f as File;
  if (file.size > config.vision.maxUploadBytes) throw new HTTPException(413, { message: 'Image trop lourde' });
  return { bytes: Buffer.from(await file.arrayBuffer()), mime: file.type || 'image/jpeg', name: file.name };
}

api.post('/chat/upload', async (c) => {
  const u = U(c);
  const img = await readImage(c);
  const r = await processImport(u, img, 'chat');
  addMessage(u.id, 'user', '📷 Image jointe', { importId: r.import.id });
  if (r.error) {
    addMessage(u.id, 'assistant', `Je n’ai pas pu lire cette image : ${r.error}. Tu peux saisir la dépense manuellement.`, { importId: r.import.id, manualEntry: true });
  } else {
    const dupImport = r.import.duplicateOf ? ' Attention : cette image a déjà été importée ; les lignes déjà enregistrées sont signalées.' : '';
    const red = r.import.redactions ? ` ${r.import.redactions} numéro(s) de carte masqué(s) avant l’envoi.` : '';
    addMessage(u.id, 'assistant', `J’ai lu ${r.drafts.length} transaction(s). Corrige, retire ou confirme chaque ligne.${dupImport}${red}`, { importId: r.import.id, draftIds: r.drafts.map((d) => d.id) });
  }
  return c.json({ ...r, messages: listMessages(u.id) });
});

// ---------- Import par photo (depuis le budget) ----------
api.post('/imports', async (c) => {
  const u = U(c);
  return c.json(await processImport(u, await readImage(c), 'budget'));
});
api.get('/imports/:id', (c) => {
  const u = U(c);
  const r = get('SELECT * FROM imports WHERE id = ? AND user_id = ?', c.req.param('id'), u.id);
  if (!r) throw new HTTPException(404, { message: 'Import introuvable' });
  return c.json({ import: serializeImport(r), drafts: all('SELECT id FROM drafts WHERE import_id = ? ORDER BY line_index', r.id).map((d) => getDraft(u.id, d.id)) });
});
/** Image d'un import : accessible uniquement à son propriétaire, jamais mise en cache. */
api.get('/imports/:id/image', (c) => {
  const r = get('SELECT * FROM imports WHERE id = ? AND user_id = ?', c.req.param('id'), U(c).id);
  if (!r || !r.file_path || !fs.existsSync(r.file_path)) throw new HTTPException(404, { message: 'Image supprimée' });
  c.header('Content-Type', 'image/jpeg');
  c.header('Cache-Control', 'private, no-store');
  return c.body(fs.readFileSync(r.file_path));
});

// ---------- Rappels et notifications ----------
api.get('/reminders/upcoming', (c) => {
  const u = U(c);
  const days = Math.min(30, Number(c.req.query('days')) || 7);
  return c.json(computeReminders(u, new Date().toISOString(), DateTime.now().plus({ days }).toUTC().toISO()!));
});
api.get('/notifications', (c) => c.json(all('SELECT id, kind, title, body, url, fire_at, sent_at, delivered FROM notifications WHERE user_id = ? ORDER BY sent_at DESC LIMIT 50', U(c).id)));
api.post('/push/subscribe', async (c) => {
  const u = U(c);
  const b = await body<{ endpoint: string; keys: { p256dh: string; auth: string } }>(c);
  if (!b.endpoint?.startsWith('https://') || !b.keys?.p256dh || !b.keys?.auth) throw new Error('Abonnement invalide');
  run(
    `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, failures = 0`,
    uid(), u.id, b.endpoint, b.keys.p256dh, b.keys.auth, (c.req.header('user-agent') || '').slice(0, 200), nowIso(),
  );
  return c.json({ ok: true });
});
api.post('/push/unsubscribe', async (c) => {
  const b = await body<{ endpoint: string }>(c);
  run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', b.endpoint, U(c).id);
  return c.json({ ok: true });
});
api.post('/push/test', async (c) => {
  const u = U(c);
  const r = await deliver(u, { key: `test:${uid()}`, kind: 'test', title: '🔔 Notification de test', body: 'Les rappels fonctionnent sur cet appareil.', url: '/reglages', fireAt: nowIso() } as any);
  const id = r!.id;
  return c.json({ ...r, snoozeUrl: `/rappel?n=${id}` });
});
/** Reporter depuis l'app (iPhone : pas de boutons d'action dans les notifications). */
api.post('/notifications/:id/snooze', async (c) => {
  const u = U(c);
  const b = await body<{ minutes?: number }>(c);
  return c.json(snooze(u.id, c.req.param('id'), Math.max(5, Number(b.minutes) || u.settings.snoozeMinutes)));
});

// ---------- Exemples ----------
api.post('/samples/delete', (c) => {
  deleteSamples(U(c).id);
  return c.json({ ok: true });
});

app.route('/api', api);
app.all('/api/*', (c) => c.json({ error: 'Route inconnue' }, 404));

// ---------- Fichiers de l'interface (après « npm run build ») ----------
const dist = path.resolve('dist');
if (fs.existsSync(dist)) {
  app.use('/sw.js', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-cache');
    c.header('Service-Worker-Allowed', '/');
  });
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), dist) || '.' }));
  const indexHtml = () => fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  app.get('*', (c) => c.html(indexHtml()));
}

export { userFromRequest, rowToUser, parseJson };
