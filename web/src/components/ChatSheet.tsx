import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { imageForm } from '../lib/image';
import { DraftCard, ManualExpenseForm, type Draft } from './DraftCard';
import { Icon, Sheet, useToast } from './ui';

type Msg = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  payload: { chips?: { label: string; value: string }[]; question?: any; importId?: string; manualEntry?: boolean; draftIds?: string[] };
  drafts: Draft[];
};

export function ChatSheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['chat'], queryFn: () => api.get<{ messages: Msg[] }>('/api/chat') });
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [manualFor, setManualFor] = useState<string | null | undefined>(undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const camRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const messages = q.data?.messages || [];

  useEffect(() => {
    // Champ prêt à l'emploi dès l'ouverture
    const t = setTimeout(() => inputRef.current?.focus(), 60);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length, manualFor]);

  const refresh = () => qc.invalidateQueries({ queryKey: ['chat'] });

  async function send(value?: string, reply?: string) {
    const t = (value ?? text).trim();
    if (!t || sending) return;
    setSending(true);
    try {
      const r = await api.post<{ messages: Msg[] }>('/api/chat', { text: t, reply: reply ? { value: reply } : undefined });
      qc.setQueryData(['chat'], { messages: r.messages });
      if (value === undefined) setText('');
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    setSending(true);
    try {
      const r = await api.upload<{ messages: Msg[]; error: string | null; import: any }>('/api/chat/upload', await imageForm(file));
      qc.setQueryData(['chat'], { messages: r.messages });
    } catch (e) {
      toast((e as Error).message);
      setManualFor(null);
    } finally {
      setSending(false);
    }
  }

  async function confirmAll(ids: string[]) {
    const r = await api.post<{ results: any[] }>('/api/drafts/confirm-many?from=chat', { ids });
    const dups = r.results.filter((x) => x.duplicate).length;
    toast(`${r.results.filter((x) => x.ok).length} dépense(s) confirmée(s)${dups ? ` · ${dups} doublon(s) à vérifier` : ''}`);
    refresh();
  }

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  // Une fiche n'est affichée qu'une fois : sous le dernier message qui la mentionne
  const lastRef = new Map<string, string>();
  for (const m of messages) for (const d of m.drafts) lastRef.set(d.id, m.id);

  return (
    <Sheet
      title="Ajouter une dépense"
      onClose={onClose}
      tall
      footer={
        <div className="chat-input" style={{ padding: 0, border: 0, width: '100%' }}>
          <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => (upload(e.target.files?.[0]), (e.target.value = ''))} />
          <input ref={fileRef} type="file" accept="image/*" hidden data-testid="chat-file" onChange={(e) => (upload(e.target.files?.[0]), (e.target.value = ''))} />
          <button className="icon-btn" aria-label="Prendre une photo" onClick={() => camRef.current?.click()} disabled={sending}>
            <Icon.camera />
          </button>
          <button className="icon-btn" aria-label="Joindre une image ou une capture" onClick={() => fileRef.current?.click()} disabled={sending}>
            <Icon.upload />
          </button>
          <textarea
            ref={inputRef}
            className="input"
            rows={1}
            placeholder="Ex. : 12 $ chez IGA hier"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            aria-label="Message au chatbot"
            enterKeyHint="send"
          />
          <button className="btn primary" style={{ width: 48, padding: 0 }} aria-label="Envoyer" onClick={() => send()} disabled={sending || !text.trim()}>
            <Icon.send />
          </button>
        </div>
      }
    >
      <div className="chat-log" aria-live="polite">
        {messages.length === 0 && (
          <div className="msg assistant">
            Écris une dépense en français courant (« 12 $ chez Tim Hortons ce matin et 45,60 $ chez Costco pour MONDAIX ») ou joins une photo de reçu ou une capture bancaire.
          </div>
        )}
        {messages.map((m) => {
          const shown = m.drafts.filter((d) => lastRef.get(d.id) === m.id);
          const pendingIds = shown.filter((d) => d.status === 'pending').map((d) => d.id);
          return (
            <div key={m.id} style={{ display: 'contents' }}>
              {m.text && (
                <div className={`msg ${m.role}`} data-testid={`msg-${m.role}`}>
                  {m.payload.importId && m.role === 'user' ? <ImportThumb id={m.payload.importId} /> : m.text}
                </div>
              )}
              {shown.length > 0 && (
                <div className="msg-extra">
                  {shown.map((d) => (
                    <DraftCard key={d.id} draft={d} from="chat" onChanged={refresh} />
                  ))}
                  {pendingIds.length > 1 && (
                    <button className="btn primary" onClick={() => confirmAll(pendingIds)}>
                      Tout confirmer ({pendingIds.length})
                    </button>
                  )}
                </div>
              )}
              {m === lastAssistant && m.payload.chips && (
                <div className="row wrap">
                  {m.payload.chips.map((c) =>
                    c.value === 'manual' ? (
                      <button key={c.value} className="chip" onClick={() => setManualFor(null)}>
                        {c.label}
                      </button>
                    ) : (
                      <button key={c.value} className="chip" onClick={() => send(c.label, c.value)}>
                        {c.label}
                      </button>
                    ),
                  )}
                </div>
              )}
              {m === lastAssistant && m.payload.manualEntry && manualFor === undefined && (
                <button className="btn" onClick={() => setManualFor(m.payload.importId || null)}>
                  Saisir manuellement
                </button>
              )}
            </div>
          );
        })}
        {manualFor !== undefined && (
          <ManualExpenseForm
            importId={manualFor}
            fromChat
            onCreated={() => {
              setManualFor(undefined);
              refresh();
            }}
          />
        )}
        {sending && <div className="msg assistant muted">…</div>}
        <div ref={endRef} />
      </div>
    </Sheet>
  );
}

function ImportThumb({ id }: { id: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span>📷 Image jointe (supprimée après validation)</span>;
  return <img className="thumb" src={`/api/imports/${id}/image`} alt="Image jointe" onError={() => setFailed(true)} />;
}
