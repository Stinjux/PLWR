import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DateTime } from 'luxon';
import { api } from '../lib/api';
import { goalValue, todayIso, duration } from '../lib/format';
import { Icon, Progress, Seg, Sheet, useToast, Check } from '../components/ui';

const PERIOD: Record<string, string> = { once: 'Ponctuel', daily: 'Chaque jour', weekly: 'Chaque semaine', monthly: 'Chaque mois' };
const METRIC: Record<string, string> = { check: 'À cocher', quantity: 'Quantité', duration: 'Durée', amount: 'Montant' };

export function Goals() {
  const q = useQuery({ queryKey: ['goals'], queryFn: () => api.get<any[]>('/api/goals') });
  const [edit, setEdit] = useState<any | null>(null);
  const nav = useNavigate();
  return (
    <>
      <div className="page-head">
        <h1>Objectifs</h1>
        <button className="btn primary small" onClick={() => setEdit({})}>
          + Objectif
        </button>
      </div>
      {q.data?.length === 0 && <div className="empty">Crée ton premier objectif : cinq séances de gym par semaine, six heures de CFA…</div>}
      <div className="stack">
        {q.data?.map((g) => (
          <section key={g.id} className="card clickable" style={{ cursor: 'pointer' }} onClick={() => nav(`/objectifs/${g.id}`)} data-testid="goal-card" data-title={g.title}>
            <div className="row between" style={{ alignItems: 'flex-start' }}>
              <div>
                <h2 style={{ marginBottom: 2 }}>{g.title}</h2>
                <div className="tiny muted">
                  {METRIC[g.metric]} · {PERIOD[g.period]} · {g.progress.period.label}
                  {g.linkedBlocks ? ` · ${g.linkedBlocks} bloc(s) lié(s)` : ''}
                </div>
              </div>
              {g.progress.completed && <span className="chip ok">Atteint</span>}
            </div>
            <div style={{ margin: '10px 0 6px' }}>
              <Progress percent={g.progress.percent} />
            </div>
            <div className="row between small">
              <span data-testid="goal-progress">
                <strong>{goalValue(g, g.progress.done)}</strong> / {goalValue(g, g.target)}
              </span>
              <span className="muted">Reste {goalValue(g, g.progress.remaining)}</span>
            </div>
          </section>
        ))}
      </div>
      {edit && <GoalEditor goal={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

export function GoalEditor({ goal, onClose }: { goal: any; onClose: () => void }) {
  const qc = useQueryClient();
  const isNew = !goal.id;
  const [f, setF] = useState({
    title: goal.title || '',
    metric: goal.metric || 'quantity',
    target: goal.metric === 'duration' ? String(goal.target / 60) : String(goal.target ?? ''),
    unit: goal.unit || '',
    period: goal.period || 'weekly',
    deadline: goal.deadline || '',
    reminderDays: goal.reminderDays ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  async function save() {
    const target = f.metric === 'check' ? 1 : f.metric === 'duration' ? Number(f.target.replace(',', '.')) * 60 : Number(f.target.replace(',', '.'));
    const body = { ...f, target, unit: f.metric === 'duration' ? 'min' : f.metric === 'amount' ? '$' : f.unit, deadline: f.deadline || null, reminderDays: f.reminderDays === '' ? null : Number(f.reminderDays) };
    try {
      if (isNew) await api.post('/api/goals', body);
      else await api.patch(`/api/goals/${goal.id}`, body);
      qc.invalidateQueries();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <Sheet title={isNew ? 'Nouvel objectif' : 'Modifier l’objectif'} onClose={onClose} footer={<button className="btn primary block" onClick={save}>Enregistrer</button>}>
      <div className="stack">
        <label className="field">
          Titre
          <input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Ex. : Trouver 50 leads MONDAIX" aria-label="Titre de l’objectif" />
        </label>
        <label className="field">
          Mesure
          <select className="input" value={f.metric} onChange={(e) => setF({ ...f, metric: e.target.value })}>
            <option value="check">À cocher</option>
            <option value="quantity">Quantité (séances, leads…)</option>
            <option value="duration">Durée (heures)</option>
            <option value="amount">Montant ($)</option>
          </select>
        </label>
        {f.metric !== 'check' && (
          <div className="form-grid">
            <label className="field">
              Cible {f.metric === 'duration' ? '(heures)' : f.metric === 'amount' ? '($)' : ''}
              <input className="input" inputMode="decimal" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} aria-label="Cible" />
            </label>
            {f.metric === 'quantity' && (
              <label className="field">
                Unité
                <input className="input" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} placeholder="séances, leads…" />
              </label>
            )}
          </div>
        )}
        <label className="field">
          Fréquence
          <select className="input" value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })}>
            <option value="once">Ponctuel (une fois)</option>
            <option value="daily">Chaque jour</option>
            <option value="weekly">Chaque semaine</option>
            <option value="monthly">Chaque mois</option>
          </select>
        </label>
        <div className="form-grid">
          <label className="field">
            Échéance
            <input className="input" type="date" value={f.deadline} onChange={(e) => setF({ ...f, deadline: e.target.value })} />
          </label>
          <label className="field">
            Rappel (jours avant)
            <input className="input" type="number" min={0} value={f.reminderDays} onChange={(e) => setF({ ...f, reminderDays: e.target.value })} />
          </label>
        </div>
        {error && <div className="error">{error}</div>}
      </div>
    </Sheet>
  );
}

export function GoalDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['goal', id], queryFn: () => api.get<any>(`/api/goals/${id}`) });
  const [group, setGroup] = useState<'week' | 'month'>('week');
  const [edit, setEdit] = useState(false);
  const [value, setValue] = useState('');
  const g = q.data;
  if (!g) return <div className="empty">Chargement…</div>;
  const hist = g.history[group];
  const max = Math.max(1, hist.target || 0, ...hist.buckets.map((b: any) => b.value));

  async function addEntry() {
    const raw = Number(value.replace(',', '.'));
    if (!Number.isFinite(raw)) return toast('Valeur invalide');
    const v = g.metric === 'duration' ? raw : raw;
    await api.post(`/api/goals/${g.id}/entries`, { value: v, date: todayIso() });
    setValue('');
    qc.invalidateQueries();
  }
  async function removeEntry(eid: string) {
    await api.del(`/api/goals/${g.id}/entries/${eid}`);
    qc.invalidateQueries();
  }
  async function archive() {
    await api.patch(`/api/goals/${g.id}`, { archived: !g.archived });
    qc.invalidateQueries();
    nav('/objectifs');
  }
  async function del() {
    if (!confirm('Supprimer cet objectif et son historique ?')) return;
    await api.del(`/api/goals/${g.id}`);
    qc.invalidateQueries();
    nav('/objectifs');
  }

  return (
    <>
      <div className="page-head">
        <div>
          <Link to="/objectifs" className="small">
            ← Objectifs
          </Link>
          <h1>{g.title}</h1>
          <div className="small muted">
            {METRIC[g.metric]} · {PERIOD[g.period]}
            {g.deadline ? ` · échéance ${DateTime.fromISO(g.deadline).toFormat('d LLLL yyyy')}` : ''}
          </div>
        </div>
        <button className="icon-btn" onClick={() => setEdit(true)} aria-label="Modifier">
          <Icon.edit />
        </button>
      </div>
      <div className="grid-2">
        <div>
          <section className="card">
            <div className="small muted">{g.progress.period.label}</div>
            <div className="stats" style={{ margin: '8px 0' }}>
              <div className="stat">
                <span className="tiny muted">Fait</span>
                <span className="v" data-testid="goal-done">{goalValue(g, g.progress.done)}</span>
              </div>
              <div className="stat">
                <span className="tiny muted">Cible</span>
                <span className="v">{goalValue(g, g.target)}</span>
              </div>
              <div className="stat">
                <span className="tiny muted">Reste</span>
                <span className="v" data-testid="goal-remaining">{goalValue(g, g.progress.remaining)}</span>
              </div>
            </div>
            <Progress percent={g.progress.percent} />
          </section>
          <section className="card">
            <div className="card-title">
              <h2>Historique</h2>
              <Seg
                label="Regrouper"
                value={group}
                options={[
                  ['week', 'Semaine'],
                  ['month', 'Mois'],
                ]}
                onChange={setGroup}
              />
            </div>
            <div className="bars" aria-label="Historique de progression">
              {hist.target ? <div className="target" style={{ bottom: `calc(${(hist.target / max) * 100}% * 0.78 + 30px)` }} title="Cible" /> : null}
              {hist.buckets.map((b: any) => (
                <div key={b.key} className={`bar${hist.target && b.value >= hist.target ? ' met' : ''}`}>
                  <span className="val">{b.value ? (g.metric === 'duration' ? duration(b.value) : goalValue(g, b.value).replace(/ .*/, '')) : ''}</span>
                  <span className="fill" style={{ height: `${(b.value / max) * 78}%` }} />
                  <span className="lbl">{b.label}</span>
                </div>
              ))}
            </div>
            {hist.target ? <div className="tiny muted">Pointillé : cible {group === 'week' ? 'hebdomadaire' : 'mensuelle'}</div> : null}
          </section>
        </div>
        <div>
          <section className="card">
            <h2>Ajouter un résultat</h2>
            {g.metric === 'check' ? (
              <button className="btn" onClick={() => api.post(`/api/goals/${g.id}/check`, { checked: true }).then(() => qc.invalidateQueries())}>
                Cocher pour aujourd’hui
              </button>
            ) : (
              <div className="row">
                <input className="input" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} placeholder={g.metric === 'duration' ? 'minutes' : g.metric === 'amount' ? '$' : g.unit || 'quantité'} aria-label="Valeur" />
                <button className="btn primary" onClick={addEntry}>
                  Ajouter
                </button>
              </div>
            )}
          </section>
          <section className="card">
            <h2>Blocs liés dans l’agenda</h2>
            {g.links.length === 0 && <div className="small muted">Lie des blocs depuis l’agenda (section « Objectifs liés » d’un bloc).</div>}
            <ul className="list">
              {g.links.map((l: any) => (
                <li key={l.id}>
                  <span className="grow">{l.title}</span>
                  <span className="tiny muted">
                    {l.recurring ? 'récurrent · ' : ''}
                    {duration(l.durationMin)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
          <section className="card">
            <h2>Résultats enregistrés</h2>
            {g.entries.length === 0 && <div className="small muted">Aucun résultat pour l’instant.</div>}
            <ul className="list" data-testid="goal-entries">
              {g.entries.map((e: any) => (
                <li key={e.id}>
                  <div className="grow">
                    <div className="small" style={{ fontWeight: 600 }}>
                      {goalValue(g, e.value)}
                      {e.planned ? <span className="muted"> sur {goalValue(g, e.planned)} prévus</span> : null}
                    </div>
                    <div className="tiny muted">
                      {DateTime.fromISO(e.date).toFormat('ccc d LLL')}
                      {e.eventTitle ? ` · ${e.eventTitle}` : ''}
                      {e.note ? ` · ${e.note}` : ''}
                    </div>
                  </div>
                  <button className="icon-btn" aria-label="Supprimer ce résultat" onClick={() => removeEntry(e.id)}>
                    <Icon.trash />
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn small" onClick={archive}>
              {g.archived ? 'Désarchiver' : 'Archiver'}
            </button>
            <button className="btn small danger" onClick={del}>
              Supprimer
            </button>
          </div>
        </div>
      </div>
      {edit && <GoalEditor goal={g} onClose={() => setEdit(false)} />}
    </>
  );
}

export { Check };
