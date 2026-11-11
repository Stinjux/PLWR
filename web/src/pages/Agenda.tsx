import { useEffect, useMemo, useRef, useState } from 'react';
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

  function startDrag(e: React.PointerEvent, o: Occ, mode: 'move' | 'resize') {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const y0 = e.clientY, x0 = e.clientX;
    const colW = wrapRef.current ? (wrapRef.current.clientWidth - 46) / days.length : 100;
    const s0 = dt(o.start!), e0 = dt(o.end!);
    let last: Preview | null = null;
    const move = (ev: PointerEvent) => {
      const dMin = Math.round((ev.clientY - y0) / PX / SNAP) * SNAP;
      const dDay = view === 'week' && mode === 'move' ? Math.round((ev.clientX - x0) / colW) : 0;
      let ns = s0, ne = e0;
      if (mode === 'move') {
        ns = s0.plus({ minutes: dMin, days: dDay });
        ne = e0.plus({ minutes: dMin, days: dDay });
      } else {
        ne = e0.plus({ minutes: dMin });
        if (ne.diff(s0, 'minutes').minutes < SNAP) ne = s0.plus({ minutes: SNAP });
      }
      last = { id: o.id, start: ns.toUTC().toISO()!, end: ne.toUTC().toISO()! };
      setPreview(last);
    };
    const up = async () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
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
      await qc.invalidateQueries({ queryKey: ['events'] });
      setPreview(null);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  function newAt(day: string, e: React.MouseEvent) {
    if (e.target !== e.currentTarget) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const minutes = Math.floor((e.clientY - rect.top) / PX / 30) * 30;
    const start = DateTime.fromISO(day, { zone: TZ }).plus({ minutes }).toUTC().toISO()!;
    openEditor({ mode: 'new', kind: 'fixed', start });
  }

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
        <span>⋮⋮ déplacer · bas du bloc : durée · toucher : modifier</span>
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
        <div className="timeline" style={{ gridTemplateColumns: gridCols, height: 1440 * PX }}>
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
                <div key={d} className={`tl-col${d === today && view === 'week' ? ' today' : ''}`} onClick={(e) => newAt(d, e)} data-testid={`col-${d}`}>
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
                  {items.map((o) => {
                    const s = dt(o.start!), e = dt(o.end!);
                    const top = s.diff(dayStart, 'minutes').minutes * PX;
                    const h = Math.max(18, e.diff(s, 'minutes').minutes * PX);
                    const l = lay.get(o.id) || { lane: 0, lanes: 1 };
                    const dragging = preview?.id === o.id;
                    return (
                      <div
                        key={o.id}
                        className={`block ${o.kind}${o.status === 'done' ? ' done' : ''}${dragging ? ' dragging' : ''}`}
                        style={{ top, height: h, left: `calc(${(l.lane / l.lanes) * 100}% + 3px)`, width: `calc(${100 / l.lanes}% - 6px)`, right: 'auto' }}
                        onClick={(ev) => (ev.stopPropagation(), openEditor({ mode: 'edit', id: o.id }))}
                        data-testid="block"
                        data-title={o.title}
                        data-start={o.start}
                        role="button"
                        aria-label={`${o.title}, ${time(o.start)} à ${time(o.end)}`}
                      >
                        <span className="grip" onPointerDown={(ev) => startDrag(ev, o, 'move')} onClick={(ev) => ev.stopPropagation()} aria-label={`Déplacer ${o.title}`} data-testid="grip">
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
                        <span className="resize" onPointerDown={(ev) => startDrag(ev, o, 'resize')} onClick={(ev) => ev.stopPropagation()} aria-label={`Modifier la durée de ${o.title}`} data-testid="resize" />
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
