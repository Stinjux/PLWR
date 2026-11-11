import crypto from 'node:crypto';
import { all, get, run, uid, nowIso, parseJson, tx } from '../db.ts';
import { config } from '../config.ts';
import { loadUser, type User } from '../auth.ts';
import { getOccurrence, listOccurrences, parseOccId, type Occurrence } from './events.ts';

/**
 * Agenda partagé.
 * Chaque personne garde son propre agenda ; elle peut donner accès à d'autres comptes :
 *  - edit : voit tout, ajoute et modifie ;
 *  - view : voit tous les détails ;
 *  - busy : voit seulement les plages prises (« Occupé »).
 * Un événement peut aussi avoir des participants : ils le voient dans leur agenda (et en reçoivent les rappels)
 * même sans accès au reste de l'agenda de son propriétaire.
 */

export type Role = 'edit' | 'view' | 'busy';
export type Access = 'owner' | Role;
export const ROLES: Role[] = ['edit', 'view', 'busy'];
export const COLORS = ['blue', 'green', 'amber', 'plum', 'teal', 'rose'] as const;
export type Color = (typeof COLORS)[number];

export const isRole = (r: any): r is Role => ROLES.includes(r);

const INVITE_DAYS = 14;

export function displayName(row: { name?: string | null; email: string } | Record<string, any>) {
  return (row.name || '').trim() || row.email.split('@')[0];
}

/** Couleur choisie dans Réglages, sinon une couleur stable déduite de l'identifiant. */
export function colorOf(row: { id: string; settings?: string | null } | Record<string, any>): Color {
  const c = parseJson<any>(row.settings ?? null, {}).color;
  if (COLORS.includes(c)) return c;
  const h = crypto.createHash('sha256').update(row.id).digest()[0];
  return COLORS[h % COLORS.length];
}

/** Couleur pour un nouveau compte : la moins utilisée parmi les comptes existants. */
export function nextColor(): Color {
  const counts = new Map<Color, number>(COLORS.map((c) => [c, 0]));
  for (const u of all('SELECT id, settings FROM users')) {
    const c = colorOf(u);
    counts.set(c, (counts.get(c) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[1] - b[1])[0][0];
}

/** Accès de viewer à l'agenda de owner (null = aucun). */
export function accessTo(viewerId: string, ownerId: string): Access | null {
  if (viewerId === ownerId) return 'owner';
  const m = get<{ role: Role }>('SELECT role FROM calendar_members WHERE owner_id = ? AND member_id = ?', ownerId, viewerId);
  return m ? m.role : null;
}

export const canEdit = (viewerId: string, ownerId: string) => {
  const a = accessTo(viewerId, ownerId);
  return a === 'owner' || a === 'edit';
};

export type Person = {
  id: string;
  name: string;
  initial: string;
  color: Color;
  me: boolean;
  /** Mon accès à son agenda. */
  access: Access | null;
  /** Son accès à mon agenda. */
  memberRole: Role | null;
};

function toPerson(row: any, viewerId: string, access: Access | null, memberRole: Role | null): Person {
  const name = displayName(row);
  return { id: row.id, name, initial: name.charAt(0).toUpperCase(), color: colorOf(row), me: row.id === viewerId, access, memberRole };
}

/** Moi + les personnes dont je vois l'agenda + celles qui voient le mien. */
export function people(viewerId: string): Person[] {
  const me = get('SELECT * FROM users WHERE id = ?', viewerId);
  if (!me) return [];
  const map = new Map<string, Person>();
  map.set(me.id, toPerson(me, viewerId, 'owner', null));
  for (const r of all('SELECT u.*, m.role FROM calendar_members m JOIN users u ON u.id = m.owner_id WHERE m.member_id = ? ORDER BY m.created_at', viewerId)) {
    map.set(r.id, toPerson(r, viewerId, r.role, null));
  }
  for (const r of all('SELECT u.*, m.role FROM calendar_members m JOIN users u ON u.id = m.member_id WHERE m.owner_id = ? ORDER BY m.created_at', viewerId)) {
    const p = map.get(r.id);
    if (p) p.memberRole = r.role;
    else map.set(r.id, toPerson(r, viewerId, null, r.role));
  }
  return [...map.values()];
}

/** Garde seulement des participants que l'auteur ou le propriétaire connaissent. */
export function allowedParticipants(actorId: string, ownerId: string, ids: unknown): string[] | undefined {
  if (!Array.isArray(ids)) return undefined;
  const known = new Set([...people(actorId), ...people(ownerId)].map((p) => p.id));
  return [...new Set(ids.map(String))].filter((id) => id !== ownerId && known.has(id));
}

export type SharedOccurrence = Occurrence & { canEdit: boolean; redacted: boolean };

/** Ce que viewer peut voir d'une occurrence : « Occupé » si l'accès ou la visibilité de l'élément l'exige. */
export function decorate(o: Occurrence, viewerId: string, access: Access | null): SharedOccurrence {
  const isOwner = access === 'owner';
  const participant = o.participantIds.includes(viewerId);
  const edit = isOwner || access === 'edit';
  const redacted = !edit && !participant && (access === 'busy' || o.visibility === 'busy');
  // Un événement importé (Google, Outlook) se modifie à sa source (sinon la prochaine synchro l'écraserait)
  const base: SharedOccurrence = { ...o, canEdit: edit && o.source === 'plwr', redacted, goalIds: isOwner ? o.goalIds : [] };
  if (!redacted) return base;
  return { ...base, title: 'Occupé', location: null, notes: null, participantIds: [], reminders: [], dueReminders: [], focusDate: null };
}

function tzOf(userId: string) {
  return loadUser(userId)?.timezone || config.defaultTimezone;
}

/** Occurrences d'événements dont viewer est participant, dans des agendas auxquels il n'a pas accès autrement. */
export function participantOccurrences(viewerId: string, fromIso: string, toIso: string, skipOwners = new Set<string>([viewerId])): Occurrence[] {
  const rows = all<{ event_id: string; user_id: string }>(
    'SELECT p.event_id, e.user_id FROM event_participants p JOIN events e ON e.id = p.event_id WHERE p.user_id = ?',
    viewerId,
  );
  const byOwner = new Map<string, Set<string>>();
  for (const r of rows) {
    if (skipOwners.has(r.user_id)) continue;
    if (!byOwner.has(r.user_id)) byOwner.set(r.user_id, new Set());
    byOwner.get(r.user_id)!.add(r.event_id);
  }
  const out: Occurrence[] = [];
  for (const [ownerId, ids] of byOwner) {
    for (const o of listOccurrences(ownerId, tzOf(ownerId), fromIso, toIso)) {
      if (ids.has(o.seriesId || o.eventId)) out.push(o);
    }
  }
  return out;
}

/** Toutes les occurrences visibles par viewer entre from et to : son agenda, ceux partagés avec lui, et ses invitations. */
export function visibleOccurrences(viewer: User, fromIso: string, toIso: string): SharedOccurrence[] {
  const owners: { id: string; access: Access }[] = [
    { id: viewer.id, access: 'owner' },
    ...all<{ owner_id: string; role: Role }>('SELECT owner_id, role FROM calendar_members WHERE member_id = ?', viewer.id).map((r) => ({ id: r.owner_id, access: r.role })),
  ];
  const out = new Map<string, SharedOccurrence>();
  for (const o of owners) {
    const tz = o.id === viewer.id ? viewer.timezone : tzOf(o.id);
    for (const occ of listOccurrences(o.id, tz, fromIso, toIso)) out.set(occ.id, decorate(occ, viewer.id, o.access));
  }
  for (const occ of participantOccurrences(viewer.id, fromIso, toIso, new Set(owners.map((o) => o.id)))) {
    if (!out.has(occ.id)) out.set(occ.id, decorate(occ, viewer.id, null));
  }
  return [...out.values()].sort((a, b) => (a.start! < b.start! ? -1 : a.start! > b.start! ? 1 : 0));
}

/** Propriétaire de l'agenda qui contient l'élément id (occurrence ou événement). */
export function ownerOf(id: string): string | undefined {
  const { eventId } = parseOccId(id);
  return get<{ user_id: string }>('SELECT user_id FROM events WHERE id = ?', eventId)?.user_id;
}

/** Une occurrence telle que viewer a le droit de la voir (undefined si aucun accès). */
export function occurrenceFor(viewerId: string, id: string): SharedOccurrence | undefined {
  const ownerId = ownerOf(id);
  if (!ownerId) return undefined;
  const o = getOccurrence(ownerId, id);
  if (!o) return undefined;
  const access = accessTo(viewerId, ownerId);
  if (!access && !o.participantIds.includes(viewerId)) return undefined;
  return decorate(o, viewerId, access);
}

// ---------- Invitations ----------

const sign = (id: string) => crypto.createHmac('sha256', config.appSecret).update(`invite:${id}`).digest('base64url').slice(0, 32);
export const inviteToken = (id: string) => `${id}.${sign(id)}`;
export const inviteUrl = (id: string) => `${config.appUrl}/invitation/${inviteToken(id)}`;

/** Invitation valide pour ce jeton (signature, non révoquée, non expirée, pas encore utilisée si à usage unique). */
export function findInvite(token: string) {
  const [id, sig] = String(token || '').split('.');
  if (!id || !sig) return undefined;
  const expected = sign(id);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return undefined;
  const row = get('SELECT * FROM calendar_invites WHERE id = ? AND revoked_at IS NULL', id);
  if (!row) return undefined;
  if (row.expires_at && row.expires_at < nowIso()) return undefined;
  if (row.email && row.used_at) return undefined;
  return row;
}

export function describeInvite(token: string) {
  const inv = findInvite(token);
  if (!inv) return null;
  const owner = get('SELECT * FROM users WHERE id = ?', inv.owner_id);
  if (!owner) return null;
  return { ownerName: displayName(owner), ownerColor: colorOf(owner), role: inv.role as Role, email: inv.email as string | null };
}

export function createInvite(ownerId: string, email: string, role: Role) {
  const clean = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean)) throw new Error('Courriel invalide');
  const owner = get('SELECT email FROM users WHERE id = ?', ownerId);
  if (owner?.email === clean) throw new Error('C’est ton propre courriel');
  const existing = get('SELECT 1 FROM calendar_members m JOIN users u ON u.id = m.member_id WHERE m.owner_id = ? AND u.email = ?', ownerId, clean);
  if (existing) throw new Error('Cette personne a déjà accès à ton agenda');
  const max = config.maxUsers;
  const hasAccount = get('SELECT 1 FROM users WHERE email = ?', clean);
  if (!hasAccount && get<{ n: number }>('SELECT COUNT(*) n FROM users')!.n >= max) {
    throw new Error(`PLWR est limité à ${max} comptes pour l’instant : toutes les places sont prises.`);
  }
  const id = uid();
  tx(() => {
    // Une seule invitation en attente par courriel : la nouvelle remplace l'ancienne
    run('UPDATE calendar_invites SET revoked_at = ? WHERE owner_id = ? AND email = ? AND used_at IS NULL AND revoked_at IS NULL', nowIso(), ownerId, clean);
    run(
      'INSERT INTO calendar_invites (id, owner_id, email, role, created_at, expires_at) VALUES (?,?,?,?,?,?)',
      id,
      ownerId,
      clean,
      role,
      nowIso(),
      new Date(Date.now() + INVITE_DAYS * 86400_000).toISOString(),
    );
  });
  return { id, email: clean, role, url: inviteUrl(id) };
}

/** Active (lien réutilisable en lecture) ou coupe le lien d'invitation. */
export function setShareLink(ownerId: string, enabled: boolean) {
  return tx(() => {
    const current = get("SELECT * FROM calendar_invites WHERE owner_id = ? AND email IS NULL AND revoked_at IS NULL", ownerId);
    if (!enabled) {
      if (current) run('UPDATE calendar_invites SET revoked_at = ? WHERE id = ?', nowIso(), current.id);
      return null;
    }
    if (current) return inviteUrl(current.id);
    const id = uid();
    run("INSERT INTO calendar_invites (id, owner_id, email, role, created_at) VALUES (?,?,NULL,'view',?)", id, ownerId, nowIso());
    return inviteUrl(id);
  });
}

export function revokeInvite(ownerId: string, inviteId: string) {
  run('UPDATE calendar_invites SET revoked_at = ? WHERE id = ? AND owner_id = ? AND revoked_at IS NULL', nowIso(), inviteId, ownerId);
}

/** Accepte une invitation pour userId. Retourne le nom du propriétaire. */
export function acceptInvite(token: string, userId: string): { ownerId: string; ownerName: string } {
  const inv = findInvite(token);
  if (!inv) throw new Error('Invitation invalide ou expirée');
  const user = get('SELECT * FROM users WHERE id = ?', userId);
  if (!user) throw new Error('Compte introuvable');
  if (inv.owner_id === userId) throw new Error('C’est ton propre agenda');
  if (inv.email && inv.email !== user.email) throw new Error(`Cette invitation est destinée à ${inv.email}`);
  tx(() => {
    run(
      `INSERT INTO calendar_members (owner_id, member_id, role, created_at) VALUES (?,?,?,?)
       ON CONFLICT(owner_id, member_id) DO NOTHING`,
      inv.owner_id,
      userId,
      inv.role,
      nowIso(),
    );
    if (inv.email) run('UPDATE calendar_invites SET used_at = ?, used_by = ? WHERE id = ?', nowIso(), userId, inv.id);
  });
  const owner = get('SELECT * FROM users WHERE id = ?', inv.owner_id)!;
  return { ownerId: owner.id, ownerName: displayName(owner) };
}

export function setMemberRole(ownerId: string, memberId: string, role: Role) {
  const r = run('UPDATE calendar_members SET role = ? WHERE owner_id = ? AND member_id = ?', role, ownerId, memberId);
  if (!r.changes) throw new Error('Personne introuvable');
}

/** Retire l'accès de memberId à l'agenda de ownerId, et ses participations aux événements de cet agenda. */
export function removeMember(ownerId: string, memberId: string) {
  tx(() => {
    run('DELETE FROM calendar_members WHERE owner_id = ? AND member_id = ?', ownerId, memberId);
    run('DELETE FROM event_participants WHERE user_id = ? AND event_id IN (SELECT id FROM events WHERE user_id = ?)', memberId, ownerId);
  });
}

/** État du partage de mon agenda (écran « Partager l'agenda »). */
export function sharingState(ownerId: string) {
  const members = all('SELECT u.*, m.role, m.created_at AS since FROM calendar_members m JOIN users u ON u.id = m.member_id WHERE m.owner_id = ? ORDER BY m.created_at', ownerId).map((r) => {
    const name = displayName(r);
    return { id: r.id, name, initial: name.charAt(0).toUpperCase(), email: r.email as string, color: colorOf(r), role: r.role as Role };
  });
  const invites = all(
    'SELECT * FROM calendar_invites WHERE owner_id = ? AND email IS NOT NULL AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC',
    ownerId,
    nowIso(),
  ).map((r) => ({ id: r.id, email: r.email as string, role: r.role as Role, expiresAt: r.expires_at as string, url: inviteUrl(r.id) }));
  const link = get("SELECT id FROM calendar_invites WHERE owner_id = ? AND email IS NULL AND revoked_at IS NULL", ownerId);
  const sharedWithMe = all('SELECT u.*, m.role FROM calendar_members m JOIN users u ON u.id = m.owner_id WHERE m.member_id = ? ORDER BY m.created_at', ownerId).map((r) => {
    const name = displayName(r);
    return { id: r.id, name, initial: name.charAt(0).toUpperCase(), color: colorOf(r), role: r.role as Role };
  });
  return { members, invites, link: link ? inviteUrl(link.id) : null, sharedWithMe };
}
