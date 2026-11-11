import { useEffect, useMemo, useRef, useState } from 'react';

type Sel = { d0: number; d1: number; m0: number; m1: number };
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { DateTime } from 'luxon';
import { api } from '../lib/api';
import { TZ, dt, dayLabel, duration, time, todayIso } from '../lib/format';
import { useApp } from '../App';
import { Icon, Seg, useToast } from '../components/ui';
import { askScope, type Occ } from '../components/EventEditor';
import { ReorganizeDialog } from '../components/ReorganizeDialog';

const PX = 1; // pixels par minute
const SNAP = 15;

type Preview = { id: string; start: string; end: string };

function layoutColumn(items: Occ[]) {
  // Répartit les blocs qui se chevauchent sur plusieurs voies
  const sorted = [...items].sort((a, b) => (a.start! < b.start! ? -1 : 1));
  const out = new Map<string, { lane: number; lanes: number }>();
  let cluster: Occ[] = [];
  let clusterEnd = '';
  const lanesEnd: string[] = [];
  const flush = () => {
    const n = Math.max(1, ...cluster.map((c) => out.get(c.id)!.lane + 1));
    cluster.forEach((c) => (out.get(c.id)!.lanes = n));
    cluster = [];
    lanesEnd.length = 0;
  };
  for (const o of sorted) {
    if (cluster.length && o.start! >= clusterEnd) flush();
    let lane = lanesEnd.findIndex((e) => e <= o.start!);
    if (lane < 0) lane = lanesEnd.length;
    lanesEnd[lane] = o.end!;
    out.set(o.id, { lane, lanes: 1 });
    cluster.push(o);
    clusterEnd = clusterEnd > o.end! && cluster.length > 1 ? clusterEnd : o.end!;
  }
  if (cluster.length) flush();
  return out;
}

export function Agenda() {
  const { me, openEditor } = useApp();
  const toast = useToast();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const [view, setView] = useState<'day' | 'week'>(window.innerWidth >= 900 ? 'week' : 'day');
  const [date, setDate] = useState(params.get('date') || todayIso());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reorg, setReorg] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<Sel | null>(null);
  const selecting = useRef(false);
  const suppressClick = useRef(false);

  const days = useMemo(() => {
    const d = DateTime.fromISO(date, { zone: TZ });
    if (view === 'day') return [d.toISODate()!];
    const s = d.startOf('week');
    return Array.from({ length: 7 }, (_, i) => s.plus({ days: i }).toISODate()!);
  }, [date, view]);
  const from = DateTime.fromISO(days[0], { zone: TZ }).toUTC().toISO()!;
  const to = DateTime.fromISO(days[days.length - 1], { zone: TZ }).plus({ days: 1 }).toUTC().toISO()!;
  const q = useQuery({ queryKey: ['events', from, to], queryFn: () => api.get<{ occurrences: Occ[]; unscheduled: Occ[] }>(`/api/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`) });

  useEffect(() => {
    const [h, m] = (me.settings.dayStart || '07:00').split(':').map(Number);
    if (wrapRef.current) wrapRef.current.scrollTop = (h * 60 + m) * PX - 16;
  }, [view, me.settings.dayStart]);

  const occs = (q.data?.occurrences || []).filter((o) => o.start && o.end);
  const byDay = new Map<string, Occ[]>(days.map((d) => [d, []]));
  for (const o of occs) {
    const p = preview && preview.id === o.id ? { ...o, start: preview.start, end: preview.end } : o;
    const d = dt(p.start!).toISODate()!;
    byDay.get(d)?.push(p);
  }
  const unscheduled = (q.data?.unscheduled || []).filter((o) => o.status === 'active');
  const today = todayIso();
  const nowMin = DateTime.now().setZone(TZ).hour * 60 + DateTime.now().setZone(TZ).minute;

  function shift(n: number) {
    setDate(DateTime.fromISO(date).plus(view === 'day' ? { days: n } : { weeks: n }).toISODate()!);
  }

  /**
   * Glisser-déposer d'un bloc (comme Outlook) : on l'attrape n'importe où.
   * Souris : le déplacement commence dès que le pointeur bouge. Doigt : appui long (0,3 s) puis glisser,
   * un geste rapide fait défiler l'agenda. Le bas du bloc modifie la durée.
   */
  function startDrag(e: React.PointerEvent, o: Occ) {
    if (e.button > 0 || o.status === 'cancelled') return;
    e.stopPropagation(); // pas de sélection de plage sous un bloc
    const mode: 'move' | 'resize' = (e.target as HTMLElement).closest('.resize') ? 'resize' : 'move';
    const touch = e.pointerType !== 'mouse';
    const wrap = wrapRef.current!;
    const y0 = e.clientY, x0 = e.clientX, scroll0 = wrap.scrollTop;
    const colW = (gridRef.current!.getBoundingClientRect().width - 46) / days.length;
    const s0 = dt(o.start!), e0 = dt(o.end!);
    let active = false;
    let last: Preview | null = null;
    let lastY = y0, lastX = x0;
    let timer: number | undefined;
    let raf = 0;

    const begin = () => {
      active = true;
      selecting.current = true; // bloque le défilement au doigt
      last = { id: o.id, start: o.start!, end: o.end! };
      setPreview(last);
      if (touch) navigator.vibrate?.(15);
      autoScroll();
    };
    const update = () => {
      const dMin = Math.round((lastY - y0 + (wrap.scrollTop - scroll0)) / PX / SNAP) * SNAP;
      const dDay = view === 'week' && mode === 'move' ? Math.round((lastX - x0) / colW) : 0;
      let ns = s0, ne = e0;
      if (mode === 'move') {
        ns = s0.plus({ minutes: dMin, days: dDay });
        ne = e0.plus({ minutes: dMin, days: dDay });
      } else {
        ne = e0.plus({ minutes: dMin });
        if (ne.diff(s0, 'minutes').minutes < SNAP) ne = s0.plus({ minutes: SNAP });
      }
      const next = { id: o.id, start: ns.toUTC().toISO()!, end: ne.toUTC().toISO()! };
      if (!last || next.start !== last.start || next.end !== last.end) {
        last = next;
        setPreview(next);
      }
    };
    // Défilement automatique près des bords de l'agenda
    const autoScroll = () => {
      if (!active) return;
      const r = wrap.getBoundingClientRect();
      const edge = 48;
      const v = lastY < r.top + edge ? -Math.ceil((r.top + edge - lastY) / 4) : lastY > r.bottom - edge ? Math.ceil((lastY - (r.bottom - edge)) / 4) : 0;
      if (v) {
        wrap.scrollTop += v;
        update();
      }
      raf = requestAnimationFrame(autoScroll);
    };

    const move = (ev: PointerEvent) => {
      lastY = ev.clientY;
      lastX = ev.clientX;
      const dist = Math.hypot(ev.clientX - x0, ev.clientY - y0);
      if (!active) {
        if (touch) {
          if (dist > 8) cleanup(); // l'utilisateur fait défiler
        } else if (dist > 4) begin();
        return;
      }
      update();
    };
    const up = async () => {
      clearTimeout(timer);
      const wasActive = active;
      cleanup();
      if (!wasActive) return; // simple clic / toucher : le onClick ouvre la fiche
      suppressClick.current = true;
      setTimeout(() => (suppressClick.current = false), 50);
      const p = last;
      if (!p || (p.start === o.start && p.end === o.end)) {
        setPreview(null);
        return;
      }
      const scope = await askScope(o);
      if (!scope) {
        setPreview(null);
        return;
      }
      try {
        const r = await api.patch<Occ>(`/api/events/${encodeURIComponent(o.id)}?scope=${scope}`, { start: p.start, end: p.end });
        const next = r.nextReminders?.[0];
        toast(`${mode === 'move' ? 'Déplacé' : 'Durée modifiée'} : ${time(r.start)}–${time(r.end)}${next ? ` · rappel à ${time(next.fireAt)}` : ''}`);
      } catch (err) {
        toast((err as Error).message);
      }
      await qc.invalidateQueries();
      setPreview(null);
    };
    function cleanup() {
      active = false;
      selecting.current = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    if (touch) timer = window.setTimeout(begin, mode === 'resize' ? 0 : 300);
  }


  // Empêche le défilement pendant une sélection au doigt (écouteur non passif)
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const block = (e: TouchEvent) => {
      if (selecting.current) e.preventDefault();
    };
    el.addEventListener('touchmove', block, { passive: false });
    return () => el.removeEventListener('touchmove', block);
  }, []);

  /** Position (jour, minute arrondie au quart d'heure) sous le pointeur. */
  function cellAt(clientX: number, clientY: number) {
    const r = gridRef.current!.getBoundingClientRect();
    const colW = (r.width - 46) / days.length;
    const d = Math.min(days.length - 1, Math.max(0, Math.floor((clientX - r.left - 46) / colW)));
    const m = Math.min(1440, Math.max(0, Math.round((clientY - r.top) / PX / SNAP) * SNAP));
    return { d, m };
  }

  /**
   * Cliquer-glisser sur une zone libre pour sélectionner une plage (comme Outlook).
   * Souris : immédiat. Doigt : appui long (0,35 s) puis glisser. En vue semaine, glisser sur plusieurs jours
   * sélectionne la même plage chaque jour et propose une récurrence hebdomadaire sur ces jours.
   */
  function onGridPointerDown(e: React.PointerEvent) {
    const t = e.target as HTMLElement;
    if (t.closest('.ev-block') || e.button > 0) return;
    if (e.clientX - gridRef.current!.getBoundingClientRect().left < 46) return; // colonne des heures
    const start = cellAt(e.clientX, e.clientY);
    const anchor = { d: start.d, m: Math.floor(start.m / SNAP) * SNAP };
    const x0 = e.clientX, y0 = e.clientY;
    let moved = false;
    let timer: number | undefined;
    let current: Sel = { d0: anchor.d, d1: anchor.d, m0: anchor.m, m1: anchor.m + 30 };
    const begin = () => {
      selecting.current = true;
      setSel(current);
      navigator.vibrate?.(10);
    };
    if (e.pointerType === 'mouse') begin();
    else timer = window.setTimeout(begin, 350);

    const move = (ev: PointerEvent) => {
      if (!selecting.current) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 8) {
          clearTimeout(timer); // l'utilisateur fait défiler
          cleanup();
        }
        return;
      }
      moved = moved || Math.hypot(ev.clientX - x0, ev.clientY - y0) > 6;
      const c = cellAt(ev.clientX, ev.clientY);
      const lo = Math.min(anchor.m, c.m), hi = Math.max(anchor.m + SNAP, c.m);
      current = { d0: Math.min(anchor.d, c.d), d1: Math.max(anchor.d, c.d), m0: lo, m1: Math.max(lo + SNAP, hi) };
      setSel(current);
    };
    const up = () => {
      clearTimeout(timer);
      const was = selecting.current;
      cleanup();
      if (!was) return;
      // Un simple clic propose une heure ; une sélection propose exactement la plage choisie
      const s0 = moved ? current : { ...current, m0: Math.floor(anchor.m / 30) * 30, m1: Math.floor(anchor.m / 30) * 30 + 60 };
      const first = DateTime.fromISO(days[s0.d0], { zone: TZ });
      const byDay = s0.d1 > s0.d0 ? days.slice(s0.d0, s0.d1 + 1).map((x) => DateTime.fromISO(x, { zone: TZ }).weekday) : undefined;
      openEditor({ mode: 'new', kind: 'fixed', start: first.plus({ minutes: s0.m0 }).toUTC().toISO()!, durationMin: s0.m1 - s0.m0, byDay });
      setTimeout(() => setSel(null), 300);
    };
    function cleanup() {
      selecting.current = false;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}h${String(m % 60).padStart(2, '0')}`;

  const breaks: { label: string; start: string; end: string }[] = me.settings.breaks || [];
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const gridCols = `46px repeat(${days.length}, minmax(0, 1fr))`;

  return (
    <>
      <div className="page-head">
        <h1>Agenda</h1>
        <Seg
          label="Vue"
          value={view}
          options={[
            ['day', 'Jour'],
            ['week', 'Semaine'],
          ]}
          onChange={setView}
        />
      </div>
      <div className="agenda-toolbar">
        <div className="row grow" style={{ gap: 2 }}>
          <button className="icon-btn" onClick={() => shift(-1)} aria-label="Précédent">
            <Icon.chevronL />
          </button>
          <strong data-testid="agenda-title" className="ellipsis" style={{ minWidth: 0 }}>
            {view === 'day' ? DateTime.fromISO(date).toFormat('ccc d LLL') : `Sem. du ${DateTime.fromISO(days[0]).toFormat('d LLL')}`}
          </strong>
          <button className="icon-btn" onClick={() => shift(1)} aria-label="Suivant">
            <Icon.chevronR />
          </button>
          {!days.includes(today) && (
            <button className="btn small" onClick={() => setDate(todayIso())}>
              Auj.
            </button>
          )}
        </div>
        <button className="btn small" onClick={() => setReorg(view === 'day' ? date : today)}>
          <Icon.shuffle /> Réorganiser
        </button>
      </div>
      <div className="row tiny muted" style={{ marginBottom: 8, gap: 6, flexWrap: 'wrap' }}>
        <span className="chip fixed">Fixe</span>
        <span className="chip flex">Flexible</span>
        <span>Glisser un bloc pour le déplacer, son bas pour la durée · glisser sur une zone libre pour créer (au doigt : appui long)</span>
      </div>

      <div className={`timeline-wrap${view === 'week' ? ' week' : ''}`} ref={wrapRef}>
        {view === 'week' && (
          <div className="tl-days" style={{ gridTemplateColumns: gridCols }}>
            <div />
            {days.map((d) => (
              <div key={d} className={d === today ? 'today' : ''} onClick={() => (setDate(d), setView('day'))}>
                {DateTime.fromISO(d).toFormat('ccc d')}
              </div>
            ))}
          </div>
        )}
        <div className="timeline" ref={gridRef} style={{ gridTemplateColumns: gridCols, height: 1440 * PX }} onPointerDown={onGridPointerDown}>
          <div className="tl-hours">
            {Array.from({ length: 24 }, (_, h) => (
              <div key={h} className="tl-hour-label" style={{ top: h * 60 * PX }}>
                {h ? `${h}h` : ''}
              </div>
            ))}
          </div>
          <>
            {days.map((d) => {
              const items = byDay.get(d) || [];
              const lay = layoutColumn(items);
              const dayStart = DateTime.fromISO(d, { zone: TZ });
              return (
                <div key={d} className={`tl-col${d === today && view === 'week' ? ' today' : ''}`} data-testid={`col-${d}`}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <div key={h} className="tl-line" style={{ top: h * 60 * PX }} />
                  ))}
                  {Array.from({ length: 24 }, (_, h) => (
                    <div key={'h' + h} className="tl-line half" style={{ top: (h * 60 + 30) * PX }} />
                  ))}
                  {breaks.map((b) => (
                    <div key={b.label} className="tl-break" style={{ top: toMin(b.start) * PX, height: (toMin(b.end) - toMin(b.start)) * PX }} title={b.label} />
                  ))}
                  {d === today && <div className="tl-now" style={{ top: nowMin * PX }} />}
                  {sel && days.indexOf(d) >= sel.d0 && days.indexOf(d) <= sel.d1 && (
                    <div className="tl-sel" style={{ top: sel.m0 * PX, height: (sel.m1 - sel.m0) * PX }} data-testid="selection">
                      {days.indexOf(d) === sel.d0 && `${hhmm(sel.m0)}–${hhmm(sel.m1)}`}
                    </div>
                  )}
                  {items.map((o) => {
                    const s = dt(o.start!), e = dt(o.end!);
                    const top = s.diff(dayStart, 'minutes').minutes * PX;
                    const h = Math.max(18, e.diff(s, 'minutes').minutes * PX);
                    const l = lay.get(o.id) || { lane: 0, lanes: 1 };
                    const dragging = preview?.id === o.id;
                    return (
                      <div
                        key={o.id}
                        className={`ev-block ${o.kind}${o.status === 'done' ? ' done' : ''}${dragging ? ' dragging' : ''}`}
                        style={{ top, height: h, left: `calc(${(l.lane / l.lanes) * 100}% + 3px)`, width: `calc(${100 / l.lanes}% - 6px)`, right: 'auto' }}
                        onPointerDown={(ev) => startDrag(ev, o)}
                        onClick={(ev) => {
                          ev.stopPropagation();
                          if (!suppressClick.current) openEditor({ mode: 'edit', id: o.id });
                        }}
                        data-testid="block"
                        data-title={o.title}
                        data-start={o.start}
                        role="button"
                        aria-label={`${o.title}, ${time(o.start)} à ${time(o.end)}`}
                      >
                        <span className="grip" aria-hidden="true" data-testid="grip">
                          <Icon.grip />
                        </span>
                        <div className="b-title ellipsis">
                          {o.isRecurring && <Icon.repeat style={{ width: 10, height: 10, marginRight: 3 }} />}
                          {o.title}
                        </div>
                        {h > 30 && (
                          <div className="tiny">
                            {time(o.start)}–{time(o.end)}
                          </div>
                        )}
                        <span className="resize" aria-label={`Modifier la durée de ${o.title}`} data-testid="resize" />
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </>
        </div>
      </div>

      <section className="card" style={{ marginTop: 12 }}>
        <div className="card-title">
          <h2>À placer</h2>
          <button className="btn small" onClick={() => openEditor({ mode: 'new', kind: 'flexible', planDate: date })}>
            + Tâche
          </button>
        </div>
        {unscheduled.length === 0 && <div className="empty">Aucune tâche en attente de planification.</div>}
        <ul className="list">
          {unscheduled.map((t) => (
            <li key={t.id} className="clickable" onClick={() => openEditor({ mode: 'edit', id: t.id })}>
              <div className="grow">
                <div style={{ fontWeight: 600 }}>{t.title}</div>
                <div className="tiny muted">
                  {t.planDate ? dayLabel(t.planDate) : 'Sans date'} · {duration(t.durationMin)}
                  {t.dueAt ? ` · échéance ${dayLabel(dt(t.dueAt).toISODate()!)} ${time(t.dueAt)}` : ''}
                </div>
              </div>
              <span className={`chip ${t.priority === 1 ? 'warn' : ''}`}>{t.priority === 1 ? 'Haute' : t.priority === 3 ? 'Basse' : 'Moyenne'}</span>
            </li>
          ))}
        </ul>
      </section>
      {reorg && <ReorganizeDialog date={reorg} onClose={() => (setReorg(null), qc.invalidateQueries())} />}
    </>
  );
}
