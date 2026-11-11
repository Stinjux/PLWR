import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DateTime } from 'luxon';
import { api } from '../lib/api';
import { TZ, dt, duration, fromLocalInput, goalValue, time, toLocalInput, todayIso, dayLabel } from '../lib/format';
import { Icon, Seg, Sheet, useToast, Check } from './ui';
import { ReorganizeDialog } from './ReorganizeDialog';
import { RecurrenceEditor, recFromRule, ruleFromRec, type Rec, type Rule } from './RecurrenceEditor';
import { Avatar, usePeople, type Person } from '../lib/people';
import { useApp } from '../App';

export type Occ = {
  id: string;
  eventId: string;
  seriesId: string | null;
  recurrenceId: string | null;
  title: string;
  kind: 'fixed' | 'flexible';
  start: string | null;
  end: string | null;
  durationMin: number;
  dueAt: string | null;
  priority: number;
  preferredWindow: string | null;
  planDate: string | null;
  location: string | null;
  notes: string | null;
  rrule: Rule | null;
  status: 'active' | 'done' | 'cancelled';
  focusDate: string | null;
  reminders: number[];
  dueReminders: number[];
  goalIds: string[];
  isRecurring: boolean;
  ownerId: string;
  visibility: 'details' | 'busy';
  participantIds: string[];
  canEdit?: boolean;
  redacted?: boolean;
  source?: 'plwr' | 'google' | 'outlook';
  nextReminders?: { fireAt: string; title: string; deferredByQuietHours: boolean; kind: string }[];
};

export type EditorTarget =
  | { mode: 'new'; kind: 'fixed' | 'flexible'; start?: string; durationMin?: number; byDay?: number[]; planDate?: string }
  | { mode: 'edit'; id: string; action?: 'complete' };

const REMINDER_OPTIONS: [number, string][] = [
  [0, 'À l’heure'],
  [5, '5 min'],
  [10, '10 min'],
  [15, '15 min'],
  [30, '30 min'],
  [60, '1 h'],
  [1440, 'La veille'],
];

export function useGoalsList() {
  return useQuery({ queryKey: ['goals'], queryFn: () => api.get<any[]>('/api/goals') });
}

/** Demande « cette occurrence » ou « toute la série » pour un élément récurrent. */
export function askScope(occ: Pick<Occ, 'isRecurring' | 'recurrenceId'>): Promise<'this' | 'all' | null> {
  if (!occ.isRecurring || !occ.recurrenceId) return Promise.resolve('this');
  return new Promise((resolve) => {
    const ev = new CustomEvent('plwr:scope', { detail: resolve });
    window.dispatchEvent(ev);
  });
}

export function ScopeHost() {
  const [resolver, setResolver] = useState<((v: any) => void) | null>(null);
  useEffect(() => {
    const h = (e: Event) => setResolver(() => (e as CustomEvent).detail);
    window.addEventListener('plwr:scope', h);
    return () => window.removeEventListener('plwr:scope', h);
  }, []);
  if (!resolver) return null;
  const done = (v: 'this' | 'all' | null) => (resolver(v), setResolver(null));
  return (
    <Sheet title="Élément récurrent" onClose={() => done(null)}>
      <div className="stack">
        <p className="muted" style={{ margin: 0 }}>
          Appliquer la modification à…
        </p>
        <button className="btn primary block" onClick={() => done('this')}>
          Cette occurrence seulement
        </button>
        <button className="btn block" onClick={() => done('all')}>
          Toute la série
        </button>
      </div>
    </Sheet>
  );
}

/** Fiche en lecture seule : élément d'un agenda que je peux seulement consulter. */
function ReadOnlyEvent({ occ, people, onClose }: { occ: Occ; people: Person[]; onClose: () => void }) {
  const owner = people.find((p) => p.id === occ.ownerId);
  const faces = [occ.ownerId, ...occ.participantIds].map((id) => people.find((p) => p.id === id)).filter(Boolean) as Person[];
  return (
    <Sheet title={occ.redacted ? 'Occupé' : occ.title} onClose={onClose}>
      <div className="stack">
        <div className="event-when">
          {occ.start ? (
            <>
              <div>{dayLabel(dt(occ.start).toISODate()!)}</div>
              <div className="muted">
                {time(occ.start)} – {time(occ.end)}
              </div>
            </>
          ) : (
            <div className="muted">À placer · {duration(occ.durationMin)}</div>
          )}
        </div>
        <ul className="group">
          {owner && (
            <li>
              <Avatar person={owner} size={32} />
              <span className="grow">Agenda de {owner.name}</span>
            </li>
          )}
          {occ.location && (
            <li>
              <Icon.pin style={{ width: 20, height: 20, color: 'var(--muted)' }} />
              <span className="grow">{occ.location}</span>
            </li>
          )}
          {faces.length > 1 &&
            faces.slice(1).map((p) => (
              <li key={p.id}>
                <Avatar person={p} size={32} />
                <span className="grow">{p.me ? 'Moi' : p.name}</span>
                <span className="small muted">Participant</span>
              </li>
            ))}
        </ul>
        {occ.notes && <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{occ.notes}</p>}
        <div className="banner small">
          <Icon.lock style={{ width: 18, height: 18, flex: 'none' }} />
          <span>
            {occ.redacted
              ? `${owner?.name || 'Cette personne'} partage seulement ses plages occupées.`
              : occ.source === 'google' || occ.source === 'outlook'
                ? `Événement venu de ${occ.source === 'google' ? 'Google Agenda' : 'Outlook'}${owner && !owner.me ? ` (${owner.name})` : ''} : modifie-le dans ${occ.source === 'google' ? 'Google Agenda' : 'Outlook'}, il se mettra à jour ici.`
                : `Tu peux consulter cet élément. Seules les personnes qui peuvent modifier l’agenda de ${owner?.name || 'son propriétaire'} peuvent le changer.`}
          </span>
        </div>
      </div>
    </Sheet>
  );
}

export function EventEditor({ target, onClose }: { target: EditorTarget; onClose: () => void }) {
  const toast = useToast();
  const { me } = useApp();
  const people = usePeople().data || [];
  const goals = useGoalsList().data || [];
  const existing = useQuery({
    queryKey: ['event', target.mode === 'edit' ? target.id : 'new'],
    queryFn: () => api.get<Occ>(`/api/events/${encodeURIComponent((target as any).id)}`),
    enabled: target.mode === 'edit',
    // Toujours relire l'élément : l'horaire et ses rappels ont pu changer (glisser-déposer, réorganisation)
    staleTime: 0,
    gcTime: 0,
  });
  const [form, setForm] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [complete, setComplete] = useState<Occ | null>(null);
  const [reorg, setReorg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (form) return;
    if (target.mode === 'new') {
      const start = target.start || DateTime.now().setZone(TZ).plus({ hours: 1 }).startOf('hour').toISO()!;
      setForm({
        title: '',
        kind: target.kind,
        scheduled: target.kind === 'fixed' || Boolean(target.start),
        startLocal: toLocalInput(start),
        durationMin: target.durationMin || (target.kind === 'fixed' ? 60 : 30),
        planDate: target.planDate || todayIso(),
        dueLocal: '',
        priority: 2,
        preferredWindow: '',
        location: '',
        notes: '',
        // Sélection sur plusieurs jours en vue semaine → récurrence hebdomadaire sur ces jours
        rec: target.byDay && target.byDay.length > 1
          ? { ...recFromRule(null, toLocalInput(start)), repeat: target.byDay.length === 5 && [1, 2, 3, 4, 5].every((x) => target.byDay!.includes(x)) ? 'weekdays' : 'weekly', byDay: target.byDay }
          : recFromRule(null, toLocalInput(start)),
        reminders: target.kind === 'fixed' || target.start ? [10] : [],
        dueReminders: [],
        goalIds: [],
        ownerId: me.user.id,
        participantIds: [],
        visibility: 'details',
      });
    } else if (existing.data) {
      const o = existing.data;
      setForm({
        title: o.title,
        kind: o.kind,
        scheduled: Boolean(o.start),
        startLocal: toLocalInput(o.start || DateTime.now().setZone(TZ).plus({ hours: 1 }).startOf('hour').toISO()),
        durationMin: o.durationMin,
        planDate: o.planDate || todayIso(),
        dueLocal: toLocalInput(o.dueAt),
        priority: o.priority,
        preferredWindow: o.preferredWindow || '',
        location: o.location || '',
        notes: o.notes || '',
        rec: recFromRule(o.rrule, toLocalInput(o.start || DateTime.now().setZone(TZ).toISO())),
        reminders: o.reminders,
        dueReminders: o.dueReminders,
        goalIds: o.goalIds,
        ownerId: o.ownerId,
        participantIds: o.participantIds,
        visibility: o.visibility,
      });
      if (target.action === 'complete') setComplete(o);
    }
  }, [existing.data, target, form]);

  if (!form) return null;
  const occ = existing.data;
  const set = (patch: any) => setForm({ ...form, ...patch });

  function payload() {
    const p: any = {
      title: form.title,
      kind: form.kind,
      durationMin: Number(form.durationMin) || 30,
      priority: Number(form.priority),
      preferredWindow: form.preferredWindow || null,
      location: form.location || null,
      notes: form.notes || null,
      dueAt: form.dueLocal ? fromLocalInput(form.dueLocal) : null,
      reminders: form.reminders,
      dueReminders: form.dueLocal ? form.dueReminders : [],
      participantIds: form.participantIds,
      visibility: form.visibility,
    };
    // Les objectifs sont personnels : on ne les lie qu'aux éléments de mon agenda
    if (form.ownerId === me.user.id) p.goalIds = form.goalIds;
    if (target.mode === 'new') p.ownerId = form.ownerId;
    if (form.scheduled) {
      p.start = fromLocalInput(form.startLocal);
      p.rrule = ruleFromRec(form.rec as Rec, form.startLocal);
    } else {
      p.start = null;
      p.planDate = form.planDate;
      p.rrule = null;
    }
    return p;
  }

  async function save() {
    if (!form.title.trim()) return setError('Donne un titre');
    setSaving(true);
    setError(null);
    try {
      if (target.mode === 'new') {
        await api.post('/api/events', payload());
        toast(form.kind === 'fixed' ? 'Événement ajouté' : 'Tâche ajoutée');
      } else {
        const scope = await askScope(occ!);
        if (!scope) return;
        const p = payload();
        if (scope === 'this' && occ!.recurrenceId) delete p.rrule;
        const r = await api.patch<Occ>(`/api/events/${encodeURIComponent(occ!.id)}?scope=${scope}`, p);
        const next = r.nextReminders?.[0];
        toast(next ? `Enregistré · rappel ${dayLabel(dt(next.fireAt).toISODate()!)} à ${time(next.fireAt)}` : 'Enregistré');
      }
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    const scope = await askScope(occ!);
    if (!scope) return;
    await api.del(`/api/events/${encodeURIComponent(occ!.id)}?scope=${scope}`);
    toast('Supprimé · rappel annulé');
    onClose();
  }

  async function extend(min: number) {
    if (!occ?.end) return;
    const r = await api.patch<Occ>(`/api/events/${encodeURIComponent(occ.id)}?scope=this`, { end: dt(occ.end).plus({ minutes: min }).toUTC().toISO() });
    toast(`Prolongé de ${min} min (jusqu’à ${time(r.end)})`);
    setReorg(dt(r.start!).toISODate());
  }

  async function toggleFocus() {
    try {
      await api.post(`/api/events/${encodeURIComponent(occ!.id)}/focus`, { on: occ!.focusDate !== todayIso() });
      existing.refetch();
    } catch (e) {
      toast((e as Error).message);
    }
  }

  if (complete) return <CompleteDialog occ={complete} onClose={onClose} />;
  if (reorg) return <ReorganizeDialog date={reorg} onClose={onClose} />;
  if (occ && (occ.canEdit === false || occ.redacted)) return <ReadOnlyEvent occ={occ} people={people} onClose={onClose} />;

  const isNew = target.mode === 'new';
  const mineOwner = form.ownerId === me.user.id;
  // Agendas où je peux ajouter : le mien et ceux où j'ai « Peut modifier »
  const calendars = people.filter((p) => p.access === 'owner' || p.access === 'edit');
  const ownerPerson = people.find((p) => p.id === form.ownerId);
  const candidates = people.filter((p) => p.id !== form.ownerId);
  const shared = people.length > 1;
  return (
    <Sheet
      title={isNew ? (form.kind === 'fixed' ? 'Nouvel événement' : 'Nouvelle tâche') : form.kind === 'fixed' ? 'Rendez-vous' : 'Tâche'}
      onClose={onClose}
      footer={
        <>
          {!isNew && (
            <button className="btn danger" onClick={remove} aria-label="Supprimer">
              <Icon.trash />
            </button>
          )}
          <button className="btn primary grow" onClick={save} disabled={saving}>
            Enregistrer
          </button>
        </>
      }
    >
      <div className="stack">
        {!isNew && occ && occ.status !== 'cancelled' && occ.ownerId === me.user.id && (
          <div className="row wrap">
            {occ.status === 'done' ? (
              <span className="chip ok">✓ Terminé</span>
            ) : (
              <button className="btn small primary" onClick={() => setComplete(occ)}>
                <Icon.check /> Terminer et saisir le résultat
              </button>
            )}
            {occ.kind === 'flexible' && (
              <button className="btn small" onClick={toggleFocus} aria-pressed={occ.focusDate === todayIso()}>
                <Icon.star /> {occ.focusDate === todayIso() ? 'Priorité du jour' : 'Mettre en priorité'}
              </button>
            )}
            {occ.kind === 'fixed' && occ.end && occ.status === 'active' && (
              <span className="row" style={{ gap: 4 }}>
                <span className="small muted">Se prolonge :</span>
                {[15, 30, 45].map((m) => (
                  <button key={m} className="btn small" onClick={() => extend(m)}>
                    +{m}
                  </button>
                ))}
              </span>
            )}
          </div>
        )}
        <Seg
          full
          label="Type"
          value={form.kind}
          options={[
            ['fixed', 'Rendez-vous fixe'],
            ['flexible', 'Tâche flexible'],
          ]}
          onChange={(v) => set({ kind: v, scheduled: v === 'fixed' ? true : form.scheduled })}
        />
        {isNew && calendars.length > 1 && (
          <label className="field">
            Agenda
            <select className="input" aria-label="Agenda" value={form.ownerId} onChange={(e) => set({ ownerId: e.target.value, participantIds: form.participantIds.filter((x: string) => x !== e.target.value) })}>
              {calendars.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.me ? 'Mon agenda' : `Agenda de ${p.name}`}
                </option>
              ))}
            </select>
          </label>
        )}
        {!isNew && !mineOwner && ownerPerson && (
          <div className="row small muted">
            <Avatar person={ownerPerson} size={22} /> Dans l’agenda de {ownerPerson.name}
          </div>
        )}
        <label className="field">
          Titre
          <input className="input" value={form.title} onChange={(e) => set({ title: e.target.value })} autoFocus={isNew} aria-label="Titre" placeholder={form.kind === 'fixed' ? 'Rencontre, rendez-vous…' : 'Bloc CFA, gym, appel…'} />
        </label>
        {form.kind === 'flexible' && (
          <Seg
            full
            label="Planification"
            value={form.scheduled ? 'yes' : 'no'}
            options={[
              ['yes', 'À une heure précise'],
              ['no', 'À placer dans la journée'],
            ]}
            onChange={(v) => set({ scheduled: v === 'yes' })}
          />
        )}
        <div className="form-grid">
          {form.scheduled ? (
            <label className="field">
              Début
              <input className="input" type="datetime-local" value={form.startLocal} onChange={(e) => set({ startLocal: e.target.value })} aria-label="Début" />
            </label>
          ) : (
            <label className="field">
              Jour prévu
              <input className="input" type="date" value={form.planDate} onChange={(e) => set({ planDate: e.target.value })} />
            </label>
          )}
          <label className="field">
            {form.kind === 'fixed' ? 'Durée (min)' : 'Durée estimée (min)'}
            <input className="input" type="number" min={5} step={5} value={form.durationMin} onChange={(e) => set({ durationMin: e.target.value })} aria-label="Durée" />
            {form.scheduled && form.startLocal && (
              <span className="tiny muted" data-testid="computed-end">
                Fin : {DateTime.fromISO(form.startLocal, { zone: TZ }).plus({ minutes: Number(form.durationMin) || 0 }).toFormat("HH'h'mm")}
              </span>
            )}
          </label>
          {form.kind === 'flexible' && (
            <>
              <label className="field">
                Priorité
                <select className="input" value={form.priority} onChange={(e) => set({ priority: e.target.value })}>
                  <option value={1}>Haute</option>
                  <option value={2}>Moyenne</option>
                  <option value={3}>Basse</option>
                </select>
              </label>
              <label className="field">
                Plage préférée
                <select className="input" value={form.preferredWindow} onChange={(e) => set({ preferredWindow: e.target.value })}>
                  <option value="">Aucune</option>
                  <option value="matin">Matin</option>
                  <option value="apres-midi">Après-midi</option>
                  <option value="soir">Soir</option>
                  {form.preferredWindow && !['matin', 'apres-midi', 'soir'].includes(form.preferredWindow) && <option value={form.preferredWindow}>{form.preferredWindow}</option>}
                </select>
              </label>
              <label className="field full">
                Échéance
                <input className="input" type="datetime-local" value={form.dueLocal} onChange={(e) => set({ dueLocal: e.target.value })} />
              </label>
            </>
          )}
          {form.kind === 'fixed' && (
            <label className="field">
              Lieu
              <input className="input" value={form.location} onChange={(e) => set({ location: e.target.value })} />
            </label>
          )}
        </div>
        {form.scheduled && <RecurrenceEditor value={form.rec} startLocal={form.startLocal} onChange={(rec) => set({ rec })} />}
        {form.scheduled && (
          <div>
            <div className="small muted" style={{ fontWeight: 600, marginBottom: 6 }}>
              <Icon.bell style={{ width: 14, height: 14, verticalAlign: -2 }} /> Rappels avant le début
            </div>
            <div className="row wrap">
              {REMINDER_OPTIONS.map(([m, l]) => (
                <button key={m} type="button" className="chip" aria-pressed={form.reminders.includes(m)} style={form.reminders.includes(m) ? { background: 'var(--primary)', color: 'var(--primary-ink)' } : undefined} onClick={() => set({ reminders: form.reminders.includes(m) ? form.reminders.filter((x: number) => x !== m) : [...form.reminders, m] })}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        )}
        {form.kind === 'flexible' && form.dueLocal && (
          <div>
            <div className="small muted" style={{ fontWeight: 600, marginBottom: 6 }}>Rappel d’échéance</div>
            <div className="row wrap">
              {[
                [60, '1 h avant'],
                [180, '3 h avant'],
                [1440, 'La veille'],
              ].map(([m, l]) => (
                <button key={m} type="button" className="chip" aria-pressed={form.dueReminders.includes(m)} style={form.dueReminders.includes(m) ? { background: 'var(--primary)', color: 'var(--primary-ink)' } : undefined} onClick={() => set({ dueReminders: form.dueReminders.includes(m) ? form.dueReminders.filter((x: number) => x !== m) : [...form.dueReminders, m] })}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        )}
        {occ?.nextReminders && occ.nextReminders.length > 0 && (
          <div className="banner info small" data-testid="next-reminder">
            <Icon.bell style={{ width: 18, height: 18, flex: 'none' }} />
            <span>
              Prochain rappel : {dayLabel(dt(occ.nextReminders[0].fireAt).toISODate()!)} à <strong>{time(occ.nextReminders[0].fireAt)}</strong>
              {occ.nextReminders[0].deferredByQuietHours && ' (décalé : heures silencieuses)'}
            </span>
          </div>
        )}
        {shared && (
          <div>
            <div className="small muted" style={{ fontWeight: 600, marginBottom: 6 }}>
              <Icon.users style={{ width: 14, height: 14, verticalAlign: -2 }} /> Participants
            </div>
            <div className="row wrap" role="group" aria-label="Participants">
              {candidates.map((p) => {
                const on = form.participantIds.includes(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`person-chip${on ? '' : ' off'}`}
                    aria-pressed={on}
                    onClick={() => set({ participantIds: on ? form.participantIds.filter((x: string) => x !== p.id) : [...form.participantIds, p.id] })}
                  >
                    <Avatar person={p} size={24} />
                    {p.me ? 'Moi' : p.name}
                  </button>
                );
              })}
            </div>
            <div className="tiny muted" style={{ marginTop: 6 }}>Les participants voient cet élément dans leur agenda et en reçoivent les rappels.</div>
          </div>
        )}
        {shared && (
          <div>
            <div className="small muted" style={{ fontWeight: 600, marginBottom: 6 }}>Ce que les autres voient</div>
            <Seg
              full
              label="Visibilité"
              value={form.visibility}
              options={[
                ['details', 'Tous les détails'],
                ['busy', 'Occupé seulement'],
              ]}
              onChange={(v) => set({ visibility: v })}
            />
          </div>
        )}
        {mineOwner && goals.length > 0 && (
          <div>
            <div className="small muted" style={{ fontWeight: 600, marginBottom: 6 }}>Objectifs liés</div>
            <ul className="list">
              {goals.map((g) => (
                <li key={g.id}>
                  <Check on={form.goalIds.includes(g.id)} label={`Lier à ${g.title}`} onToggle={() => set({ goalIds: form.goalIds.includes(g.id) ? form.goalIds.filter((x: string) => x !== g.id) : [...form.goalIds, g.id] })} />
                  <span className="grow">{g.title}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <label className="field">
          Notes
          <textarea className="input" value={form.notes} onChange={(e) => set({ notes: e.target.value })} />
        </label>
        {error && <div className="error">{error}</div>}
      </div>
    </Sheet>
  );
}

/** Terminer un bloc et saisir le résultat réel pour chaque objectif lié (ex. 45 min d'étude sur 60 prévues). */
export function CompleteDialog({ occ, onClose }: { occ: Occ; onClose: () => void }) {
  const toast = useToast();
  const goals = (useGoalsList().data || []).filter((g) => occ.goalIds.includes(g.id));
  const [values, setValues] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const planned = (g: any) => (g.metric === 'duration' ? occ.durationMin : g.metric === 'amount' ? 0 : 1);
  async function submit() {
    setBusy(true);
    try {
      const r = await api.post(`/api/events/${encodeURIComponent(occ.id)}/complete`, {
        note,
        results: goals.map((g) => ({ goalId: g.id, value: Number((values[g.id] ?? String(planned(g))).replace(',', '.')), planned: planned(g) })),
      });
      toast(r.goals.length ? `Bravo ! ${r.goals.map((x: any) => `${x.title} : ${x.text}`).join(' · ')}` : 'Bloc terminé');
      onClose();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet title={`Terminer « ${occ.title} »`} onClose={onClose} footer={<button className="btn primary block" onClick={submit} disabled={busy}>Enregistrer le résultat</button>}>
      <div className="stack">
        <div className="muted small">
          Prévu : {occ.start ? `${time(occ.start)}–${time(occ.end)} · ` : ''}
          {duration(occ.durationMin)}
        </div>
        {goals.length === 0 && <div className="small">Aucun objectif lié : le bloc sera simplement marqué comme fait.</div>}
        {goals.map((g) => (
          <label className="field" key={g.id}>
            {g.title} — {g.metric === 'duration' ? 'minutes réelles' : g.metric === 'amount' ? 'montant ($)' : g.metric === 'check' ? 'fait (1) / pas fait (0)' : `quantité (${g.unit || 'unités'})`}
            <input className="input" inputMode="decimal" value={values[g.id] ?? String(planned(g))} onChange={(e) => setValues({ ...values, [g.id]: e.target.value })} aria-label={`Résultat pour ${g.title}`} />
            <span className="tiny muted">
              {g.metric === 'duration' ? `sur ${planned(g)} min prévues · ` : ''}
              Progression actuelle : {goalValue(g, g.progress.done)} / {goalValue(g, g.target)}
            </span>
          </label>
        ))}
        <label className="field">
          Note (optionnel)
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
    </Sheet>
  );
}
