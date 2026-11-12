import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { Icon, useToast } from './ui';

type Proposal = { id: string; type: 'complete' | 'move' | 'postpone' | 'plan'; title: string; detail: string; [k: string]: any };
type Msg = { role: 'user' | 'assistant'; text: string; proposals?: Proposal[] };
type ProposalState = Record<string, 'applied' | 'ignored' | 'busy'>;

const SUGGESTIONS: [string, boolean][] = [
  ['Où j’en suis ?', true],
  ['Mes objectifs', true],
  ['Réorganise ma journée', true],
  ['J’ai fait 30 min de ', false],
  ['J’ai fini ', false],
  ['Reporte  à demain', false],
];
const KEY = 'plwr.assistant';

/**
 * Assistant de la journée : bilan de l'avancement, réorganisation de la journée, déplacements et reports.
 * Chaque changement arrive comme une proposition à appliquer (rien n'est modifié sans un geste de la personne).
 */
export function DayAssistant() {
  const qc = useQueryClient();
  const toast = useToast();
  const day = useQuery({ queryKey: ['assistant-day'], queryFn: () => api.get<{ summary: string; items: any[] }>('/api/assistant/day') });
  const [msgs, setMsgs] = useState<Msg[]>(() => {
    try {
      const saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
      return saved?.date === new Date().toDateString() ? saved.msgs : [];
    } catch {
      return [];
    }
  });
  const [states, setStates] = useState<ProposalState>({});
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify({ date: new Date().toDateString(), msgs: msgs.slice(-20) }));
    } catch {}
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [msgs]);

  async function send(message: string) {
    const m = message.trim();
    if (!m || busy) return;
    const history = msgs.map((x) => ({ role: x.role, text: x.text }));
    setMsgs((x) => [...x, { role: 'user', text: m }]);
    setText('');
    setBusy(true);
    try {
      const r = await api.post<{ reply: string; proposals: Proposal[] }>('/api/assistant', { message: m, history });
      setMsgs((x) => [...x, { role: 'assistant', text: r.reply, proposals: r.proposals }]);
    } catch (e) {
      setMsgs((x) => [...x, { role: 'assistant', text: (e as Error).message }]);
    } finally {
      setBusy(false);
    }
  }
  async function apply(p: Proposal) {
    setStates((s) => ({ ...s, [p.id]: 'busy' }));
    try {
      const r = await api.post<{ message: string; summary: string }>('/api/assistant/apply', { proposal: p });
      setStates((s) => ({ ...s, [p.id]: 'applied' }));
      toast(r.message);
      qc.invalidateQueries();
    } catch (e) {
      setStates((s) => ({ ...s, [p.id]: undefined as any }));
      toast((e as Error).message);
    }
  }
  function suggest(s: string, sendNow: boolean) {
    if (sendNow) return send(s);
    setText(s);
    setTimeout(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const pos = s.indexOf('  ') >= 0 ? s.indexOf('  ') + 1 : s.length;
      el.setSelectionRange(pos, pos);
    }, 0);
  }

  return (
    <section className="card assistant" aria-labelledby="assistant-title" data-testid="assistant">
      <div className="assistant-head">
        <span className="assistant-icon" aria-hidden="true">
          <Icon.sparkle />
        </span>
        <div className="grow">
          <h2 id="assistant-title">Assistant de la journée</h2>
          <span className="tiny muted">Ta journée et tes objectifs : suivi, progrès, réorganisation. Tu valides chaque changement.</span>
        </div>
      </div>

      <div className="assistant-log" ref={logRef} aria-live="polite">
        <div className="bubble assistant">{day.data?.summary || 'Je regarde ta journée…'}</div>
        {msgs.map((m, i) => (
          <div key={i} className="bubble-wrap">
            <div className={`bubble ${m.role}`}>{m.text}</div>
            {m.proposals?.map((p) => {
              const st = states[p.id];
              return (
                <div key={p.id} className={`proposal${st === 'applied' ? ' applied' : ''}${st === 'ignored' ? ' ignored' : ''}`} data-testid="proposal">
                  <div className="proposal-text">
                    <strong>{p.title}</strong>
                    <span className="tiny muted block">{p.detail}</span>
                  </div>
                  {st === 'applied' ? (
                    <span className="status-chip ok">
                      <Icon.check /> Fait
                    </span>
                  ) : st === 'ignored' ? (
                    <span className="tiny muted">Ignoré</span>
                  ) : (
                    <span className="row" style={{ gap: 6 }}>
                      <button className="btn small primary" onClick={() => apply(p)} disabled={st === 'busy'}>
                        Appliquer
                      </button>
                      <button className="btn small ghost" onClick={() => setStates((s) => ({ ...s, [p.id]: 'ignored' }))}>
                        Ignorer
                      </button>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {busy && (
          <div className="bubble assistant typing" aria-label="L’assistant écrit">
            <i />
            <i />
            <i />
          </div>
        )}
      </div>

      <div className="chip-scroll assistant-chips" role="group" aria-label="Suggestions">
        {SUGGESTIONS.map(([s, now]) => (
          <button key={s} type="button" className="pill" onClick={() => suggest(s, now)}>
            {s.replace('  ', ' … ').trim()}
            {!now && s.endsWith(' ') ? '…' : ''}
          </button>
        ))}
      </div>
      <form className="assistant-input" onSubmit={(e) => (e.preventDefault(), send(text))}>
        <label className="sr-only" htmlFor="assistant-input">
          Message à l’assistant
        </label>
        <input id="assistant-input" ref={inputRef} value={text} onChange={(e) => setText(e.target.value)} placeholder="Ex. : j’ai lu 25 min, ou déplace le dentiste à 15 h" autoComplete="off" />
        <button className="send-btn" aria-label="Envoyer" disabled={!text.trim() || busy}>
          <Icon.send />
        </button>
      </form>
    </section>
  );
}
