import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { dayLabel, dt, duration, longDate, time } from '../lib/format';
import { useApp } from '../App';
import { Check, Icon, Sheet, useToast } from './ui';

type Plan = {
  date: string;
  changes: { id: string; title: string; kind: 'move' | 'schedule'; from: { start: string; end: string } | null; to: { start: string; end: string }; lateForDue?: boolean }[];
  kept: string[];
  postponed: { id: string; title: string; durationMin: number; reason: string; suggestion: { start: string; end: string } | null }[];
  freeMinutes: number;
  neededMinutes: number;
  overloaded: boolean;
};

/** « Réorganiser ma journée » : propose un nouvel horaire, affiche les changements, applique après accord. */
export function ReorganizeDialog({ date, onClose }: { date: string; onClose: () => void }) {
  const { me } = useApp();
  const toast = useToast();
  const qc = useQueryClient();
  const breaks: { label: string; start: string; end: string }[] = me.settings.breaks || [];
  const [keep, setKeep] = useState<string[]>(breaks.map((b) => b.label));
  const [dayEnd, setDayEnd] = useState<string>(me.settings.dayEnd);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [accept, setAccept] = useState<Record<string, boolean>>({});
  const [postChoice, setPostChoice] = useState<Record<string, 'suggestion' | 'later'>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    api.post<Plan>('/api/planner/propose', { date, keepBreaks: keep, dayEnd }).then((p) => {
      if (!alive) return;
      setPlan(p);
      setAccept(Object.fromEntries(p.changes.map((c) => [c.id, true])));
      setPostChoice(Object.fromEntries(p.postponed.map((x) => [x.id, x.suggestion ? 'suggestion' : 'later'])));
    });
    return () => {
      alive = false;
    };
  }, [date, keep.join('|'), dayEnd]);

  async function apply() {
    if (!plan) return;
    setBusy(true);
    try {
      await api.post('/api/planner/apply', {
        changes: plan.changes.filter((c) => accept[c.id]).map((c) => ({ id: c.id, start: c.to.start, end: c.to.end })),
        postponed: plan.postponed.map((p) => (postChoice[p.id] === 'suggestion' && p.suggestion ? { id: p.id, start: p.suggestion.start, end: p.suggestion.end } : { id: p.id })),
      });
      toast('Nouvel horaire appliqué · rappels mis à jour');
      qc.invalidateQueries();
      onClose();
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const nothing = plan && plan.changes.length === 0 && plan.postponed.length === 0;
  return (
    <Sheet
      title="Réorganiser ma journée"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Annuler
          </button>
          <button className="btn primary grow" onClick={apply} disabled={busy || !plan || nothing!} data-testid="apply-plan">
            Appliquer ces changements
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="muted small">{longDate(date)} · les rendez-vous fixes ne bougent pas.</div>
        <div className="card">
          <h3>Pauses à garder</h3>
          <ul className="list">
            {breaks.map((b) => (
              <li key={b.label}>
                <Check on={keep.includes(b.label)} label={`Garder ${b.label}`} onToggle={() => setKeep(keep.includes(b.label) ? keep.filter((x) => x !== b.label) : [...keep, b.label])} />
                <span className="grow">
                  {b.label} <span className="muted small">{b.start}–{b.end}</span>
                </span>
              </li>
            ))}
          </ul>
          <label className="field" style={{ marginTop: 8 }}>
            Fin de ma journée
            <input className="input" type="time" value={dayEnd} onChange={(e) => setDayEnd(e.target.value)} />
          </label>
        </div>
        {!plan && <div className="empty">Calcul de la proposition…</div>}
        {plan && (
          <>
            <div className={`banner ${plan.overloaded ? 'danger' : 'info'} small`}>
              Temps libre : {duration(plan.freeMinutes)} · tâches flexibles : {duration(plan.neededMinutes)}
              {plan.overloaded ? ' — la journée est surchargée.' : ''}
            </div>
            {nothing && <div className="empty">Ton horaire actuel fonctionne déjà : aucun changement nécessaire.</div>}
            {plan.changes.length > 0 && (
              <div className="card" data-testid="plan-changes">
                <h3>Changements proposés</h3>
                <ul className="list">
                  {plan.changes.map((c) => (
                    <li key={c.id}>
                      <Check on={!!accept[c.id]} label={`Accepter ${c.title}`} onToggle={() => setAccept({ ...accept, [c.id]: !accept[c.id] })} />
                      <div className="grow">
                        <div style={{ fontWeight: 600 }}>{c.title}</div>
                        <div className="diff">
                          <span className="from">{c.from ? `${time(c.from.start)}–${time(c.from.end)}` : 'non planifiée'}</span>
                          <span>→</span>
                          <span className="to">
                            {time(c.to.start)}–{time(c.to.end)}
                          </span>
                        </div>
                        {c.lateForDue && <span className="chip warn">après l’échéance</span>}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {plan.postponed.length > 0 && (
              <div className="card" data-testid="plan-postponed">
                <h3>Ne rentre pas aujourd’hui</h3>
                <ul className="list">
                  {plan.postponed.map((p) => (
                    <li key={p.id} style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                      <div style={{ fontWeight: 600 }}>
                        {p.title} <span className="muted small">({duration(p.durationMin)})</span>
                      </div>
                      <div className="seg full">
                        {p.suggestion && (
                          <button className={postChoice[p.id] === 'suggestion' ? 'on' : ''} onClick={() => setPostChoice({ ...postChoice, [p.id]: 'suggestion' })}>
                            {dayLabel(dt(p.suggestion.start).toISODate()!)} {time(p.suggestion.start)}
                          </button>
                        )}
                        <button className={postChoice[p.id] === 'later' ? 'on' : ''} onClick={() => setPostChoice({ ...postChoice, [p.id]: 'later' })}>
                          Demain, à placer
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="tiny muted">
              <Icon.bell style={{ width: 12, height: 12, verticalAlign: -1 }} /> Les rappels suivront automatiquement les nouveaux horaires.
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
