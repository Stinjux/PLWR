import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { dayLabel, dt, duration, goalValue, longDate, time } from '../lib/format';
import { useApp } from '../App';
import { Check, Icon, Progress, Ring, useToast } from '../components/ui';
import { ReorganizeDialog } from '../components/ReorganizeDialog';
import type { Occ } from '../components/EventEditor';
import { WelcomeCard } from '../components/WelcomeCard';
import { DayAssistant } from '../components/DayAssistant';

type TodayData = {
  date: string;
  nextEvent: Occ | null;
  priorities: Occ[];
  tasks: Occ[];
  agenda: Occ[];
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
  // Ma journée : rendez-vous et blocs d'aujourd'hui (par heure), puis les tâches à placer
  const items: Occ[] = d ? [...d.agenda, ...d.tasks.filter((t) => !d.agenda.some((a) => a.id === t.id))].filter((o) => o.status !== 'cancelled') : [];
  items.sort((a, b) => (a.start && b.start ? a.start.localeCompare(b.start) : a.start ? -1 : b.start ? 1 : 0));
  const tasks = d?.tasks || [];
  const doneTasks = tasks.filter((t) => t.status === 'done').length;
  const nowIso = new Date().toISOString();

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">{d ? longDate(d.date) : ''}</div>
          <h1>
            {greeting}
            {me.user.name ? `, ${me.user.name}` : ''}
          </h1>
        </div>
        <button className="icon-btn" aria-label="Réglages" onClick={() => nav('/reglages')}>
          <Icon.settings />
        </button>
      </div>

      <WelcomeCard />

      {d && (
        <section className="hero day-hero" aria-label="Ma journée en bref">
          <div className="hero-body">
            <Ring percent={tasks.length ? (doneTasks / tasks.length) * 100 : 0} label={`${doneTasks}/${tasks.length}`} sub="tâches" />
            <div className="hero-figures">
              <span className="hero-label">Prochain</span>
              {d.nextEvent ? (
                <button className="hero-next" onClick={() => openEditor({ mode: 'edit', id: d.nextEvent!.id })}>
                  <strong>{d.nextEvent.title}</strong>
                  <span className="small muted block">
                    {dayLabel(dt(d.nextEvent.start!).toISODate()!)} · {time(d.nextEvent.start)}–{time(d.nextEvent.end)}
                    {d.nextEvent.location ? ` · ${d.nextEvent.location}` : ''}
                  </span>
                </button>
              ) : (
                <span className="small muted">Aucun rendez-vous à venir.</span>
              )}
              {d.overload.overloaded ? (
                <span className="status-chip warn" data-testid="overload">
                  Journée trop pleine : {duration(d.overload.neededMinutes)} pour {duration(d.overload.freeMinutes)} libres
                </span>
              ) : (
                <span className="status-chip ok">{duration(d.overload.freeMinutes)} libres aujourd’hui</span>
              )}
            </div>
          </div>
          <div className="quick-actions">
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
        </section>
      )}

      {q.isLoading && <div className="empty">Chargement…</div>}
      {d && (
        <div className="grid-2">
          <div>
            <section className="card">
              <div className="card-title">
                <h2>Ma journée</h2>
                <span className="muted small">
                  {items.length} élément{items.length > 1 ? 's' : ''}
                </span>
              </div>
              {items.length === 0 && <div className="empty">Rien de prévu aujourd’hui. Ajoute un événement ou demande à l’assistant.</div>}
              <ul className="timeline-list" data-testid="today-tasks">
                {items.map((t) => {
                  const past = t.end && t.end < nowIso;
                  const current = t.start && t.end && t.start <= nowIso && t.end > nowIso;
                  return (
                    <li key={t.id} className={`tl-item ${t.kind}${t.status === 'done' ? ' done' : ''}${current ? ' current' : ''}${past && t.status !== 'done' ? ' past' : ''}`}>
                      <span className="tl-time">{t.start ? time(t.start) : 'À placer'}</span>
                      <span className="tl-dot" aria-hidden="true" />
                      <span className="clickable grow" onClick={() => openEditor({ mode: 'edit', id: t.id })}>
                        <span className={`tl-title${t.status === 'done' ? ' done-text' : ''}`}>{t.title}</span>
                        <span className="tiny muted block">
                          {t.kind === 'fixed' ? 'Rendez-vous' : 'Tâche'} · {duration(t.durationMin)}
                          {t.location ? ` · ${t.location}` : ''}
                          {current ? ' · en cours' : ''}
                        </span>
                      </span>
                      {t.kind === 'flexible' && <Check on={t.status === 'done'} label={`Terminer ${t.title}`} onToggle={() => toggleTask(t)} />}
                    </li>
                  );
                })}
              </ul>
              <button className="btn block" style={{ marginTop: 12 }} onClick={() => setReorg(true)}>
                <Icon.shuffle /> Réorganiser ma journée
              </button>
            </section>

            <section className="card">
              <div className="card-title">
                <h2>Mes 3 priorités</h2>
              </div>
              {d.priorities.length === 0 && <div className="empty">Ajoute une tâche ou mets-en une en priorité (★).</div>}
              <ul className="list" data-testid="priorities">
                {d.priorities.map((t, i) => (
                  <li key={t.id}>
                    <Check on={t.status === 'done'} label={`Terminer ${t.title} (priorité)`} onToggle={() => toggleTask(t)} />
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
          </div>

          <div>
            <DayAssistant />

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
                {d.goals.length === 0 && <li className="small muted">Aucun objectif pour l’instant.</li>}
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
