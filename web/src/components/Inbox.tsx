import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { dayLabel, dt, time } from '../lib/format';
import { Icon, Sheet } from './ui';
import { MonthlyExpenses, SavingsGoalForm } from './MonthlyExpenses';

type Task = { id: string; title: string; detail: string; done: boolean; open?: 'expenses' | 'savings'; links?: { label: string; to: string }[] };
type Alert = { id: string; kind: 'error' | 'bill' | 'drafts' | 'notification'; title: string; body: string; at: string | null; to: string | null; unread: boolean };
type Inbox = { tasks: Task[]; alerts: Alert[]; badge: number; openTasks: number };

export const useInbox = () => useQuery({ queryKey: ['inbox'], queryFn: () => api.get<Inbox>('/api/inbox'), refetchInterval: 60_000 });

/** Cloche en haut à droite : alertes et tâches à faire, avec pastille du nombre en attente. */
export function InboxButton() {
  const q = useInbox();
  const [open, setOpen] = useState(false);
  const n = q.data?.badge || 0;
  return (
    <>
      <button className="round-btn bell-btn" onClick={() => setOpen(true)} aria-label={n ? `Alertes et tâches, ${n} en attente` : 'Alertes et tâches'} data-testid="bell">
        <Icon.bell />
        {n > 0 && (
          <span className="badge" aria-hidden="true">
            {n > 9 ? '9+' : n}
          </span>
        )}
      </button>
      {open && <InboxSheet onClose={() => setOpen(false)} />}
    </>
  );
}

const KIND_ICON: Record<Alert['kind'], keyof typeof Icon> = { error: 'repeat', bill: 'wallet', drafts: 'chat', notification: 'bell' };

function InboxSheet({ onClose }: { onClose: () => void }) {
  const q = useInbox();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [panel, setPanel] = useState<'expenses' | 'savings' | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['inbox'] });

  // Les rappels déjà vus ne comptent plus dans la pastille une fois la cloche ouverte
  useEffect(() => {
    const t = setTimeout(() => api.post('/api/inbox/read').then((d) => qc.setQueryData(['inbox'], d)), 1500);
    return () => clearTimeout(t);
  }, [qc]);

  const go = (to: string) => (onClose(), nav(to));
  const d = q.data;

  if (panel === 'expenses')
    return (
      <Sheet
        title="Mes dépenses mensuelles"
        onClose={() => (setPanel(null), refresh())}
        tall
        footer={
          <button className="btn primary block" onClick={async () => (await api.post('/api/onboarding/step', { step: 'expenses', state: 'done' }), refresh(), setPanel(null))}>
            C’est tout, j’ai terminé
          </button>
        }
      >
        <p className="muted small" style={{ marginTop: 0 }}>
          Ajoute tes paiements fixes : loyer, Hydro, cellulaire, assurances… Ils deviennent des rappels et comptent dans ton budget.
        </p>
        <MonthlyExpenses />
      </Sheet>
    );
  if (panel === 'savings')
    return (
      <Sheet title="Mon objectif d’épargne" onClose={() => (setPanel(null), refresh())}>
        <SavingsGoalForm onCreated={() => (refresh(), setPanel(null))} />
      </Sheet>
    );

  const open = d?.tasks.filter((t) => !t.done) || [];
  const done = d?.tasks.filter((t) => t.done) || [];
  return (
    <Sheet title="Alertes et tâches" onClose={onClose} tall>
      {!d ? (
        <div className="empty">Chargement…</div>
      ) : (
        <div className="stack inbox">
          <section aria-labelledby="inbox-tasks">
            <div className="row between" style={{ margin: '0 16px 8px' }}>
              <h3 className="group-label" id="inbox-tasks" style={{ margin: 0 }}>
                À faire
              </h3>
              <span className="tiny muted">
                {done.length} sur {d.tasks.length} terminé{done.length > 1 ? 's' : ''}
              </span>
            </div>
            <div className="task-progress" aria-hidden="true">
              <span style={{ width: `${(done.length / Math.max(1, d.tasks.length)) * 100}%` }} />
            </div>
            <ul className="group" data-testid="tasks">
              {open.map((t) => (
                <li key={t.id} className="task" data-task={t.id}>
                  <span className="task-check" aria-hidden="true" />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="block" style={{ fontWeight: 600 }}>
                      {t.title}
                    </span>
                    <span className="tiny muted block">{t.detail}</span>
                    {t.links && (
                      <span className="row wrap" style={{ marginTop: 8, gap: 6 }}>
                        {t.links.map((l) => (
                          <button key={l.to} className="btn small" onClick={() => go(l.to)}>
                            {l.label}
                          </button>
                        ))}
                      </span>
                    )}
                  </span>
                  {t.open && (
                    <button className="btn small primary" onClick={() => setPanel(t.open!)}>
                      {t.open === 'expenses' ? 'Terminer' : 'Choisir'}
                    </button>
                  )}
                </li>
              ))}
              {done.map((t) => (
                <li key={t.id} className="task done" data-task={t.id}>
                  <span className="task-check done" aria-hidden="true">
                    <Icon.check />
                  </span>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="block done-text">{t.title}</span>
                    <span className="tiny muted">{t.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
            {open.length === 0 && <p className="small muted center" style={{ marginTop: 10 }}>Tout est fait. Bravo !</p>}
          </section>

          <section aria-labelledby="inbox-alerts">
            <h3 className="group-label" id="inbox-alerts">
              Alertes
            </h3>
            {d.alerts.length === 0 ? (
              <div className="empty">Rien de nouveau pour l’instant.</div>
            ) : (
              <ul className="group" data-testid="alerts">
                {d.alerts.map((a) => {
                  const I = Icon[KIND_ICON[a.kind]];
                  return (
                    <li key={a.id} className={`alert ${a.kind}${a.unread ? ' unread' : ''}`}>
                      <span className="alert-icon" aria-hidden="true">
                        <I />
                      </span>
                      <button className="alert-body" onClick={() => a.to && go(a.to)} disabled={!a.to}>
                        <span className="block" style={{ fontWeight: a.unread ? 600 : 500 }}>
                          {a.title}
                        </span>
                        <span className="tiny muted block">
                          {a.body}
                          {a.at ? ` · ${dayLabel(dt(a.at).toISODate()!)} ${time(a.at)}` : ''}
                        </span>
                      </button>
                      {a.unread && <span className="unread-dot" aria-label="Non lu" />}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      )}
    </Sheet>
  );
}
