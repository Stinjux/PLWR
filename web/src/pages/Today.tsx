import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { dayLabel, dt, duration, goalValue, longDate, time } from '../lib/format';
import { useApp } from '../App';
import { Check, Icon, Progress, useToast } from '../components/ui';
import { ReorganizeDialog } from '../components/ReorganizeDialog';
import type { Occ } from '../components/EventEditor';

type TodayData = {
  date: string;
  nextEvent: Occ | null;
  priorities: Occ[];
  tasks: Occ[];
  goals: any[];
  pendingDrafts: number;
  overload: { overloaded: boolean; freeMinutes: number; neededMinutes: number; postponed: number };
};

export function Today() {
  const { me, openChat, openEditor, openPending } = useApp();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['today'], queryFn: () => api.get<TodayData>('/api/today'), refetchInterval: 60_000 });
  const [reorg, setReorg] = useState(false);
  const d = q.data;

  async function toggleTask(t: Occ) {
    if (t.status === 'done') {
      await api.post(`/api/events/${encodeURIComponent(t.id)}/complete`, { undo: true });
    } else if (t.goalIds.length) {
      return openEditor({ mode: 'edit', id: t.id, action: 'complete' });
    } else {
      await api.post(`/api/events/${encodeURIComponent(t.id)}/complete`, {});
      toast('Tâche terminée ✓');
    }
    qc.invalidateQueries();
  }
  async function checkGoal(g: any) {
    await api.post(`/api/goals/${g.id}/check`, { checked: !g.progress.checkedToday });
    qc.invalidateQueries();
  }

  const greeting = new Date().getHours() < 12 ? 'Bon matin' : new Date().getHours() < 18 ? 'Bon après-midi' : 'Bonsoir';
  return (
    <>
      <div className="page-head">
        <div>
          <div className="muted small">{d ? longDate(d.date) : ''}</div>
          <h1>
            {greeting}
            {me.user.name ? `, ${me.user.name}` : ''}
          </h1>
        </div>
        <button className="icon-btn" aria-label="Réglages" onClick={() => nav('/reglages')}>
          <Icon.settings />
        </button>
      </div>

      <div className="quick-actions" style={{ marginBottom: 12 }}>
        <button className="btn" onClick={() => openEditor({ mode: 'new', kind: 'flexible', planDate: d?.date })}>
          <Icon.check /> Tâche
        </button>
        <button className="btn" onClick={() => openEditor({ mode: 'new', kind: 'fixed' })}>
          <Icon.calendar /> Événement
        </button>
        <button className="btn primary" onClick={openChat} data-testid="add-expense">
          <Icon.wallet /> Dépense
        </button>
      </div>

      {q.isLoading && <div className="empty">Chargement…</div>}
      {d && (
        <div className="grid-2">
          <div>
            <section className="card">
              <div className="card-title">
                <h2>Prochain rendez-vous</h2>
              </div>
              {d.nextEvent ? (
                <button className="row" style={{ all: 'unset', cursor: 'pointer', display: 'flex', gap: 12, width: '100%' }} onClick={() => openEditor({ mode: 'edit', id: d.nextEvent!.id })}>
                  <div style={{ textAlign: 'center', minWidth: 58 }}>
                    <div style={{ fontSize: '1.3rem', fontWeight: 800 }}>{time(d.nextEvent.start)}</div>
                    <div className="tiny muted">{dayLabel(dt(d.nextEvent.start!).toISODate()!)}</div>
                  </div>
                  <div className="grow">
                    <div style={{ fontWeight: 700 }}>{d.nextEvent.title}</div>
                    <div className="small muted">
                      {time(d.nextEvent.start)}–{time(d.nextEvent.end)}
                      {d.nextEvent.location ? ` · ${d.nextEvent.location}` : ''}
                    </div>
                  </div>
                  <span className="chip fixed">Fixe</span>
                </button>
              ) : (
                <div className="empty">Aucun rendez-vous à venir.</div>
              )}
            </section>

            <section className="card">
              <div className="card-title">
                <h2>Mes 3 priorités</h2>
              </div>
              {d.priorities.length === 0 && <div className="empty">Ajoute une tâche ou mets-en une en priorité (★).</div>}
              <ul className="list" data-testid="priorities">
                {d.priorities.map((t, i) => (
                  <li key={t.id}>
                    <Check on={t.status === 'done'} label={`Terminer ${t.title}`} onToggle={() => toggleTask(t)} />
                    <span className="clickable grow" onClick={() => openEditor({ mode: 'edit', id: t.id })}>
                      <span className={t.status === 'done' ? 'done-text' : ''} style={{ fontWeight: 600 }}>
                        {i + 1}. {t.title}
                      </span>
                      <div className="tiny muted">{t.start ? `${time(t.start)} · ` : 'À placer · '}{duration(t.durationMin)}</div>
                    </span>
                    {t.focusDate === d.date && <Icon.star style={{ width: 16, color: 'var(--accent)' }} />}
                  </li>
                ))}
              </ul>
            </section>

            {d.overload.overloaded && (
              <div className="banner" style={{ marginTop: 12 }} data-testid="overload">
                <span className="grow small">
                  Ta journée déborde : {duration(d.overload.neededMinutes)} de tâches pour {duration(d.overload.freeMinutes)} libres.
                </span>
                <button className="btn small" onClick={() => setReorg(true)}>
                  Choisir quoi déplacer
                </button>
              </div>
            )}
            <button className="btn block" style={{ marginTop: 12 }} onClick={() => setReorg(true)}>
              <Icon.shuffle /> Réorganiser ma journée
            </button>
          </div>

          <div>
            <section className="card">
              <div className="card-title">
                <h2>Tâches d’aujourd’hui</h2>
                <span className="muted small">{d.tasks.filter((t) => t.status === 'done').length}/{d.tasks.length}</span>
              </div>
              {d.tasks.length === 0 && <div className="empty">Rien de prévu.</div>}
              <ul className="list" data-testid="today-tasks">
                {d.tasks.map((t) => (
                  <li key={t.id}>
                    <Check on={t.status === 'done'} label={`Terminer ${t.title}`} onToggle={() => toggleTask(t)} />
                    <span className="clickable grow" onClick={() => openEditor({ mode: 'edit', id: t.id })}>
                      <span className={t.status === 'done' ? 'done-text' : ''}>{t.title}</span>
                      <div className="tiny muted">
                        {t.start ? `${time(t.start)}–${time(t.end)}` : 'À placer'} · {duration(t.durationMin)}
                        {t.dueAt ? ` · échéance ${time(t.dueAt)}` : ''}
                      </div>
                    </span>
                    <span className={`chip ${t.priority === 1 ? 'warn' : ''}`}>{t.priority === 1 ? 'Haute' : t.priority === 3 ? 'Basse' : 'Moy.'}</span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="card">
              <div className="card-title">
                <h2>Objectifs</h2>
                <button className="btn small ghost" onClick={() => nav('/objectifs')}>
                  Tout voir
                </button>
              </div>
              <ul className="list" data-testid="today-goals">
                {d.goals.map((g) => (
                  <li key={g.id}>
                    {g.metric === 'check' ? (
                      <Check on={!!g.progress.checkedToday} label={`Cocher ${g.title}`} onToggle={() => checkGoal(g)} />
                    ) : (
                      <span style={{ width: 28 }} />
                    )}
                    <div className="grow clickable" onClick={() => nav(`/objectifs/${g.id}`)}>
                      <div className="row between">
                        <span className="small" style={{ fontWeight: 600 }}>
                          {g.title}
                        </span>
                        {g.metric !== 'check' && (
                          <span className="tiny muted">
                            {goalValue(g, g.progress.done)} / {goalValue(g, g.target)}
                          </span>
                        )}
                      </div>
                      {g.metric !== 'check' && <Progress percent={g.progress.percent} />}
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            <section className="card">
              <button className="row" style={{ all: 'unset', display: 'flex', gap: 10, alignItems: 'center', width: '100%', cursor: 'pointer' }} onClick={() => openPending()} data-testid="pending-count">
                <Icon.wallet style={{ width: 24 }} />
                <span className="grow">
                  <strong>{d.pendingDrafts}</strong> dépense{d.pendingDrafts > 1 ? 's' : ''} en attente de validation
                </span>
                <Icon.chevronR style={{ width: 18 }} />
              </button>
            </section>
          </div>
        </div>
      )}
      {reorg && d && <ReorganizeDialog date={d.date} onClose={() => (setReorg(false), qc.invalidateQueries())} />}
    </>
  );
}
