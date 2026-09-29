"use client";

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motivoDeFallo } from '@/lib/meta-error';

// Fila de chips de resultados de una campaña + el panel que se abre al tocar un
// chip de botón o de fallidos (lista de contactos del grupo y limpieza). Se usa en
// la tarjeta activa y en el Historial.
//
// La limpieza (marcar "no molestar" / eliminar) va contra POST /cleanup, que
// recalcula el conjunto en el server y exige que coincida con el número que el
// operador confirmó. Eliminar solo lo ven admin y agente (canDelete del GET).

export type ResultsCampaign = {
  id: string;
  name: string;
  sent: number;
  target_total: number | null;
  delivered_count: number | null;
  read_count: number | null;
  failed_count: number | null;
  btn1_count: number | null;
  btn2_count: number | null;
  btn3_count?: number | null;
  button_labels?: string[];
};

type FailureClass = 'invalido' | 'contacto_ok' | 'cuenta';
type Row = {
  contact_id: string | null;
  phone: string | null;
  name: string | null;
  casino_username: string | null;
  kind: 'boton' | 'fallido';
  btn_index: number | null;
  error_code: number | null;
  failure_class: FailureClass | null;
  sent_at: string;
  activity: { kind: 'mensaje' | 'carga'; at: string } | null;
  opted_out: boolean;
  deleted: boolean;
  fail_count: number | null;
};
type ButtonRole = 'positivo' | 'negativo' | 'medio';
type ResultsData = {
  buttons: { index: number; label: string; role: ButtonRole }[];
  rows: Row[];
  canDelete: boolean;
};
type CleanupGroup = 'negativo' | 'invalido';
type View = { type: 'boton'; index: number } | { type: 'fallidos' };
type Pending = { group: CleanupGroup; action: 'optout' | 'delete'; ids: string[] };

// Etiqueta corta por código para los grupos informativos. El texto completo
// (motivoDeFallo) va en el tooltip.
const CODE_SHORT: Record<number, string> = {
  131049: 'límite de marketing por persona',
  130472: 'experimento de Meta',
  131056: 'demasiados mensajes seguidos',
  131047: 'ventana de 24 h cerrada',
  131042: 'pago / elegibilidad',
  130497: 'país restringido',
  368:    'cuenta bloqueada',
  131031: 'cuenta restringida',
  131048: 'tasa de spam',
  130429: 'límite por segundo',
  190:    'token vencido',
  100:    'parámetro inválido',
};
function codeShort(code: number | null): string {
  if (code == null) return 'sin código';
  if (CODE_SHORT[code]) return CODE_SHORT[code];
  if (code >= 132000 && code < 133000) return 'plantilla';
  return 'otro motivo';
}

const fmt = new Intl.DateTimeFormat('es-AR', {
  timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});
const fmtDay = new Intl.DateTimeFormat('es-AR', {
  timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit',
});

const plural = (n: number, uno: string, varios: string) => (n === 1 ? uno : varios);

// ¿Se puede seleccionar para limpiar? Mismo criterio que inCleanupGroup del server
// (el server igual recalcula; esto es solo para no ofrecer lo que va a rechazar).
function selectable(r: Row): boolean {
  return !!r.contact_id && !r.deleted && !r.activity;
}

// ── Chip ─────────────────────────────────────────────────────────────────────
function MetricChip({ text, color, bg, onClick, active }: {
  text: string; color: string; bg: string; onClick?: () => void; active?: boolean;
}) {
  const base: React.CSSProperties = {
    fontSize: '11px', fontWeight: 800, color, background: bg, borderRadius: '8px', padding: '3px 10px',
    whiteSpace: 'nowrap', border: `1.5px solid ${active ? color : 'transparent'}`, fontFamily: 'inherit',
    fontVariantNumeric: 'tabular-nums',
  };
  if (!onClick) return <span style={base}>{text}</span>;
  return (
    <button type="button" onClick={onClick} aria-expanded={!!active} title="Ver contactos"
      style={{ ...base, cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
      {text} <span style={{ opacity: 0.55, fontSize: '12px', lineHeight: 1 }}>{active ? '▾' : '›'}</span>
    </button>
  );
}

const ROLE_STYLE: Record<ButtonRole, { color: string; bg: string; emoji: string }> = {
  positivo: { color: '#5b7a00', bg: '#f4ffd1', emoji: '👍 ' },
  negativo: { color: '#b8860b', bg: '#fff4d6', emoji: '👎 ' },
  medio:    { color: '#555',    bg: '#ececec', emoji: '' },
};

function buttonRoleOf(index: number, total: number): ButtonRole {
  if (index === 0) return 'positivo';
  if (index === total - 1) return 'negativo';
  return 'medio';
}

// ── Componente principal ─────────────────────────────────────────────────────
export default function CampaignResults({ c, onChanged }: { c: ResultsCampaign; onChanged?: () => void }) {
  const [view, setView] = useState<View | null>(null);

  // Botones: labels de la plantilla (del GET de campañas). Sin plantilla, genéricos
  // con la cantidad que indiquen los contadores (mínimo 2).
  const counts = [c.btn1_count ?? 0, c.btn2_count ?? 0, c.btn3_count ?? 0];
  const labels = c.button_labels && c.button_labels.length > 0
    ? c.button_labels
    : Array.from({ length: counts[2] > 0 ? 3 : 2 }, (_, i) => `Botón ${i + 1}`);

  const failed = c.failed_count ?? 0;
  const toggle = (v: View) => setView((cur) => (cur && cur.type === v.type && (cur.type === 'fallidos' || (v.type === 'boton' && cur.index === v.index)) ? null : v));
  const isOpen = (v: View) => !!view && view.type === v.type && (v.type === 'fallidos' || (view.type === 'boton' && view.index === v.index));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
        <MetricChip
          text={`${c.target_total != null && c.target_total > 0 && c.sent <= c.target_total ? `${c.sent} de ${c.target_total}` : c.sent} enviados`}
          color="#555" bg="#ececec"
        />
        <MetricChip text={`${c.delivered_count ?? 0} entregados`} color="#1565c0" bg="#e3f0ff" />
        <MetricChip text={`${c.read_count ?? 0} leídos`} color="#1a7a3a" bg="#e8fff0" />
        {labels.map((label, i) => {
          const role = buttonRoleOf(i, labels.length);
          const st = ROLE_STYLE[role];
          const n = counts[i] ?? 0;
          const v: View = { type: 'boton', index: i };
          return (
            <MetricChip key={i} text={`${st.emoji}${label} ${n}`} color={st.color} bg={st.bg}
              onClick={n > 0 ? () => toggle(v) : undefined} active={isOpen(v)} />
          );
        })}
        <MetricChip text={`${failed} fallidos`} color="#c0392b" bg="#ffe6e6"
          onClick={failed > 0 ? () => toggle({ type: 'fallidos' }) : undefined} active={isOpen({ type: 'fallidos' })} />
      </div>

      {view && <ResultsPanel c={c} view={view} onClose={() => setView(null)} onChanged={onChanged} />}
    </div>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────
function ResultsPanel({ c, view, onClose, onChanged }: {
  c: ResultsCampaign; view: View; onClose: () => void; onChanged?: () => void;
}) {
  const [data, setData] = useState<ResultsData | null>(null);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Pending | null>(null);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const res = await fetch(`/api/campaigns/${c.id}/results`, { cache: 'no-store' });
      const body = await res.json().catch(() => null);
      if (!res.ok) { setLoadError(body?.error ?? 'No se pudo cargar la lista.'); return; }
      setData(body);
    } catch {
      setLoadError('Error de red al cargar la lista.');
    }
  }, [c.id]);

  useEffect(() => { setData(null); setNotice(''); load(); }, [load]);

  const buttons = data?.buttons ?? [];
  const negIdx = buttons.find((b) => b.role === 'negativo')?.index;
  const cleanupGroup: CleanupGroup | null = view.type === 'fallidos' ? 'invalido'
    : view.index === negIdx ? 'negativo' : null;

  // Filas de la vista actual.
  const rows = useMemo(() => {
    if (!data) return [];
    if (view.type === 'boton') return data.rows.filter((r) => r.kind === 'boton' && r.btn_index === view.index);
    return data.rows.filter((r) => r.kind === 'fallido');
  }, [data, view]);
  const actionable = useMemo(() => {
    if (!cleanupGroup) return [];
    return rows.filter((r) => (cleanupGroup === 'invalido' ? r.failure_class === 'invalido' : true));
  }, [rows, cleanupGroup]);

  // Al cargar (o cambiar de vista): todos los seleccionables tildados.
  useEffect(() => {
    setSelected(new Set(actionable.filter(selectable).map((r) => r.contact_id!)));
  }, [actionable]);

  const title = view.type === 'fallidos'
    ? `${rows.length} fallidos`
    : `${ROLE_STYLE[buttons.find((b) => b.index === view.index)?.role ?? 'medio'].emoji}${buttons.find((b) => b.index === view.index)?.label ?? `Botón ${view.index + 1}`} · ${rows.length} ${plural(rows.length, 'contacto', 'contactos')}`;

  const selectableCount = actionable.filter(selectable).length;
  const activeCount = actionable.filter((r) => r.activity).length;

  let subtitle = '';
  if (data && view.type === 'boton' && cleanupGroup) {
    subtitle = `${selectableCount} se ${plural(selectableCount, 'puede', 'pueden')} limpiar`
      + (activeCount > 0 ? ` · ${activeCount} ${plural(activeCount, 'volvió', 'volvieron')} a estar ${plural(activeCount, 'activo', 'activos')}` : '');
  } else if (data && view.type === 'fallidos') {
    const by = (k: FailureClass) => rows.filter((r) => r.failure_class === k).length;
    subtitle = `${by('invalido')} ${plural(by('invalido'), 'número inválido', 'números inválidos')} · ${by('contacto_ok')} ${plural(by('contacto_ok'), 'frenado', 'frenados')} por Meta · ${by('cuenta')} por la cuenta`;
  } else if (data && view.type === 'boton') {
    subtitle = 'Solo consulta';
  }

  function startAction(action: 'optout' | 'delete') {
    if (!cleanupGroup) return;
    let ids = actionable.filter((r) => selectable(r) && selected.has(r.contact_id!));
    // "No molestar" a los que ya lo tienen no hace nada: se descartan del conteo.
    if (action === 'optout') ids = ids.filter((r) => !r.opted_out);
    if (ids.length === 0) {
      setNotice(action === 'optout' ? 'Los seleccionados ya están en "no molestar".' : 'No hay contactos seleccionados.');
      return;
    }
    setNotice('');
    setPending({ group: cleanupGroup, action, ids: ids.map((r) => r.contact_id!) });
  }

  return (
    <div style={{ background: '#fff', border: '1px solid #e7e7e7', borderRadius: '12px', overflow: 'hidden' }}>
      <div style={{ padding: '12px 16px', display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', borderBottom: '1px solid #e7e7e7', flexWrap: 'wrap' }}>
        <div>
          <p style={{ margin: 0, fontSize: '14px', fontWeight: 800, color: '#000' }}>{title}</p>
          {subtitle && <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#6b6b6b' }}>{subtitle}</p>}
        </div>
        <button type="button" onClick={onClose} aria-label="Cerrar" style={{ background: 'none', border: 'none', color: '#aaa', fontSize: '15px', fontWeight: 700, cursor: 'pointer' }}>✕</button>
      </div>

      {notice && <p style={{ margin: 0, padding: '10px 16px', fontSize: '12.5px', color: '#1a7a3a', background: '#e8fff0', borderBottom: '1px solid #e7e7e7', fontWeight: 700 }}>{notice}</p>}

      {!data && !loadError && <p style={{ margin: 0, padding: '16px', fontSize: '13px', color: '#999' }}>Cargando…</p>}
      {loadError && (
        <p style={{ margin: 0, padding: '16px', fontSize: '13px', color: '#c0392b' }}>
          {loadError} <button type="button" onClick={load} style={{ background: 'none', border: 'none', color: '#1565c0', fontWeight: 700, cursor: 'pointer', fontSize: '13px' }}>Reintentar</button>
        </p>
      )}

      {data && view.type === 'boton' && (
        <>
          <ContactTable rows={rows} withCheck={!!cleanupGroup} selected={selected} setSelected={setSelected} />
          {cleanupGroup && (
            <ActionBar count={actionable.filter((r) => selectable(r) && selected.has(r.contact_id!)).length}
              canDelete={data.canDelete} onAction={startAction} />
          )}
        </>
      )}

      {data && view.type === 'fallidos' && (
        <FailedGroups rows={rows} selected={selected} setSelected={setSelected}
          canDelete={data.canDelete} onAction={startAction} />
      )}

      {pending && (
        <ConfirmModal
          campaign={c}
          pending={pending}
          onCancel={() => setPending(null)}
          onDone={(msg) => {
            setPending(null);
            setNotice(msg);
            load();
            onChanged?.();
          }}
          onConflict={() => { load(); }}
        />
      )}
    </div>
  );
}

// ── Tabla de contactos ───────────────────────────────────────────────────────
function ContactTable({ rows, withCheck, selected, setSelected, showFails, limit }: {
  rows: Row[]; withCheck: boolean; selected: Set<string>; setSelected: (s: Set<string>) => void;
  showFails?: boolean; limit?: number;
}) {
  const visible = limit != null ? rows.slice(0, limit) : rows;
  const selectables = rows.filter(selectable);
  const allOn = selectables.length > 0 && selectables.every((r) => selected.has(r.contact_id!));

  const th: React.CSSProperties = { padding: '8px 16px', textAlign: 'left', fontSize: '10px', letterSpacing: '0.07em', textTransform: 'uppercase', color: '#aaa', fontWeight: 700, background: '#F8F8F8', borderBottom: '1px solid #e7e7e7' };
  const td: React.CSSProperties = { padding: '8px 16px', borderBottom: '1px solid #f0f0f0', fontSize: '13px', verticalAlign: 'middle' };

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: '520px' }}>
        <thead>
          <tr>
            {withCheck && (
              <th style={{ ...th, width: '36px' }}>
                <input type="checkbox" aria-label="Seleccionar todos" checked={allOn} disabled={selectables.length === 0}
                  onChange={() => {
                    const next = new Set(selected);
                    for (const r of selectables) { if (allOn) next.delete(r.contact_id!); else next.add(r.contact_id!); }
                    setSelected(next);
                  }} />
              </th>
            )}
            <th style={th}>Contacto</th>
            <th style={th}>Teléfono</th>
            <th style={th}>Enviado</th>
            <th style={th}>{showFails ? 'Fallos' : 'Estado'}</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((r, i) => {
            const on = selectable(r);
            const off = withCheck && !on;
            return (
              <tr key={`${r.contact_id ?? r.phone}-${i}`} style={{ color: off ? '#aaa' : '#111' }}>
                {withCheck && (
                  <td style={td}>
                    <input type="checkbox" aria-label={on ? 'Seleccionar' : 'No seleccionable'} disabled={!on}
                      checked={on && selected.has(r.contact_id!)}
                      onChange={() => {
                        const next = new Set(selected);
                        if (next.has(r.contact_id!)) next.delete(r.contact_id!); else next.add(r.contact_id!);
                        setSelected(next);
                      }} />
                  </td>
                )}
                <td style={{ ...td, fontWeight: 700 }}>{r.casino_username || r.name || '—'}</td>
                <td style={{ ...td, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '12px', color: '#6b6b6b' }}>{r.phone ?? '—'}</td>
                <td style={{ ...td, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{fmt.format(new Date(r.sent_at))}</td>
                <td style={td}>
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    {r.deleted && <Pill bg="#f0f0f0" fg="#888">Contacto eliminado</Pill>}
                    {r.activity && (
                      <Pill bg="#e8fff0" fg="#1a7a3a">
                        {r.activity.kind === 'carga' ? '💰 Cargó' : '💬 Escribió'} el {fmtDay.format(new Date(r.activity.at))}
                      </Pill>
                    )}
                    {r.opted_out && <Pill bg="#eef0f5" fg="#4a5470">🔕 No molestar</Pill>}
                    {showFails && r.fail_count != null && (
                      <Pill bg="#ffe6e6" fg="#c0392b">falló {r.fail_count} {plural(r.fail_count, 'vez', 'veces')}</Pill>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Pill({ bg, fg, children }: { bg: string; fg: string; children: React.ReactNode }) {
  return <span style={{ fontSize: '11px', fontWeight: 700, padding: '2px 8px', borderRadius: '999px', whiteSpace: 'nowrap', background: bg, color: fg }}>{children}</span>;
}

function ActionBar({ count, canDelete, onAction }: {
  count: number; canDelete: boolean; onAction: (a: 'optout' | 'delete') => void;
}) {
  const disabled = count === 0;
  const btn: React.CSSProperties = { fontWeight: 700, fontSize: '12px', borderRadius: '10px', padding: '7px 12px', cursor: disabled ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap', opacity: disabled ? 0.5 : 1, fontFamily: 'inherit' };
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap', padding: '12px 16px', background: '#F8F8F8' }}>
      <span style={{ fontSize: '13px' }}><b style={{ fontVariantNumeric: 'tabular-nums' }}>{count}</b> {plural(count, 'seleccionado', 'seleccionados')}</span>
      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <button type="button" disabled={disabled} onClick={() => onAction('optout')} style={{ ...btn, background: '#1a1a1a', color: '#C8FF00', border: '1px solid #1a1a1a' }}>
          🔕 Marcar no molestar
        </button>
        {canDelete && (
          <button type="button" disabled={disabled} onClick={() => onAction('delete')} style={{ ...btn, background: 'transparent', color: '#E53935', border: '1px solid #f08080' }}>
            🗑 Eliminar
          </button>
        )}
      </div>
    </div>
  );
}

// ── Fallidos en tres grupos ──────────────────────────────────────────────────
function FailedGroups({ rows, selected, setSelected, canDelete, onAction }: {
  rows: Row[]; selected: Set<string>; setSelected: (s: Set<string>) => void;
  canDelete: boolean; onAction: (a: 'optout' | 'delete') => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const invalid = rows.filter((r) => r.failure_class === 'invalido');
  const ok = rows.filter((r) => r.failure_class === 'contacto_ok');
  const cuenta = rows.filter((r) => r.failure_class === 'cuenta');
  const PREVIEW = 20;
  const selCount = invalid.filter((r) => selectable(r) && selected.has(r.contact_id!)).length;

  return (
    <div>
      {invalid.length > 0 && (
        <div style={{ borderBottom: '1px solid #e7e7e7' }}>
          <GroupHead dot="#d93025" title={`Número inválido · ${invalid.length}`}
            text="El número no puede recibir mensajes de WhatsApp: no tiene cuenta, está mal escrito o cambió. Se pueden limpiar."
            codes={[{ code: 131026, count: invalid.length }]} />
          <ContactTable rows={invalid} withCheck selected={selected} setSelected={setSelected} showFails
            limit={showAll ? undefined : PREVIEW} />
          {invalid.length > PREVIEW && (
            <button type="button" onClick={() => setShowAll(!showAll)}
              style={{ padding: '8px 16px', fontSize: '12px', fontWeight: 700, color: '#1565c0', background: 'none', border: 'none', cursor: 'pointer' }}>
              {showAll ? 'Mostrar menos' : `Ver los ${invalid.length - PREVIEW} restantes`}
            </button>
          )}
          <ActionBar count={selCount} canDelete={canDelete} onAction={onAction} />
        </div>
      )}
      {ok.length > 0 && (
        <div style={{ borderBottom: '1px solid #e7e7e7' }}>
          <GroupHead dot="#e0a100" title={`Contacto OK, lo frenó Meta · ${ok.length}`}
            text="El número está bien. Meta no entregó este mensaje en particular, por ejemplo porque la persona ya recibió mucho marketing esa semana. Conviene volver a intentar más adelante."
            codes={byCode(ok)} />
        </div>
      )}
      {cuenta.length > 0 && (
        <div>
          <GroupHead dot="#b5b5b5" title={`Problema de la cuenta · ${cuenta.length}`}
            text="No es del contacto ni del mensaje: se arregla en Meta Business Manager (método de pago, habilitación de la cuenta, plantilla). No hay que tocar ningún contacto."
            codes={byCode(cuenta)} />
        </div>
      )}
    </div>
  );
}

function byCode(rows: Row[]): { code: number | null; count: number }[] {
  const m = new Map<string, { code: number | null; count: number }>();
  for (const r of rows) {
    const k = String(r.error_code);
    const cur = m.get(k) ?? { code: r.error_code, count: 0 };
    cur.count++;
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => b.count - a.count);
}

function GroupHead({ dot, title, text, codes }: {
  dot: string; title: string; text: string; codes: { code: number | null; count: number }[];
}) {
  return (
    <div style={{ padding: '12px 16px', display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
      <span style={{ width: '10px', height: '10px', borderRadius: '50%', background: dot, flexShrink: 0, marginTop: '5px' }} />
      <div>
        <p style={{ margin: 0, fontSize: '13px', fontWeight: 800 }}>{title}</p>
        <p style={{ margin: '2px 0 0', fontSize: '12px', color: '#6b6b6b', maxWidth: '70ch' }}>{text}</p>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '6px' }}>
          {codes.map((k) => (
            <span key={String(k.code)} title={motivoDeFallo(k.code, null, null) ?? undefined}
              style={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '11px', background: '#F8F8F8', border: '1px solid #e7e7e7', borderRadius: '6px', padding: '2px 7px', color: '#6b6b6b' }}>
              {k.code != null ? `${k.code} · ` : ''}{k.count} {codeShort(k.code)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Confirmación ─────────────────────────────────────────────────────────────
function ConfirmModal({ campaign, pending, onCancel, onDone, onConflict }: {
  campaign: ResultsCampaign; pending: Pending; onCancel: () => void;
  onDone: (msg: string) => void; onConflict: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState('');
  const n = pending.ids.length;
  const isDelete = pending.action === 'delete';
  const quien = pending.group === 'negativo' ? 'que dijeron que no' : 'con número inválido';
  const quienUno = pending.group === 'negativo' ? 'que dijo que no' : 'con número inválido';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onCancel]);

  async function confirm() {
    setBusy(true); setError('');
    try {
      const res = await fetch(`/api/campaigns/${campaign.id}/cleanup`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group: pending.group, action: pending.action, contactIds: pending.ids, expectedCount: n }),
      });
      const body = await res.json().catch(() => null);
      if (res.status === 409) {
        // La lista cambió: no se ejecutó nada. Se recarga y el operador vuelve a elegir.
        setConflict(body?.error ?? 'La lista cambió. Revisá y confirmá de nuevo.');
        onConflict();
        setBusy(false);
        return;
      }
      if (!res.ok) { setError(body?.error ?? 'No se pudo completar la acción.'); setBusy(false); return; }
      onDone(isDelete
        ? `${body.deleted} ${plural(body.deleted, 'contacto eliminado', 'contactos eliminados')} y en "no molestar".`
        : `${body.count} ${plural(body.count, 'contacto marcado', 'contactos marcados')} como "no molestar".`);
    } catch {
      setError('Error de red. No se hizo ningún cambio.');
      setBusy(false);
    }
  }

  return (
    <div role="presentation" onClick={() => { if (!busy) onCancel(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(17,17,17,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px', zIndex: 1000 }}>
      <div role="dialog" aria-modal="true" aria-labelledby="cleanup-title" onClick={(e) => e.stopPropagation()}
        style={{ background: '#fff', borderRadius: '16px', maxWidth: '440px', width: '100%', padding: '22px', display: 'flex', flexDirection: 'column', gap: '14px', boxShadow: '0 20px 50px rgba(0,0,0,0.3)' }}>
        <p id="cleanup-title" style={{ margin: 0, fontSize: '18px', fontWeight: 900 }}>
          {isDelete ? 'Eliminar contactos' : 'Marcar "no molestar"'}
        </p>
        <div>
          <div style={{ fontSize: '40px', fontWeight: 900, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{n}</div>
          <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#6b6b6b' }}>
            {plural(n, `contacto ${quienUno}`, `contactos ${quien}`)} en <b style={{ color: '#111' }}>{campaign.name}</b>
          </p>
        </div>
        <ul style={{ margin: 0, paddingLeft: '18px', fontSize: '13px', color: '#6b6b6b', display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {isDelete ? (
            <>
              <li>Se borran también sus conversaciones y comprobantes.</li>
              <li>Quedan en "no molestar": si se vuelven a importar, no reciben campañas.</li>
              <li>No se puede deshacer.</li>
            </>
          ) : (
            <>
              <li>No van a recibir más campañas, aunque se vuelvan a importar.</li>
              <li>El bot y el chat siguen igual.</li>
              <li>Se puede quitar desde la ficha de cada contacto.</li>
            </>
          )}
        </ul>
        {conflict && (
          <div style={{ background: '#fff4d6', color: '#7a5a00', borderRadius: '10px', padding: '10px 12px', fontSize: '12.5px' }}>
            {conflict}
          </div>
        )}
        {error && <p style={{ margin: 0, fontSize: '12.5px', color: '#c0392b', fontWeight: 700 }}>{error}</p>}
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button type="button" onClick={onCancel} disabled={busy}
            style={{ fontWeight: 700, fontSize: '13px', borderRadius: '10px', padding: '9px 14px', cursor: 'pointer', background: 'transparent', border: '1px solid #ddd', fontFamily: 'inherit' }}>
            {conflict ? 'Cerrar y revisar' : 'Cancelar'}
          </button>
          {!conflict && (
            <button type="button" onClick={confirm} disabled={busy}
              style={{ fontWeight: 800, fontSize: '13px', borderRadius: '10px', padding: '9px 14px', cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.6 : 1, border: 'none', fontFamily: 'inherit',
                background: isDelete ? '#E53935' : '#1a1a1a', color: isDelete ? '#fff' : '#C8FF00' }}>
              {busy ? 'Procesando…' : isDelete ? `Eliminar ${n} ${plural(n, 'contacto', 'contactos')}` : `Marcar ${n} ${plural(n, 'contacto', 'contactos')}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
