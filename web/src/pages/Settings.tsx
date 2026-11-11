import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { dayLabel, dt, time } from '../lib/format';
import { currentSubscription, disablePush, enablePush, pushSupport } from '../lib/push';
import { useApp } from '../App';
import { Icon, useToast } from '../components/ui';

export function Settings() {
  const { me } = useApp();
  const qc = useQueryClient();
  const toast = useToast();
  const [s, setS] = useState<any>(me.settings);
  const [subscribed, setSubscribed] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const support = pushSupport();
  const upcoming = useQuery({ queryKey: ['reminders'], queryFn: () => api.get<any[]>('/api/reminders/upcoming?days=7') });
  const history = useQuery({ queryKey: ['notifications'], queryFn: () => api.get<any[]>('/api/notifications') });
  useEffect(() => {
    currentSubscription().then((x) => setSubscribed(Boolean(x)));
  }, []);

  async function save(patch: any) {
    const next = { ...s, ...patch };
    setS(next);
    await api.patch('/api/me/settings', patch);
    qc.invalidateQueries({ queryKey: ['me'] });
    qc.invalidateQueries({ queryKey: ['reminders'] });
  }
  async function togglePush() {
    try {
      if (subscribed) {
        await disablePush();
        setSubscribed(false);
        toast('Notifications désactivées sur cet appareil');
      } else {
        await enablePush(me.push.publicKey!);
        setSubscribed(true);
        toast('Notifications activées sur cet appareil');
      }
      qc.invalidateQueries({ queryKey: ['me'] });
    } catch (e) {
      toast((e as Error).message);
    }
  }
  async function test() {
    const r = await api.post('/api/push/test');
    setTestResult(
      r.disabled
        ? `Push désactivé sur le serveur${r.errors?.[0] ? ` : ${r.errors[0]}` : ''}. La notification est seulement dans l’historique.`
        : r.sent
          ? `Envoyée à ${r.sent} appareil(s)${r.failed ? `, échec pour ${r.failed} : ${r.errors.join(' ; ')}` : ''}. Si rien n’apparaît, vérifie les réglages de notification du téléphone et le mode Concentration.`
          : r.failed
            ? `Échec : ${r.errors.join(' ; ')}`
            : 'Aucun appareil abonné : touche « Activer les notifications » sur ce téléphone.',
    );
    qc.invalidateQueries({ queryKey: ['notifications'] });
    qc.invalidateQueries({ queryKey: ['me'] });
  }
  async function deleteSamples() {
    if (!confirm('Supprimer tous les exemples (tâches, objectifs, transactions et paiements d’exemple) ?')) return;
    await api.post('/api/samples/delete');
    qc.invalidateQueries();
    toast('Exemples supprimés');
  }
  async function logout() {
    await api.post('/api/auth/logout');
    qc.setQueryData(['me'], null);
  }

  return (
    <>
      <div className="page-head">
        <h1>Réglages</h1>
      </div>
      <div className="stack">
        <section className="card">
          <h2>
            <Icon.bell style={{ width: 18, verticalAlign: -3 }} /> Rappels sur ce téléphone
          </h2>
          {!me.push.enabled && (
            <div className="banner danger small">
              {me.push.error || 'Le serveur n’a pas de clés VAPID (variables VAPID_PUBLIC_KEY et VAPID_PRIVATE_KEY) : les notifications push sont désactivées.'} Les rappels restent visibles dans l’historique et quand l’app est ouverte.
            </div>
          )}
          {me.push.enabled && !support.supported && <div className="banner small">{support.reason}</div>}
          {me.push.enabled && support.supported && (
            <div className="row between">
              <span className="small">
                {subscribed ? 'Activés sur cet appareil' : 'Désactivés sur cet appareil'}
                {subscribed && me.push.subscriptions === 0 && <span className="tiny" style={{ color: 'var(--danger)' }}> · inconnu du serveur : désactive puis réactive</span>}
              </span>
              <button className={`btn small${subscribed ? '' : ' primary'}`} onClick={togglePush}>
                {subscribed ? 'Désactiver' : 'Activer les notifications'}
              </button>
            </div>
          )}
          <div className="row wrap" style={{ marginTop: 10 }}>
            <button className="btn small" onClick={test} data-testid="test-notification">
              Envoyer une notification de test
            </button>
            <span className="tiny muted">{me.push.subscriptions} appareil(s) abonné(s) sur le serveur</span>
          </div>
          {testResult && (
            <div className="banner info small" style={{ marginTop: 8 }} data-testid="test-result">
              {testResult}
            </div>
          )}
          <div className="form-grid" style={{ marginTop: 12 }}>
            <label className="row small full">
              <input type="checkbox" checked={s.quietHours.enabled} onChange={(e) => save({ quietHours: { ...s.quietHours, enabled: e.target.checked } })} /> Heures silencieuses (les rappels sont décalés à la fin)
            </label>
            <label className="field">
              Début
              <input className="input" type="time" value={s.quietHours.start} onChange={(e) => save({ quietHours: { ...s.quietHours, start: e.target.value } })} />
            </label>
            <label className="field">
              Fin
              <input className="input" type="time" value={s.quietHours.end} onChange={(e) => save({ quietHours: { ...s.quietHours, end: e.target.value } })} />
            </label>
            <label className="field">
              Rappel par défaut (min avant)
              <input className="input" type="number" min={0} value={s.defaultReminderMinutes} onChange={(e) => save({ defaultReminderMinutes: Number(e.target.value) })} />
            </label>
            <label className="field">
              « Reporter » (minutes)
              <input className="input" type="number" min={5} value={s.snoozeMinutes} onChange={(e) => save({ snoozeMinutes: Number(e.target.value) })} />
            </label>
          </div>
          <details style={{ marginTop: 10 }}>
            <summary className="small" style={{ cursor: 'pointer', fontWeight: 600 }}>
              Activer sur iPhone ou Android
            </summary>
            <div className="small" style={{ marginTop: 6 }}>
              <p>
                <strong>iPhone (iOS 16.4 ou plus récent)</strong> : ouvre l’app dans Safari → bouton Partager → « Sur l’écran d’accueil ». Ouvre PLWR depuis l’icône, puis touche « Activer les notifications ». Les boutons d’action ne sont pas
                affichés par iOS : touche la notification pour ouvrir une page avec « Reporter ».
              </p>
              <p>
                <strong>Android (Chrome, Edge, Firefox)</strong> : touche « Activer les notifications » et accepte. Les notifications affichent « Reporter 10 min ». Pour une livraison fiable, retire l’optimisation de batterie pour le
                navigateur.
              </p>
            </div>
          </details>
        </section>

        <section className="card">
          <h2>Rappels à venir (7 jours)</h2>
          {upcoming.data?.length === 0 && <div className="small muted">Aucun rappel prévu.</div>}
          <ul className="list" data-testid="upcoming-reminders">
            {upcoming.data?.slice(0, 15).map((r) => (
              <li key={r.key}>
                <div className="grow">
                  <div className="small" style={{ fontWeight: 600 }}>
                    {r.title}
                  </div>
                  <div className="tiny muted">
                    {dayLabel(dt(r.fireAt).toISODate()!)} à {time(r.fireAt)}
                    {r.deferredByQuietHours ? ' · décalé (heures silencieuses)' : ''}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="card">
          <h2>Ma journée</h2>
          <div className="form-grid">
            <label className="field">
              Début de journée
              <input className="input" type="time" value={s.dayStart} onChange={(e) => save({ dayStart: e.target.value })} />
            </label>
            <label className="field">
              Fin de journée
              <input className="input" type="time" value={s.dayEnd} onChange={(e) => save({ dayEnd: e.target.value })} />
            </label>
            <label className="field full">
              Battement entre les blocs (min)
              <input className="input" type="number" min={0} max={60} value={s.bufferMinutes} onChange={(e) => save({ bufferMinutes: Number(e.target.value) })} />
            </label>
          </div>
          <h3 style={{ marginTop: 12 }}>Pauses à préserver</h3>
          {s.breaks.map((b: any, i: number) => (
            <div className="split-row" key={i} style={{ gridTemplateColumns: '1fr 90px 90px 40px', marginBottom: 6 }}>
              <input className="input" value={b.label} onChange={(e) => setS({ ...s, breaks: s.breaks.map((x: any, j: number) => (j === i ? { ...x, label: e.target.value } : x)) })} onBlur={() => save({ breaks: s.breaks })} aria-label="Nom de la pause" />
              <input className="input" type="time" value={b.start} onChange={(e) => save({ breaks: s.breaks.map((x: any, j: number) => (j === i ? { ...x, start: e.target.value } : x)) })} aria-label="Début" />
              <input className="input" type="time" value={b.end} onChange={(e) => save({ breaks: s.breaks.map((x: any, j: number) => (j === i ? { ...x, end: e.target.value } : x)) })} aria-label="Fin" />
              <button className="icon-btn" onClick={() => save({ breaks: s.breaks.filter((_: any, j: number) => j !== i) })} aria-label="Retirer la pause">
                <Icon.close />
              </button>
            </div>
          ))}
          <button className="btn small" onClick={() => save({ breaks: [...s.breaks, { label: 'Pause', start: '15:00', end: '15:15' }] })}>
            + Pause
          </button>
        </section>

        <section className="card">
          <h2>Images et confidentialité</h2>
          <div className="small">
            Lecture des images : <strong>{me.vision.provider}</strong> {me.vision.configured ? '' : '(clé API manquante : la saisie manuelle sera proposée)'}
            <br />
            Masquage automatique des numéros de carte avant l’envoi : {me.vision.redactCardNumbers ? 'activé' : 'désactivé'}
          </div>
          <label className="row small" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={s.keepImages} onChange={(e) => save({ keepImages: e.target.checked })} /> Conserver les images après validation (sinon elles sont supprimées)
          </label>
          <label className="row small" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={Boolean(s.simulateVisionError)} onChange={(e) => save({ simulateVisionError: e.target.checked })} data-testid="simulate-error" /> Mode test : simuler une erreur de lecture d’image
          </label>
        </section>

        <section className="card">
          <h2>Historique des notifications</h2>
          <ul className="list">
            {history.data?.slice(0, 10).map((n) => (
              <li key={n.id}>
                <div className="grow">
                  <div className="small" style={{ fontWeight: 600 }}>
                    {n.title}
                  </div>
                  <div className="tiny muted">
                    {n.body} · {dayLabel(dt(n.sent_at).toISODate()!)} {time(n.sent_at)} · {n.delivered ? `${n.delivered} appareil(s)` : 'non livrée en push'}
                  </div>
                </div>
                <a className="btn small" href={`/rappel?n=${n.id}`}>
                  Reporter
                </a>
              </li>
            ))}
            {history.data?.length === 0 && <li className="small muted">Aucune notification envoyée.</li>}
          </ul>
        </section>

        <section className="card">
          <h2>Compte</h2>
          <div className="small muted">
            {me.user.email} · fuseau {me.user.timezone} · dollar canadien
          </div>
          <div className="row wrap" style={{ marginTop: 10 }}>
            {me.hasSamples && (
              <button className="btn small danger" onClick={deleteSamples}>
                Supprimer les exemples
              </button>
            )}
            <button className="btn small" onClick={logout}>
              <Icon.logout /> Se déconnecter
            </button>
          </div>
        </section>
      </div>
    </>
  );
}
