import * as webpush from 'web-push';
import { DateTime } from 'luxon';
import { all, get, run, uid, nowIso } from '../db.ts';
import { config, pushEnabled } from '../config.ts';
import { rowToUser, signToken, type User } from '../auth.ts';
import { listOccurrences } from './events.ts';
import { formatMoney, formatTime, formatDayTime } from '../time.ts';
import { purgeOldImages } from './imports.ts';

export type Reminder = {
  key: string;
  kind: 'event' | 'task' | 'deadline' | 'goal' | 'bill' | 'snooze';
  refId: string;
  title: string;
  body: string;
  url: string;
  originalFireAt: string;
  fireAt: string;
  deferredByQuietHours: boolean;
};

if (pushEnabled()) webpush.setVapidDetails(config.push.subject, config.push.publicKey, config.push.privateKey);

/** Décale une heure d'envoi qui tombe dans les heures silencieuses à la fin de celles-ci. */
export function applyQuietHours(fireAt: DateTime, user: User): { at: DateTime; deferred: boolean } {
  const q = user.settings.quietHours;
  if (!q?.enabled) return { at: fireAt, deferred: false };
  const local = fireAt.setZone(user.timezone);
  const [sh, sm] = q.start.split(':').map(Number);
  const [eh, em] = q.end.split(':').map(Number);
  const mins = local.hour * 60 + local.minute;
  const s = sh * 60 + sm, e = eh * 60 + em;
  const inQuiet = s <= e ? mins >= s && mins < e : mins >= s || mins < e;
  if (!inQuiet) return { at: fireAt, deferred: false };
  let end = local.set({ hour: eh, minute: em, second: 0, millisecond: 0 });
  if (end <= local) end = end.plus({ days: 1 });
  return { at: end.toUTC(), deferred: true };
}

function offsetLabel(min: number): string {
  if (min === 0) return 'maintenant';
  if (min < 60) return `dans ${min} min`;
  if (min % 1440 === 0) return min === 1440 ? 'demain' : `dans ${min / 1440} jours`;
  return `dans ${Math.round(min / 60)} h`;
}

/**
 * Calcule les rappels dont l'heure d'envoi tombe dans [from, to].
 * Les rappels sont recalculés à partir de l'horaire courant : déplacer un événement déplace son rappel,
 * l'annuler le supprime (la clé de déduplication contient l'heure de début).
 */
export function computeReminders(user: User, fromIso: string, toIso: string): Reminder[] {
  const out: Reminder[] = [];
  const from = DateTime.fromISO(fromIso), to = DateTime.fromISO(toIso);
  const push = (r: Omit<Reminder, 'fireAt' | 'deferredByQuietHours'>) => {
    const q = applyQuietHours(DateTime.fromISO(r.originalFireAt), user);
    const fireAt = q.at.toUTC().toISO()!;
    if (fireAt >= fromIso && fireAt <= toIso) out.push({ ...r, fireAt, deferredByQuietHours: q.deferred });
  };
  // Événements et blocs planifiés (on regarde jusqu'à 8 jours en avant pour couvrir les rappels « la veille »)
  const occs = listOccurrences(user.id, user.timezone, from.minus({ days: 1 }).toUTC().toISO()!, to.plus({ days: 8 }).toUTC().toISO()!);
  for (const o of occs) {
    if (o.status !== 'active' || !o.start) continue;
    for (const off of o.reminders) {
      push({
        key: `ev:${o.id}:${o.start}:${off}`,
        kind: o.kind === 'fixed' ? 'event' : 'task',
        refId: o.id,
        title: o.kind === 'fixed' ? `📅 ${o.title}` : `✅ ${o.title}`,
        body: `${offsetLabel(off) === 'maintenant' ? 'Maintenant' : `Commence ${offsetLabel(off)}`} · ${formatTime(o.start, user.timezone)}${o.location ? ` · ${o.location}` : ''}`,
        url: `/agenda?date=${DateTime.fromISO(o.start).setZone(user.timezone).toISODate()}&focus=${encodeURIComponent(o.id)}`,
        originalFireAt: DateTime.fromISO(o.start).minus({ minutes: off }).toUTC().toISO()!,
      });
    }
  }
  // Échéances de tâches
  for (const t of all("SELECT * FROM events WHERE user_id = ? AND due_at IS NOT NULL AND status = 'active' AND series_id IS NULL AND due_reminders != '[]'", user.id)) {
    for (const off of JSON.parse(t.due_reminders) as number[]) {
      push({
        key: `due:${t.id}:${t.due_at}:${off}`,
        kind: 'deadline',
        refId: t.id,
        title: `⏰ Échéance : ${t.title}`,
        body: `À remettre ${formatDayTime(t.due_at, user.timezone)}`,
        url: `/agenda?focus=${t.id}`,
        originalFireAt: DateTime.fromISO(t.due_at).minus({ minutes: off }).toUTC().toISO()!,
      });
    }
  }
  // Échéances d'objectifs (à 9 h, N jours avant)
  for (const g of all('SELECT * FROM goals WHERE user_id = ? AND archived = 0 AND deadline IS NOT NULL AND reminder_days IS NOT NULL', user.id)) {
    const at = DateTime.fromISO(g.deadline, { zone: user.timezone }).minus({ days: g.reminder_days }).set({ hour: 9 });
    push({ key: `goal:${g.id}:${g.deadline}:${g.reminder_days}`, kind: 'goal', refId: g.id, title: `🎯 ${g.title}`, body: `Échéance ${g.reminder_days ? `dans ${g.reminder_days} jour(s)` : "aujourd'hui"}`, url: `/objectifs/${g.id}`, originalFireAt: at.toUTC().toISO()! });
  }
  // Factures et paiements récurrents
  for (const b of all("SELECT * FROM recurring WHERE user_id = ? AND active = 1 AND kind = 'expense' AND reminder_days IS NOT NULL", user.id)) {
    const at = DateTime.fromISO(b.next_date, { zone: user.timezone }).minus({ days: b.reminder_days }).set({ hour: 9 });
    push({ key: `bill:${b.id}:${b.next_date}:${b.reminder_days}`, kind: 'bill', refId: b.id, title: `💳 Facture : ${b.name}`, body: `${formatMoney(b.amount_cents)} dû le ${DateTime.fromISO(b.next_date).setLocale('fr-CA').toFormat('d LLLL')}`, url: '/budget?tab=recurrents', originalFireAt: at.toUTC().toISO()! });
  }
  // Rappels reportés
  for (const s of all('SELECT * FROM snoozes WHERE user_id = ? AND fire_at BETWEEN ? AND ?', user.id, fromIso, toIso)) {
    out.push({ key: `snooze:${s.id}`, kind: 'snooze', refId: s.ref_key || s.id, title: s.title, body: s.body, url: s.url || '/', originalFireAt: s.fire_at, fireAt: s.fire_at, deferredByQuietHours: false });
  }
  return out.sort((a, b) => (a.fireAt < b.fireAt ? -1 : 1));
}

export async function sendPush(userId: string, payload: { title: string; body: string; url: string; tag?: string; snoozeToken?: string }) {
  if (!pushEnabled()) return { sent: 0, failed: 0, disabled: true };
  const subs = all('SELECT * FROM push_subscriptions WHERE user_id = ?', userId);
  let sent = 0, failed = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600, urgency: 'high' });
      run('UPDATE push_subscriptions SET last_ok_at = ?, failures = 0 WHERE id = ?', nowIso(), s.id);
      sent++;
    } catch (e: any) {
      failed++;
      if (e?.statusCode === 404 || e?.statusCode === 410) run('DELETE FROM push_subscriptions WHERE id = ?', s.id);
      else run('UPDATE push_subscriptions SET failures = failures + 1 WHERE id = ?', s.id);
    }
  }
  return { sent, failed, disabled: false };
}

/** Enregistre la notification (historique dans l'app) et l'envoie aux appareils abonnés. Dédupliqué par clé. */
export async function deliver(user: User, r: Pick<Reminder, 'key' | 'kind' | 'title' | 'body' | 'url' | 'fireAt'>) {
  const id = uid();
  const ins = run(
    'INSERT OR IGNORE INTO notifications (id, user_id, dedupe_key, kind, title, body, url, fire_at, sent_at) VALUES (?,?,?,?,?,?,?,?,?)',
    id,
    user.id,
    r.key,
    r.kind,
    r.title,
    r.body,
    r.url,
    r.fireAt,
    nowIso(),
  );
  if (!ins.changes) return null; // déjà envoyée
  const snoozeToken = signToken({ u: user.id, n: id });
  const res = await sendPush(user.id, { title: r.title, body: r.body, url: r.url, tag: r.key.slice(0, 60), snoozeToken });
  run('UPDATE notifications SET delivered = ? WHERE id = ?', res.sent, id);
  return { id, ...res };
}

export function snooze(userId: string, notificationId: string, minutes: number) {
  const n = get('SELECT * FROM notifications WHERE id = ? AND user_id = ?', notificationId, userId);
  if (!n) throw new Error('Notification introuvable');
  const at = new Date(Date.now() + minutes * 60_000).toISOString();
  const id = uid();
  run('INSERT INTO snoozes (id, user_id, title, body, url, fire_at, ref_key, created_at) VALUES (?,?,?,?,?,?,?,?)', id, userId, n.title.startsWith('🔁') ? n.title : `🔁 ${n.title}`, n.body, n.url, at, n.dedupe_key, nowIso());
  return { id, fireAt: at };
}

let running = false;
/** Boucle d'envoi : toutes les 30 s, envoie les rappels dus (avec rattrapage de 15 min après un redémarrage). */
export async function tick(now = new Date()) {
  if (running) return;
  running = true;
  try {
    const from = new Date(now.getTime() - 15 * 60_000).toISOString();
    const to = now.toISOString();
    for (const row of all('SELECT * FROM users')) {
      const user = rowToUser(row);
      for (const r of computeReminders(user, from, to)) await deliver(user, r);
    }
    purgeOldImages();
  } catch (e) {
    console.error('[rappels]', e);
  } finally {
    running = false;
  }
}

export function startScheduler() {
  setInterval(() => void tick(), config.schedulerIntervalMs).unref();
  setTimeout(() => void tick(), 3000).unref();
}
