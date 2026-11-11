import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import { enablePush, pushSupport } from '../lib/push';
import { track } from '../lib/track';
import { useApp } from '../App';
import { Icon, useToast } from './ui';

/**
 * Bienvenue sur le tableau de bord, juste après l'accueil :
 * le résultat de la première action, comment l'app s'utilise, et UNE prochaine action qui en découle.
 * La permission des notifications n'est demandée que si la personne choisit un rappel.
 */
export function WelcomeCard() {
  const { me, openEditor, openChat } = useApp();
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const [reminded, setReminded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ob = me.onboarding;
  if (!ob?.completedAt || ob.welcomeSeen) return null;
  const path = ob.path || 'explore';
  const fa = ob.firstAction;
  const firstName = (me.user.name || '').split(' ')[0];

  async function dismiss() {
    await api.post('/api/onboarding/welcome-seen');
    qc.invalidateQueries({ queryKey: ['me'] });
  }
  function go(action: string, fn: () => void) {
    track('next_action_clicked', { path, action });
    fn();
  }

  /** Rappel 15 min avant l'élément créé à l'accueil ; la permission n'est demandée qu'ici. */
  async function remind() {
    if (!fa) return;
    setBusy(true);
    track('next_action_clicked', { path, action: 'reminder' });
    let result = 'server_off';
    const support = pushSupport();
    if (me.push.publicKey && support.supported) {
      try {
        await enablePush(me.push.publicKey);
        result = 'granted';
      } catch {
        result = typeof Notification !== 'undefined' && Notification.permission === 'denied' ? 'denied' : 'error';
      }
    } else if (me.push.publicKey) result = support.ios && !support.standalone ? 'ios_not_installed' : 'unsupported';
    track('reminder_permission', { result });
    try {
      await api.patch(`/api/events/${encodeURIComponent(fa.ref)}?scope=this`, { reminders: [15] });
      const msg: Record<string, string> = {
        granted: 'Rappel programmé 15 min avant, sur cet appareil.',
        denied: 'Rappel programmé. Les notifications sont bloquées : il s’affichera dans la cloche.',
        ios_not_installed: 'Rappel programmé. Sur iPhone, ajoute PLWR à l’écran d’accueil pour être notifié ; en attendant, il s’affichera dans la cloche.',
        server_off: 'Rappel programmé : il s’affichera dans la cloche.',
        unsupported: 'Rappel programmé : il s’affichera dans la cloche.',
        error: 'Rappel programmé : il s’affichera dans la cloche.',
      };
      setReminded(msg[result]);
      qc.invalidateQueries({ queryKey: ['reminders'] });
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const result =
    fa?.kind === 'event'
      ? { icon: 'calendar' as const, text: `Ajouté à ton agenda : ${fa.label}` }
      : fa?.kind === 'goal'
        ? { icon: 'target' as const, text: `Objectif créé. Première étape : ${fa.label}` }
        : fa?.kind === 'expense'
          ? { icon: 'wallet' as const, text: `Dépense enregistrée : ${fa.label}` }
          : null;

  let primary: { label: string; onClick: () => void } | null = null;
  let secondary: { label: string; onClick: () => void } | null = null;
  if ((path === 'week' || path === 'goal') && fa && !reminded) primary = { label: path === 'week' ? 'Me rappeler 15 min avant' : 'Me rappeler la première étape', onClick: remind };
  if (path === 'week') secondary = { label: 'Voir ma semaine', onClick: () => go('week_view', () => nav('/agenda')) };
  if (path === 'goal') secondary = { label: 'Voir mes objectifs', onClick: () => go('goals_view', () => nav('/objectifs')) };
  if (path === 'expense') {
    primary = { label: 'Voir mes dépenses de la semaine', onClick: () => go('expenses_week', () => nav('/budget?tab=transactions')) };
    secondary = { label: 'Ajouter une autre dépense', onClick: () => go('another_expense', openChat) };
  }
  if (path === 'explore' || !fa) {
    primary = { label: 'Ajouter mon premier événement', onClick: () => go('first_event', () => openEditor({ mode: 'new', kind: 'fixed' })) };
    secondary = { label: 'Écrire une dépense', onClick: () => go('first_expense', openChat) };
  }

  return (
    <section className="welcome" aria-labelledby="welcome-title" data-testid="welcome">
      <h2 id="welcome-title">Bienvenue{firstName ? `, ${firstName}` : ''}.</h2>
      <p className="welcome-lead">Ton espace est prêt. PLWR garde au même endroit ton agenda, tes objectifs et ton budget, pour que tu voies ta journée d’un coup d’œil.</p>
      {result && (
        <div className="welcome-result" data-testid="welcome-result">
          {(() => {
            const I = Icon[result.icon];
            return <I />;
          })()}
          <span>{result.text}</span>
        </div>
      )}
      {reminded && (
        <div className="welcome-result ok" role="status">
          <Icon.bell /> <span>{reminded}</span>
        </div>
      )}
      <ul className="welcome-how">
        <li>
          <Icon.today /> <span><b>Aujourd’hui</b> montre tes priorités et ton prochain rendez-vous.</span>
        </li>
        <li>
          <Icon.calendar /> <span><b>Agenda, Objectifs et Budget</b> sont dans la barre du bas (à gauche sur ordinateur).</span>
        </li>
        <li>
          <Icon.bell /> <span><b>La cloche</b>, en haut à droite, garde ce qu’il reste à faire, comme relier ton Google Agenda ou Outlook.</span>
        </li>
      </ul>
      <div className="welcome-actions">
        {primary && (
          <button className="btn primary" onClick={primary.onClick} disabled={busy}>
            {primary.label}
          </button>
        )}
        {secondary && (
          <button className="btn" onClick={secondary.onClick}>
            {secondary.label}
          </button>
        )}
        <button className="link-btn" onClick={dismiss}>
          J’ai compris
        </button>
      </div>
    </section>
  );
}
