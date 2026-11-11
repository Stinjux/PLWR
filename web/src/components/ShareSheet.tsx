import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Avatar, ROLE_HINT, ROLE_LABEL, type Role } from '../lib/people';
import { useApp } from '../App';
import { Icon, Seg, Sheet, useToast } from './ui';

type Sharing = {
  members: { id: string; name: string; initial: string; email: string; color: string; role: Role }[];
  invites: { id: string; email: string; role: Role; expiresAt: string; url: string }[];
  link: string | null;
  sharedWithMe: { id: string; name: string; initial: string; color: string; role: Role }[];
};

const ROLES: Role[] = ['edit', 'view', 'busy'];
const SHORT: Record<Role, string> = { edit: 'Modifier', view: 'Voir', busy: 'Occupé' };

async function copy(text: string, toast: (s: string) => void, label = 'Lien copié') {
  try {
    await navigator.clipboard.writeText(text);
    toast(label);
  } catch {
    window.prompt('Copie ce lien :', text);
  }
}

/** Partage natif (iPhone : Messages, Courriel…) avec repli sur la copie. */
async function shareLink(url: string, toast: (s: string) => void) {
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Agenda PLWR', text: 'Je t’invite à voir mon agenda.', url });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  copy(url, toast);
}

export function ShareSheet({ onClose }: { onClose: () => void }) {
  const { me } = useApp();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['sharing'], queryFn: () => api.get<Sharing>('/api/sharing') });
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('edit');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [justInvited, setJustInvited] = useState<{ email: string; url: string } | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['sharing'] });
    qc.invalidateQueries({ queryKey: ['people'] });
    qc.invalidateQueries({ queryKey: ['events'] });
  };

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ email: string; url: string }>('/api/sharing/invites', { email, role });
      setJustInvited(r);
      setEmail('');
      refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function act(fn: () => Promise<any>, msg?: string) {
    try {
      await fn();
      if (msg) toast(msg);
      refresh();
    } catch (err) {
      toast((err as Error).message);
    }
  }

  const d = q.data;
  return (
    <Sheet title="Partager l’agenda" onClose={onClose} tall>
      <div className="stack share">
        <p className="muted small center" style={{ margin: '0 8px' }}>
          Les personnes invitées voient ton agenda en temps réel. Chacun garde sa couleur, et tu choisis ce qu’elles peuvent faire.
        </p>

        <form className="stack" onSubmit={invite} style={{ gap: 10 }}>
          <div className="invite-row">
            <label className="sr-only" htmlFor="invite-email">
              Courriel de la personne à inviter
            </label>
            <input id="invite-email" className="input" type="email" placeholder="Courriel" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="off" />
            <button className="btn primary" disabled={busy}>
              Inviter
            </button>
          </div>
          <Seg full label="Accès de la personne invitée" value={role} options={ROLES.map((r) => [r, SHORT[r]] as [Role, string])} onChange={setRole} />
          <div className="tiny muted">{ROLE_HINT[role]}.</div>
          {error && <div className="error">{error}</div>}
        </form>

        {justInvited && (
          <div className="banner info" data-testid="invite-ready">
            <div className="grow small">
              Invitation prête pour <strong>{justInvited.email}</strong>. Envoie-lui ce lien (valable 14 jours).
            </div>
            <button className="btn small" onClick={() => shareLink(justInvited.url, toast)}>
              <Icon.link /> Envoyer
            </button>
          </div>
        )}

        {d && d.invites.length > 0 && (
          <section>
            <h3 className="group-label">En attente · {d.invites.length}</h3>
            <ul className="group">
              {d.invites.map((i) => (
                <li key={i.id}>
                  <span className="avatar pending" aria-hidden="true">
                    <Icon.users />
                  </span>
                  <span className="grow">
                    <span className="ellipsis block">{i.email}</span>
                    <span className="tiny muted">{ROLE_LABEL[i.role]} · pas encore accepté</span>
                  </span>
                  <button className="icon-btn" aria-label={`Copier le lien d’invitation de ${i.email}`} onClick={() => copy(i.url, toast)}>
                    <Icon.copy />
                  </button>
                  <button className="icon-btn" aria-label={`Annuler l’invitation de ${i.email}`} onClick={() => act(() => api.del(`/api/sharing/invites/${i.id}`), 'Invitation annulée')}>
                    <Icon.close />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <h3 className="group-label">Membres · {(d?.members.length || 0) + 1}</h3>
          <ul className="group">
            <li>
              <Avatar person={{ initial: (me.user.name || me.user.email).charAt(0).toUpperCase(), color: me.user.color, name: me.user.name || 'Moi' }} size={36} />
              <span className="grow">
                <span className="block">{me.user.name || 'Moi'}</span>
                <span className="tiny muted">Vous</span>
              </span>
              <span className="small muted">Propriétaire</span>
            </li>
            {d?.members.map((m) => (
              <li key={m.id} data-testid="member">
                <Avatar person={m} size={36} />
                <span className="grow" style={{ minWidth: 0 }}>
                  <span className="block ellipsis">{m.name}</span>
                  <span className="tiny muted">{ROLE_HINT[m.role]}</span>
                </span>
                <label className="sr-only" htmlFor={`role-${m.id}`}>
                  Accès de {m.name}
                </label>
                <select id={`role-${m.id}`} className="pill-select" value={m.role} onChange={(e) => act(() => api.patch(`/api/sharing/members/${m.id}`, { role: e.target.value }), `${m.name} : ${ROLE_LABEL[e.target.value as Role]}`)}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABEL[r]}
                    </option>
                  ))}
                </select>
                <button
                  className="icon-btn"
                  aria-label={`Retirer ${m.name}`}
                  onClick={() => confirm(`Retirer l’accès de ${m.name} à ton agenda ?`) && act(() => api.del(`/api/sharing/members/${m.id}`), `${m.name} n’a plus accès`)}
                >
                  <Icon.close />
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h3 className="group-label">Lien d’invitation</h3>
          <ul className="group">
            <li>
              <span className="grow">Partager par lien</span>
              <button
                type="button"
                role="switch"
                aria-checked={Boolean(d?.link)}
                aria-label="Partager par lien"
                className={`switch${d?.link ? ' on' : ''}`}
                onClick={() => act(() => api.post('/api/sharing/link', { enabled: !d?.link }), d?.link ? 'Lien désactivé' : 'Lien activé')}
              >
                <span />
              </button>
            </li>
            <li>
              <button className="link-row" disabled={!d?.link} onClick={() => d?.link && shareLink(d.link, toast)}>
                <Icon.link /> Envoyer le lien
              </button>
            </li>
          </ul>
          <p className="tiny muted" style={{ margin: '8px 16px 0' }}>
            Le lien donne l’accès « Peut voir » à toute personne qui l’ouvre. Coupe-le quand tout le monde est entré. Retirer une personne coupe son accès tout de suite.
          </p>
        </section>

        <a className="banner info small" href="/reglages/google" style={{ textDecoration: 'none', color: 'inherit' }}>
          <Icon.calendar style={{ width: 18, height: 18, flex: 'none' }} />
          <span className="grow">Pour que tout soit synchronisé, chaque personne relie son Google Agenda : Réglages → Google Agenda (guide pas à pas).</span>
          <Icon.chevronR style={{ width: 18, height: 18, flex: 'none' }} />
        </a>

        {d && d.sharedWithMe.length > 0 && (
          <section>
            <h3 className="group-label">Agendas partagés avec moi</h3>
            <ul className="group">
              {d.sharedWithMe.map((o) => (
                <li key={o.id}>
                  <Avatar person={o} size={36} />
                  <span className="grow">
                    <span className="block">{o.name}</span>
                    <span className="tiny muted">{ROLE_LABEL[o.role]}</span>
                  </span>
                  <button className="btn small ghost danger" onClick={() => confirm(`Quitter l’agenda de ${o.name} ?`) && act(() => api.del(`/api/sharing/shared/${o.id}`), `Tu as quitté l’agenda de ${o.name}`)}>
                    Quitter
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </Sheet>
  );
}
