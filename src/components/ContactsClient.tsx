"use client";

import React, { useState, useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';
import NewContactModal from '@/components/NewContactModal';
import EditContactModal, { type EditableContact } from '@/components/EditContactModal';

type ContactRow = {
  id:                 string;
  name:               string | null;
  phone:              string;
  status:             string;
  casino_username:    string;
  whatsapp_number_id: string | null;
  created_at:         string;
};

type SortDir = 'az' | 'za';

const STATUS_COLOR: Record<string, { bg: string; fg: string }> = {
  nuevo:          { bg: 'var(--status-nuevo)',    fg: '#000' },
  en_proceso:     { bg: '#fff8d6',                fg: '#b8860b' },
  cliente_activo: { bg: 'var(--status-activo)',   fg: '#000' },
  inactivo:       { bg: 'var(--status-inactivo)', fg: '#fff' },
  bloqueado:      { bg: '#FF4444',                fg: '#fff' },
};

// Ítem del menú desplegable "Acciones".
const menuItem: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: '10px', width: '100%',
  background: 'none', border: 'none', borderRadius: '10px', padding: '10px 12px',
  textAlign: 'left', cursor: 'pointer', fontSize: '14px', fontWeight: 600, color: '#333',
};

type ImportMode = 'insert' | 'update';
type ImportResult = { imported: number; skipped: number; updated?: number; mode: ImportMode };
type WaLine = { id: string; label: string | null; active: boolean; is_default: boolean };

// Split de una línea CSV respetando comillas: Google Contacts exporta campos
// entrecomillados con comas adentro, que un split(',') simple desalinearía.
function splitCSVLine(line: string): string[] {
  const cols: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cols.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur.trim());
  return cols;
}

type ParsedRow = { phone: string; casino_username: string; name: string };
type HeaderMap = { phoneIdx: number; userIdx: number; nameIdx: number };

// Índices de columna del header (misma heurística de siempre: Google Contacts,
// phone/telefono/celular, casino/usuario/first name, name/nombre). null si no
// hay columna de teléfono.
function buildHeaderMap(headerLine: string): HeaderMap | null {
  const headers = splitCSVLine(headerLine).map((h) => h.toLowerCase());
  const idx = (terms: string[]) => headers.findIndex((h) => terms.some((t) => h.includes(t)));
  // Google Contacts: el teléfono viene en "Phone 1 - Value", pero "Phone 1 - Label"
  // aparece ANTES y también contiene "phone" — el header exacto tiene prioridad.
  const googlePhoneIdx = headers.indexOf('phone 1 - value');
  const phoneIdx = googlePhoneIdx !== -1 ? googlePhoneIdx : idx(['phone', 'telefono', 'tel', 'celular']);
  // "first name" (Google Contacts) trae el usuario de casino.
  const userIdx = idx(['casino', 'usuario', 'username', 'user', 'first name']);
  // Exacto primero: "casino_username" también contiene "name" y, si aparece
  // antes en el header, le robaba la columna al nombre.
  const nameExact = headers.findIndex((h) => h === 'name' || h === 'nombre');
  const nameIdx = nameExact !== -1 ? nameExact : idx(['name', 'nombre']);
  if (phoneIdx === -1) return null;
  return { phoneIdx, userIdx, nameIdx };
}

// Parsea UNA fila de datos. null si no tiene teléfono. Google separa múltiples
// teléfonos con ":::" (usamos el primero) y los exporta como "+54 9 ..." mientras
// la base guarda dígitos puros: sin normalizar, el modo actualizar no matchearía.
function parseDataLine(line: string, map: HeaderMap): ParsedRow | null {
  const cols = splitCSVLine(line);
  const phoneRaw = (cols[map.phoneIdx] ?? '').split(':::')[0];
  const phone = phoneRaw.replace(/\D/g, '');
  if (!phone) return null;
  return {
    phone,
    casino_username: map.userIdx !== -1 ? (cols[map.userIdx] ?? '') : '',
    name:            map.nameIdx !== -1 ? (cols[map.nameIdx] ?? '') : '',
  };
}

// Lee el CSV por STREAMING y llama onLine por cada línea (normaliza CRLF/CR a LF),
// sin cargar el archivo entero en memoria. `await onLine` da backpressure natural
// (el envío por lotes es secuencial). Cae a file.text() si el navegador no
// soporta Blob.stream(). Corta apenas cancel.aborted se pone en true.
async function streamCsvLines(
  file: File,
  cancel: { aborted: boolean },
  onLine: (line: string) => void | Promise<void>,
): Promise<void> {
  if (typeof (file as any).stream !== 'function') {
    const text = (await file.text()).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    for (const line of text.split('\n')) { if (cancel.aborted) return; if (line) await onLine(line); }
    return;
  }
  const reader = (file.stream() as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    for (;;) {
      if (cancel.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line) await onLine(line);
        if (cancel.aborted) return;
      }
    }
    buffer += decoder.decode();
    buffer = buffer.replace(/\r/g, '\n');
    for (const line of buffer.split('\n')) { if (cancel.aborted) return; if (line) await onLine(line); }
  } finally {
    reader.releaseLock();
  }
}

// Cuenta filas VÁLIDAS (con teléfono) para el total de la barra "X de Y", sin
// construir objetos. 0 si el header no tiene columna de teléfono.
async function countValidRows(file: File, cancel: { aborted: boolean }): Promise<number> {
  let map: HeaderMap | null = null;
  let first = true;
  let count = 0;
  await streamCsvLines(file, cancel, (line) => {
    if (first) { first = false; map = buildHeaderMap(line); return; }
    if (map && parseDataLine(line, map)) count++;
  });
  return count;
}

// Importación por lotes: tamaño de lote (≈40-90 KB/request, bien bajo el límite
// de body de Vercel) y clave de progreso reanudable en localStorage.
const IMPORT_BATCH_SIZE = 1000;
const IMPORT_PROGRESS_KEY = 'iris_contacts_import_progress';

type ImportProgress = {
  fileKey: string; mode: ImportMode; line: string;
  total: number; sent: number; imported: number; updated: number; skipped: number;
};

function loadImportProgress(): ImportProgress | null {
  try { const r = localStorage.getItem(IMPORT_PROGRESS_KEY); return r ? (JSON.parse(r) as ImportProgress) : null; }
  catch { return null; }
}
function saveImportProgress(p: ImportProgress) { try { localStorage.setItem(IMPORT_PROGRESS_KEY, JSON.stringify(p)); } catch {} }
function clearImportProgress() { try { localStorage.removeItem(IMPORT_PROGRESS_KEY); } catch {} }

export default function ContactsClient() {
  const [contacts,     setContacts]     = useState<ContactRow[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [query,        setQuery]        = useState('');
  const [importing,    setImporting]    = useState(false);
  const [importMode,   setImportMode]   = useState<ImportMode>('insert');
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  // Importación por lotes: fase, progreso "X de Y", error/pausa, y flag de corte.
  const [importPhase,  setImportPhase]  = useState<null | 'analyzing' | 'importing' | 'paused'>(null);
  const [importProg,   setImportProg]   = useState<{ sent: number; total: number; imported: number; updated: number; skipped: number } | null>(null);
  const [importError,  setImportError]  = useState<string | null>(null);
  const cancelRef = useRef<{ aborted: boolean }>({ aborted: false });
  const [lines,        setLines]        = useState<WaLine[]>([]);
  const [lineLabels,   setLineLabels]   = useState<Record<string, string>>({});
  const [importLine,   setImportLine]   = useState('');
  const [showNewContact, setShowNewContact] = useState(false);
  const [showActions,    setShowActions]    = useState(false); // dropdown "Acciones"
  const [showImportPanel, setShowImportPanel] = useState(false); // modal de import CSV
  const [sortDir,        setSortDir]        = useState<SortDir>('az'); // orden alfabético, A-Z por defecto
  const [editing,        setEditing]        = useState<EditableContact | null>(null);
  const [deletingId,     setDeletingId]     = useState<string | null>(null);
  const [selectedIds,    setSelectedIds]    = useState<Set<string>>(new Set()); // selección múltiple
  const [deletingBulk,   setDeletingBulk]   = useState(false);
  const [selectionMode,  setSelectionMode]  = useState(false); // checkboxes + barra flotante on/off
  const [openMenuId,     setOpenMenuId]     = useState<string | null>(null); // menú "⋯" abierto por fila
  const csvInputRef = useRef<HTMLInputElement | null>(null);
  const actionsRef  = useRef<HTMLDivElement | null>(null);
  const menuRef     = useRef<HTMLDivElement | null>(null); // menú de acciones de la fila abierta

  async function fetchContacts() {
    try {
      const res = await fetch('/api/contacts');
      if (!res.ok) return;
      setContacts(await res.json());
    } catch {}
    finally { setLoading(false); }
  }

  useEffect(() => {
    fetchContacts();
    // Líneas activas del tenant para "Asignar a línea" (default: la línea default).
    fetch('/api/whatsapp-numbers')
      .then((r) => (r.ok ? r.json() : []))
      .then((d: WaLine[]) => {
        const all = Array.isArray(d) ? d : [];
        // Mapa id→label de TODAS las líneas (incluso inactivas) para mostrar la
        // columna Línea aunque el contacto pertenezca a una línea ya desactivada.
        setLineLabels(Object.fromEntries(all.map((l) => [l.id, l.label ?? l.id])));
        const activas = all.filter((l) => l.active);
        setLines(activas);
        const def = activas.find((l) => l.is_default) ?? activas[0];
        if (def) setImportLine(def.id);
      })
      .catch(() => {});
    const timer = setInterval(fetchContacts, 15_000);
    return () => clearInterval(timer);
  }, []);

  // Cerrar el dropdown "Acciones" al clickear afuera.
  useEffect(() => {
    if (!showActions) return;
    function onClickOutside(e: MouseEvent) {
      if (actionsRef.current && !actionsRef.current.contains(e.target as Node)) {
        setShowActions(false);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [showActions]);

  // Cerrar el menú "⋯" de la fila al clickear afuera (el ref apunta a la fila abierta).
  useEffect(() => {
    if (!openMenuId) return;
    function onClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpenMenuId(null);
      }
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [openMenuId]);

  // Importa un CSV por STREAMING + lotes secuenciales. Soporta archivos enormes
  // (millones de filas) sin colgar el browser ni pegarle al límite de body de
  // Vercel, muestra progreso "X de Y", y es reanudable: guarda el avance en
  // localStorage tras cada lote, así si se corta (cierre de pestaña, red) se
  // retoma reseleccionando el MISMO archivo. Archivos chicos: igual que siempre
  // (un lote + finalize), transparente para el usuario.
  async function handleCSVImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    const fileKey = `${file.name}::${file.size}::${file.lastModified}`;
    const mode = importMode;
    const line = importLine || '';

    // ── ¿Retomar una importación incompleta del mismo archivo/modo/línea? ──────
    let resumeFrom = 0;
    const sums = { imported: 0, updated: 0, skipped: 0 };
    const saved = loadImportProgress();
    if (saved) {
      const sameJob = saved.fileKey === fileKey && saved.mode === mode && saved.line === line;
      if (sameJob && saved.sent > 0 && saved.sent < saved.total) {
        const cont = window.confirm(
          `Se encontró una importación incompleta de este archivo:\n` +
          `${saved.sent.toLocaleString('es-AR')} de ${saved.total.toLocaleString('es-AR')} contactos ya procesados.\n\n` +
          `Aceptar = continuar desde donde quedó.\nCancelar = empezar de nuevo.`,
        );
        if (cont) {
          resumeFrom = saved.sent;
          sums.imported = saved.imported; sums.updated = saved.updated; sums.skipped = saved.skipped;
        } else {
          clearImportProgress();
        }
      } else if (!sameJob) {
        clearImportProgress(); // progreso de otro archivo → descartar
      }
    }

    const cancel = { aborted: false };
    cancelRef.current = cancel;
    setImporting(true);
    setImportError(null);
    setImportResult(null);
    setImportProg(null);

    try {
      // 1) Pre-pase: contar filas válidas para el total real de la barra.
      setImportPhase('analyzing');
      const total = await countValidRows(file, cancel);
      if (cancel.aborted) { setImportPhase(null); return; }
      if (total === 0) {
        alert('El CSV no tiene datos válidos. Verificá que tenga una columna "phone" en el encabezado.');
        setImportPhase(null);
        return;
      }

      // 2) Streaming + envío por lotes SECUENCIAL.
      setImportPhase('importing');
      setImportProg({ sent: resumeFrom, total, ...sums });

      let map: HeaderMap | null = null;
      let first = true;
      let validSeen = 0;          // filas válidas vistas (para el cursor de resume)
      let batch: ParsedRow[] = [];

      const flush = async () => {
        const res = await fetch('/api/contacts/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contacts: batch, mode, whatsapp_number_id: line || undefined, batch: true }),
        });
        if (!res.ok) throw new Error((await res.text().catch(() => '')) || `El servidor rechazó un lote (HTTP ${res.status}).`);
        const r = await res.json();
        sums.imported += r.imported ?? 0;
        sums.updated  += r.updated  ?? 0;
        sums.skipped  += r.skipped  ?? 0;
        batch = [];
        // Persistimos DESPUÉS de confirmar el lote → si se corta, el resume no
        // cuenta un lote no confirmado (y re-enviarlo es inocuo: el upsert
        // ignora duplicados por (phone, tenant_id)).
        saveImportProgress({ fileKey, mode, line, total, sent: validSeen, imported: sums.imported, updated: sums.updated, skipped: sums.skipped });
        setImportProg({ sent: validSeen, total, imported: sums.imported, updated: sums.updated, skipped: sums.skipped });
      };

      await streamCsvLines(file, cancel, async (rawLine) => {
        if (first) {
          first = false;
          map = buildHeaderMap(rawLine);
          if (!map) throw new Error('El CSV no tiene una columna de teléfono en el encabezado.');
          return;
        }
        const row = parseDataLine(rawLine, map!);
        if (!row) return;
        validSeen++;
        if (validSeen <= resumeFrom) return; // ya enviado en una corrida previa
        batch.push(row);
        if (batch.length >= IMPORT_BATCH_SIZE) await flush();
      });

      if (cancel.aborted) {
        // Pausado: el progreso quedó guardado; se retoma reseleccionando el archivo.
        if (batch.length > 0) await flush(); // guarda lo ya parseado antes de cortar
        setImportPhase('paused');
        return;
      }

      if (batch.length > 0) await flush();

      // 3) Cierre: UNA sola entrada de actividad con los totales, y limpiar progreso.
      await fetch('/api/contacts/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ finalize: true, mode, imported: sums.imported, updated: sums.updated, skipped: sums.skipped, total }),
      }).catch(() => {});
      clearImportProgress();

      setImportResult({ imported: sums.imported, updated: sums.updated, skipped: sums.skipped, mode });
      setImportPhase(null);
      setShowImportPanel(false);
      fetchContacts();
    } catch (err: any) {
      // El progreso quedó guardado en el último flush → se puede retomar.
      setImportError(
        (err?.message ? `${err.message} ` : 'Error al importar el CSV. ') +
        'El progreso quedó guardado: volvé a seleccionar el MISMO archivo para retomar desde donde quedó.',
      );
      setImportPhase('paused');
    } finally {
      setImporting(false);
    }
  }

  async function handleDelete(c: ContactRow) {
    const nombre = c.casino_username || c.phone;
    if (!confirm(
      `¿Eliminar contacto ${nombre}? Esta acción no se puede deshacer.\n\n` +
      `Se borrará también TODO su historial: mensajes, comprobantes y leads.`,
    )) return;
    setDeletingId(c.id);
    try {
      const res = await fetch(`/api/contacts?id=${encodeURIComponent(c.id)}`, { method: 'DELETE' });
      if (res.ok) {
        setContacts((prev) => prev.filter((x) => x.id !== c.id));
      } else {
        const data = await res.json().catch(() => ({} as any));
        alert(data?.error || 'No se pudo eliminar el contacto.');
      }
    } catch {
      alert('Error de red al eliminar el contacto.');
    } finally {
      setDeletingId(null);
    }
  }

  // ── Selección múltiple ──
  function toggleOne(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function handleDeleteBulk() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (!confirm(
      `¿Eliminar ${ids.length} contacto${ids.length !== 1 ? 's' : ''}? Esta acción no se puede deshacer.\n\n` +
      `Se borrará también TODO su historial: mensajes, comprobantes y leads.`,
    )) return;
    setDeletingBulk(true);
    try {
      const res = await fetch('/api/contacts', {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ids }),
      });
      if (res.ok) {
        const idset = new Set(ids);
        setContacts((prev) => prev.filter((c) => !idset.has(c.id)));
        setSelectedIds(new Set());
      } else {
        const raw = await res.text().catch(() => '');
        // Log de la causa exacta para diagnosticar (status + cuerpo del server).
        console.error('[ContactsClient] bulk delete falló', { status: res.status, count: ids.length, body: raw });
        let data: any = {};
        try { data = JSON.parse(raw); } catch {}
        alert(data?.error || 'No se pudieron eliminar los contactos.');
      }
    } catch (err) {
      console.error('[ContactsClient] error de red en bulk delete', err);
      alert('Error de red al eliminar.');
    } finally {
      setDeletingBulk(false);
    }
  }

  // Filtra por búsqueda y ORDENA alfabéticamente por usuario de casino (lo que se
  // ve en la lista). A-Z por defecto, Z-A con el toggle. localeCompare con 'es'
  // para que acentos/ñ ordenen como corresponde.
  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    const base = !q ? contacts : contacts.filter(c =>
      c.casino_username?.toLowerCase().includes(q) ||
      c.name?.toLowerCase().includes(q) ||
      c.phone?.includes(q),
    );
    const sorted = [...base].sort((a, b) =>
      (a.casino_username || '').localeCompare(b.casino_username || '', 'es', { sensitivity: 'base' }),
    );
    return sortDir === 'az' ? sorted : sorted.reverse();
  }, [contacts, query, sortDir]);

  // "Seleccionar todos" opera sobre lo FILTRADO (lo que se ve).
  const filteredIds  = filtered.map((c) => c.id);
  const allSelected  = filteredIds.length > 0 && filteredIds.every((id) => selectedIds.has(id));
  const someSelected = filteredIds.some((id) => selectedIds.has(id));
  function toggleAll() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allSelected) filteredIds.forEach((id) => next.delete(id));
      else             filteredIds.forEach((id) => next.add(id));
      return next;
    });
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* Search + Import */}
      <div className="contacts-toolbar" style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          className="contacts-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar por nombre, usuario casino o teléfono..."
          style={{
            flex: 1,
            minWidth: 0,
            padding: '12px 16px',
            fontSize: '14px',
            border: '2px solid #e0e0e0',
            borderRadius: '12px',
            outline: 'none',
            background: '#fff',
          }}
        />
        <input ref={csvInputRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={handleCSVImport} />

        {/* Orden alfabético por usuario de casino (A-Z por defecto). */}
        <select
          value={sortDir}
          onChange={(e) => setSortDir(e.target.value as SortDir)}
          title="Ordenar contactos"
          style={{
            flexShrink: 0, background: '#fff', color: '#333', fontWeight: 700, fontSize: '13px',
            border: '2px solid #e0e0e0', borderRadius: '12px', padding: '12px 14px', cursor: 'pointer', outline: 'none',
          }}
        >
          <option value="az">Nombre A → Z</option>
          <option value="za">Nombre Z → A</option>
        </select>

        {/* Modo selección: muestra/oculta checkboxes + barra flotante. Al apagarlo
            limpia la selección actual. */}
        <button
          onClick={() => setSelectionMode((v) => { if (v) setSelectedIds(new Set()); return !v; })}
          title={selectionMode ? 'Salir del modo selección' : 'Seleccionar contactos'}
          style={{
            flexShrink: 0, fontWeight: 700, fontSize: '13px', cursor: 'pointer', outline: 'none',
            borderRadius: '12px', padding: '12px 16px', whiteSpace: 'nowrap',
            border: '2px solid ' + (selectionMode ? '#1a1a1a' : '#e0e0e0'),
            background: selectionMode ? '#1a1a1a' : '#fff',
            color: selectionMode ? '#C8FF00' : '#333',
          }}
        >
          {selectionMode ? '✓ Seleccionando' : 'Seleccionar'}
        </button>

        {/* Menú "Acciones": agrupa importar/actualizar, nuevo contacto y exportar */}
        <div ref={actionsRef} style={{ position: 'relative', flexShrink: 0 }}>
          <button
            onClick={() => setShowActions((v) => !v)}
            style={{
              background: '#1a1a1a', color: '#C8FF00', fontWeight: 700, fontSize: '14px',
              border: '2px solid transparent', borderRadius: '12px', padding: '12px 18px', cursor: 'pointer',
              whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '8px',
            }}
          >
            Acciones <span style={{ fontSize: '10px' }}>▾</span>
          </button>

          {showActions && (
            <div className="contacts-actions-menu" style={{
              position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 50,
              background: '#fff', borderRadius: '12px', boxShadow: '0 8px 28px rgba(0,0,0,0.16)',
              padding: '6px', minWidth: '220px', maxWidth: 'calc(100vw - 32px)',
              display: 'flex', flexDirection: 'column', gap: '2px',
            }}>
              <button
                onClick={() => { setShowActions(false); setShowImportPanel(true); }}
                style={menuItem}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#F5F5F5')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
              >
                <span style={{ fontSize: '16px' }}>⬆</span> Importar / Actualizar CSV
              </button>
              <button
                onClick={() => { setShowActions(false); setShowNewContact(true); }}
                style={menuItem}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#F5F5F5')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
              >
                <span style={{ fontSize: '16px' }}>➕</span> Nuevo contacto
              </button>
              <a
                href="/api/contacts/export"
                onClick={() => setShowActions(false)}
                style={{ ...menuItem, textDecoration: 'none' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = '#F5F5F5')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
              >
                <span style={{ fontSize: '16px' }}>⬇</span> Exportar CSV
              </a>
            </div>
          )}
        </div>
      </div>

      {/* Import result banner */}
      {importResult && (() => {
        const hasChanges = importResult.imported > 0 || (importResult.updated ?? 0) > 0;
        return (
          <div style={{
            background: hasChanges ? '#f0fff4' : '#f5f5f5',
            border: `1px solid ${hasChanges ? '#86efac' : '#e0e0e0'}`,
            borderRadius: '12px',
            padding: '12px 18px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
          }}>
            <p style={{ margin: 0, fontSize: '14px', fontWeight: 600, color: '#1a1a1a' }}>
              {importResult.mode === 'update' ? (
                <>
                  {hasChanges ? '✅ ' : '— '}
                  {importResult.imported} insertado{importResult.imported !== 1 ? 's' : ''},{' '}
                  {importResult.updated ?? 0} actualizado{(importResult.updated ?? 0) !== 1 ? 's' : ''},{' '}
                  {importResult.skipped} sin cambios
                </>
              ) : (
                <>
                  {importResult.imported > 0
                    ? `✅ ${importResult.imported} contacto${importResult.imported !== 1 ? 's' : ''} importado${importResult.imported !== 1 ? 's' : ''}`
                    : '— Sin contactos nuevos'}
                  {importResult.skipped > 0 && (
                    <span style={{ fontWeight: 400, color: '#888', marginLeft: '8px' }}>
                      · {importResult.skipped} ya existían
                    </span>
                  )}
                </>
              )}
            </p>
            <button onClick={() => setImportResult(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#999', fontSize: '18px', lineHeight: 1, padding: '2px' }}>×</button>
          </div>
        );
      })()}

      {loading && (
        <p style={{ textAlign: 'center', color: '#999', fontSize: '14px' }}>Cargando contactos...</p>
      )}

      {!loading && filtered.length === 0 && (
        <p style={{ textAlign: 'center', color: '#999', fontSize: '14px' }}>
          {query ? 'Sin resultados para esa búsqueda.' : 'No hay contactos agendados.'}
        </p>
      )}

      {/* Table header */}
      {filtered.length > 0 && (
        <div className={`contacts-table ${selectionMode ? 'selecting' : ''}`} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div className="contact-row contact-header">
            <span className="c-check" />
            <span>Usuario casino</span>
            <span>Teléfono</span>
            <span>Línea</span>
            <span>Estado</span>
            <span>Alta</span>
            <span />
          </div>

          {filtered.map((c) => {
            const initial = (c.casino_username || c.phone).charAt(0).toUpperCase();
            const sc      = STATUS_COLOR[c.status] ?? STATUS_COLOR.nuevo;
            return (
              <div key={c.id} className="contact-row contact-card">
                {/* Checkbox de selección (solo en modo selección) */}
                <span className="c-check">
                  {selectionMode && (
                    <input
                      type="checkbox"
                      checked={selectedIds.has(c.id)}
                      onChange={() => toggleOne(c.id)}
                      title="Seleccionar contacto"
                      style={{ cursor: 'pointer' }}
                    />
                  )}
                </span>
                {/* Avatar */}
                <div className="c-avatar" style={{
                  width: '36px', height: '36px', borderRadius: '50%',
                  background: '#C8FF00', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', fontWeight: 800, fontSize: '15px', color: '#000',
                }}>
                  {initial}
                </div>

                {/* Usuario casino */}
                <p className="c-user" style={{ margin: 0, fontSize: '14px', fontWeight: 700, color: '#111', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  🎰 {c.casino_username}
                </p>

                {/* Teléfono */}
                <p className="c-phone" style={{ margin: 0, fontSize: '13px', color: '#666' }}>{c.phone}</p>

                {/* Línea de WhatsApp */}
                {(() => {
                  const label = c.whatsapp_number_id ? lineLabels[c.whatsapp_number_id] : null;
                  return (
                    <span className="c-line">
                      {label ? (
                        <span style={{
                          display: 'inline-block', maxWidth: '100%', overflow: 'hidden',
                          textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom',
                          background: '#F0F0F0', color: '#555', fontSize: '11px', fontWeight: 700,
                          borderRadius: '999px', padding: '3px 9px',
                        }}>
                          📱 {label}
                        </span>
                      ) : (
                        <span style={{ color: '#ccc', fontSize: '13px' }}>—</span>
                      )}
                    </span>
                  );
                })()}

                {/* Estado */}
                <span className="c-status" style={{
                  ...sc,
                  borderRadius: '999px',
                  padding: '4px 10px',
                  fontSize: '11px',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                  display: 'inline-block',
                  textAlign: 'center',
                }}>
                  {c.status}
                </span>

                {/* Fecha */}
                <p className="c-date" style={{ margin: 0, fontSize: '12px', color: '#aaa' }}>
                  {new Date(c.created_at).toLocaleDateString('es-AR')}
                </p>

                {/* Acciones: menú "⋯" con conversación, editar, borrar */}
                <div
                  className="c-actions"
                  ref={openMenuId === c.id ? menuRef : null}
                  style={{ position: 'relative' }}
                >
                  <button
                    onClick={() => setOpenMenuId(openMenuId === c.id ? null : c.id)}
                    title="Acciones"
                    style={{
                      width: '32px', height: '32px', borderRadius: '8px', border: 'none',
                      background: openMenuId === c.id ? '#1a1a1a' : '#F0F0F0',
                      color: openMenuId === c.id ? '#C8FF00' : '#333',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      cursor: 'pointer', fontSize: '18px', fontWeight: 800, lineHeight: 1,
                    }}
                  >
                    ⋯
                  </button>

                  {openMenuId === c.id && (
                    <div style={{
                      position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 60,
                      background: '#fff', borderRadius: '12px', boxShadow: '0 8px 28px rgba(0,0,0,0.16)',
                      padding: '6px', minWidth: '190px', display: 'flex', flexDirection: 'column', gap: '2px',
                    }}>
                      <Link
                        href={`/conversaciones/${c.id}`}
                        onClick={() => setOpenMenuId(null)}
                        style={{ ...menuItem, textDecoration: 'none' }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = '#F5F5F5')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                      >
                        <span style={{ fontSize: '16px' }}>💬</span> Ir a conversación
                      </Link>
                      <button
                        onClick={() => { setOpenMenuId(null); setEditing({ id: c.id, casino_username: c.casino_username, name: c.name, phone: c.phone, status: c.status }); }}
                        style={menuItem}
                        onMouseEnter={(e) => (e.currentTarget.style.background = '#F5F5F5')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                      >
                        <span style={{ fontSize: '16px' }}>✏️</span> Editar contacto
                      </button>
                      <button
                        onClick={() => { setOpenMenuId(null); handleDelete(c); }}
                        disabled={deletingId === c.id}
                        style={{ ...menuItem, color: '#c0392b', cursor: deletingId === c.id ? 'not-allowed' : 'pointer', opacity: deletingId === c.id ? 0.5 : 1 }}
                        onMouseEnter={(e) => (e.currentTarget.style.background = '#FFE9E9')}
                        onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
                      >
                        <span style={{ fontSize: '16px' }}>🗑️</span> Eliminar contacto
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Barra flotante de selección múltiple (solo en modo selección) */}
      {selectionMode && filtered.length > 0 && (
        <div style={{
          position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)', zIndex: 200,
          background: '#1a1a1a', color: '#fff', borderRadius: '14px', boxShadow: '0 8px 30px rgba(0,0,0,0.3)',
          padding: '12px 18px', display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: '14px', fontWeight: 700 }}>
            {selectedIds.size > 0
              ? `${selectedIds.size} contacto${selectedIds.size !== 1 ? 's' : ''} seleccionado${selectedIds.size !== 1 ? 's' : ''}`
              : 'Seleccionar contactos'}
          </span>
          <button
            onClick={toggleAll}
            title={allSelected ? 'Deseleccionar todos' : 'Seleccionar todos'}
            style={{
              background: someSelected && !allSelected ? 'rgba(255,255,255,0.18)' : 'none',
              border: '1px solid rgba(255,255,255,0.35)', color: '#fff', fontSize: '13px', fontWeight: 700,
              borderRadius: '10px', padding: '8px 14px', cursor: 'pointer',
            }}
          >
            {allSelected ? '☑ Todos' : '☐ Todos'}
          </button>
          {selectedIds.size > 0 && (
            <>
              <button
                onClick={() => setSelectedIds(new Set())}
                style={{ background: 'none', border: 'none', color: '#aaa', fontSize: '13px', fontWeight: 600, cursor: 'pointer' }}
              >
                Limpiar
              </button>
              <button
                onClick={handleDeleteBulk}
                disabled={deletingBulk}
                style={{
                  background: '#E53935', color: '#fff', fontWeight: 800, fontSize: '13px', border: 'none',
                  borderRadius: '10px', padding: '9px 16px', cursor: deletingBulk ? 'not-allowed' : 'pointer',
                  opacity: deletingBulk ? 0.6 : 1,
                }}
              >
                {deletingBulk ? 'Eliminando…' : 'Eliminar seleccionados 🗑️'}
              </button>
            </>
          )}
        </div>
      )}

      {showNewContact && (
        <NewContactModal
          onClose={() => setShowNewContact(false)}
          onCreated={fetchContacts}
        />
      )}

      {editing && (
        <EditContactModal
          contact={editing}
          onClose={() => setEditing(null)}
          onSaved={fetchContacts}
        />
      )}

      {/* Modal de Importar / Actualizar CSV: agrupa los controles que antes
          estaban sueltos en la barra (línea + modo + selección de archivo). */}
      {showImportPanel && (
        <div
          onClick={() => !importing && setShowImportPanel(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px' }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: '16px', width: '100%', maxWidth: '460px', padding: '22px', display: 'flex', flexDirection: 'column', gap: '16px', boxShadow: '0 20px 60px rgba(0,0,0,0.35)' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0, fontSize: '17px', fontWeight: 800, color: '#000' }}>Importar / Actualizar CSV</h3>
              <button onClick={() => !importing && setShowImportPanel(false)} disabled={importing} aria-label="Cerrar" style={{ background: 'none', border: 'none', cursor: importing ? 'not-allowed' : 'pointer', color: '#999', fontSize: '22px', lineHeight: 1, padding: '2px' }}>×</button>
            </div>

            <p style={{ margin: 0, fontSize: '12px', color: '#999', lineHeight: 1.5 }}>
              Columnas soportadas: <code>phone</code> (requerida), <code>casino_username</code>, <code>name</code>.
            </p>

            {/* Línea a la que se asignan los contactos importados */}
            {lines.length > 0 && (
              <div>
                <p style={{ fontSize: '12px', fontWeight: 700, color: '#666', marginBottom: '5px' }}>Asignar a línea</p>
                <select
                  value={importLine}
                  onChange={(e) => setImportLine(e.target.value)}
                  disabled={importing}
                  title="Los contactos nuevos quedan en esta línea; en modo actualizar, también los existentes sin línea."
                  style={{ width: '100%', background: '#1a1a1a', color: '#C8FF00', fontWeight: 700, fontSize: '13px', border: 'none', borderRadius: '10px', padding: '11px 12px', cursor: importing ? 'not-allowed' : 'pointer', opacity: importing ? 0.6 : 1 }}
                >
                  {lines.map((l) => (
                    <option key={l.id} value={l.id}>
                      📱 {(l.label ?? l.id)}{l.is_default ? ' (default)' : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Modo de import: insertar nuevos vs completar datos de existentes */}
            <div>
              <p style={{ fontSize: '12px', fontWeight: 700, color: '#666', marginBottom: '5px' }}>Modo</p>
              <div style={{ display: 'flex', background: '#F5F5F5', borderRadius: '12px', padding: '3px' }}>
                {([
                  { value: 'insert', label: 'Insertar nuevos' },
                  { value: 'update', label: 'Actualizar existentes' },
                ] as { value: ImportMode; label: string }[]).map((m) => (
                  <button
                    key={m.value}
                    onClick={() => !importing && setImportMode(m.value)}
                    disabled={importing}
                    title={m.value === 'insert'
                      ? 'Solo agrega teléfonos que no existen; los repetidos se saltean.'
                      : 'Completa name, casino_username y provincia vacíos de contactos existentes; los teléfonos nuevos se insertan igual.'}
                    style={{
                      flex: 1,
                      background: importMode === m.value ? '#1a1a1a' : 'transparent',
                      color: importMode === m.value ? '#C8FF00' : '#888',
                      fontWeight: 700, fontSize: '12px', border: 'none', borderRadius: '10px',
                      padding: '9px 14px', cursor: importing ? 'not-allowed' : 'pointer', whiteSpace: 'nowrap',
                    }}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            {importPhase === 'analyzing' ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', justifyContent: 'center', padding: '14px', color: '#666', fontSize: '13px', fontWeight: 700 }}>
                ⏳ Analizando archivo…
              </div>
            ) : importPhase === 'importing' && importProg ? (
              (() => {
                const pct = Math.min(100, Math.round((importProg.sent / Math.max(1, importProg.total)) * 100));
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    <div style={{ height: '10px', background: '#eee', borderRadius: '999px', overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: '#C8FF00', borderRadius: '999px', transition: 'width 0.2s ease' }} />
                    </div>
                    <p style={{ margin: 0, fontSize: '13px', fontWeight: 800, color: '#000' }}>
                      {importProg.sent.toLocaleString('es-AR')} de {importProg.total.toLocaleString('es-AR')} contactos ({pct}%)
                    </p>
                    <p style={{ margin: 0, fontSize: '12px', color: '#666' }}>
                      Importados: {importProg.imported.toLocaleString('es-AR')}
                      {importMode === 'update' ? ` · Actualizados: ${importProg.updated.toLocaleString('es-AR')}` : ''}
                      {' '}· Omitidos: {importProg.skipped.toLocaleString('es-AR')}
                    </p>
                    <button
                      onClick={() => { cancelRef.current.aborted = true; }}
                      style={{ background: '#F5F5F5', color: '#333', fontWeight: 800, fontSize: '13px', border: 'none', borderRadius: '10px', padding: '10px', cursor: 'pointer' }}
                    >
                      Pausar
                    </button>
                    <p style={{ margin: 0, fontSize: '11px', color: '#999', lineHeight: 1.4 }}>
                      No cierres esta pestaña. Si se corta, retomás desde acá reseleccionando el mismo archivo.
                    </p>
                  </div>
                );
              })()
            ) : (
              <>
                {importPhase === 'paused' && importProg && (
                  <div style={{ background: '#FFF8E1', border: '1px solid #FFE082', borderRadius: '10px', padding: '10px 12px', fontSize: '12px', color: '#8a6d00', lineHeight: 1.5 }}>
                    ⏸ Pausado en {importProg.sent.toLocaleString('es-AR')} de {importProg.total.toLocaleString('es-AR')}. Reseleccioná el <strong>mismo archivo</strong> para retomar.
                  </div>
                )}
                {importError && (
                  <div style={{ background: '#FDECEA', border: '1px solid #F5C6C2', borderRadius: '10px', padding: '10px 12px', fontSize: '12px', color: '#B71C1C', lineHeight: 1.5 }}>
                    {importError}
                  </div>
                )}
                <button
                  onClick={() => csvInputRef.current?.click()}
                  style={{
                    background: '#1a1a1a', color: '#C8FF00',
                    fontWeight: 800, fontSize: '14px', border: 'none', borderRadius: '10px',
                    padding: '12px', cursor: 'pointer',
                  }}
                >
                  {importPhase === 'paused' ? '⬆ Reseleccionar archivo para retomar' : '⬆ Seleccionar archivo CSV'}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
