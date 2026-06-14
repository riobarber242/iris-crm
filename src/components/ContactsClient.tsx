"use client";

import React, { useState, useEffect, useMemo, useRef } from 'react';
import Link from 'next/link';

type ContactRow = {
  id:              string;
  phone:           string;
  status:          string;
  casino_username: string;
  created_at:      string;
};

const STATUS_COLOR: Record<string, { bg: string; fg: string }> = {
  nuevo:          { bg: '#F0F0F0', fg: '#888' },
  en_proceso:     { bg: '#fff8d6', fg: '#b8860b' },
  cliente_activo: { bg: '#C8FF00', fg: '#000' },
  inactivo:       { bg: '#888',    fg: '#fff' },
  bloqueado:      { bg: '#FF4444', fg: '#fff' },
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

function parseCSV(text: string): { phone: string; casino_username: string; name: string }[] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(Boolean);
  if (lines.length < 2) return [];

  const headers = splitCSVLine(lines[0]).map((h) => h.toLowerCase());
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

  if (phoneIdx === -1) return [];

  return lines.slice(1).flatMap((line) => {
    const cols = splitCSVLine(line);
    // Google separa múltiples teléfonos con ":::" — usamos el primero. Y los
    // exporta como "+54 9 ..." mientras la base guarda dígitos puros: sin
    // normalizar acá, el modo actualizar nunca matchearía los existentes.
    const phoneRaw = (cols[phoneIdx] ?? '').split(':::')[0];
    const phone = phoneRaw.replace(/\D/g, '');
    if (!phone) return [];
    return [{
      phone,
      casino_username: userIdx !== -1 ? (cols[userIdx] ?? '') : '',
      name:            nameIdx !== -1 ? (cols[nameIdx] ?? '') : '',
    }];
  });
}

export default function ContactsClient() {
  const [contacts,     setContacts]     = useState<ContactRow[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [query,        setQuery]        = useState('');
  const [importing,    setImporting]    = useState(false);
  const [importMode,   setImportMode]   = useState<ImportMode>('insert');
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [lines,        setLines]        = useState<WaLine[]>([]);
  const [importLine,   setImportLine]   = useState('');
  const csvInputRef = useRef<HTMLInputElement | null>(null);

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
        const activas = (Array.isArray(d) ? d : []).filter((l) => l.active);
        setLines(activas);
        const def = activas.find((l) => l.is_default) ?? activas[0];
        if (def) setImportLine(def.id);
      })
      .catch(() => {});
    const timer = setInterval(fetchContacts, 15_000);
    return () => clearInterval(timer);
  }, []);

  async function handleCSVImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setImporting(true);
    setImportResult(null);
    try {
      const text = await file.text();
      const contacts = parseCSV(text);
      if (contacts.length === 0) {
        alert('El CSV no tiene datos válidos. Verificá que tenga una columna "phone" en el encabezado.');
        setImporting(false);
        return;
      }
      const res = await fetch('/api/contacts/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contacts, mode: importMode, whatsapp_number_id: importLine || undefined }),
      });
      if (res.ok) {
        const result = await res.json();
        setImportResult({ ...result, mode: importMode });
        fetchContacts();
      }
    } catch {
      alert('Error al importar el CSV.');
    }
    setImporting(false);
  }

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    if (!q) return contacts;
    return contacts.filter(c =>
      c.casino_username?.toLowerCase().includes(q) ||
      c.phone?.includes(q),
    );
  }, [contacts, query]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* Search + Import */}
      <div style={{ display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar por nombre, usuario casino o teléfono..."
          style={{
            flex: 1,
            padding: '12px 16px',
            fontSize: '14px',
            border: '2px solid #e0e0e0',
            borderRadius: '12px',
            outline: 'none',
            background: '#fff',
          }}
        />
        <input ref={csvInputRef} type="file" accept=".csv,text/csv" style={{ display: 'none' }} onChange={handleCSVImport} />

        {/* Línea a la que se asignan los contactos importados */}
        {lines.length > 0 && (
          <select
            value={importLine}
            onChange={(e) => setImportLine(e.target.value)}
            title="Asignar a línea: los contactos nuevos quedan en esta línea de WhatsApp; en modo actualizar, también los existentes sin línea."
            style={{
              background: '#1a1a1a', color: '#C8FF00', fontWeight: 700, fontSize: '12px',
              border: 'none', borderRadius: '12px', padding: '11px 12px', cursor: 'pointer', flexShrink: 0,
            }}
          >
            {lines.map((l) => (
              <option key={l.id} value={l.id}>
                📱 {(l.label ?? l.id)}{l.is_default ? ' (default)' : ''}
              </option>
            ))}
          </select>
        )}

        {/* Modo de import: insertar nuevos vs completar datos de existentes */}
        <div style={{ display: 'flex', background: '#F5F5F5', borderRadius: '12px', padding: '3px', flexShrink: 0 }}>
          {([
            { value: 'insert', label: 'Insertar nuevos' },
            { value: 'update', label: 'Actualizar existentes' },
          ] as { value: ImportMode; label: string }[]).map((m) => (
            <button
              key={m.value}
              onClick={() => setImportMode(m.value)}
              title={m.value === 'insert'
                ? 'Solo agrega teléfonos que no existen; los repetidos se saltean.'
                : 'Completa name, casino_username y provincia vacíos de contactos existentes; los teléfonos nuevos se insertan igual.'}
              style={{
                background: importMode === m.value ? '#1a1a1a' : 'transparent',
                color: importMode === m.value ? '#C8FF00' : '#888',
                fontWeight: 700, fontSize: '12px', border: 'none', borderRadius: '10px',
                padding: '9px 14px', cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              {m.label}
            </button>
          ))}
        </div>

        <button
          onClick={() => csvInputRef.current?.click()}
          disabled={importing}
          title={'Columnas soportadas: phone (requerida), casino_username, name'}
          style={{
            background: importing ? '#e0e0e0' : '#1a1a1a',
            color: importing ? '#888' : '#C8FF00',
            fontWeight: 700,
            fontSize: '13px',
            border: 'none',
            borderRadius: '12px',
            padding: '12px 18px',
            cursor: importing ? 'not-allowed' : 'pointer',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {importing ? 'Importando...' : '⬆ Importar CSV'}
        </button>
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
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div className="contact-row contact-header">
            <span />
            <span>Usuario casino</span>
            <span>Teléfono</span>
            <span>Estado</span>
            <span>Alta</span>
            <span />
          </div>

          {filtered.map((c) => {
            const initial = (c.casino_username || c.phone).charAt(0).toUpperCase();
            const sc      = STATUS_COLOR[c.status] ?? STATUS_COLOR.nuevo;
            return (
              <div key={c.id} className="contact-row contact-card">
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

                {/* Botón conversación */}
                <Link href={`/conversations/${c.id}`} className="c-chat" style={{ textDecoration: 'none' }}>
                  <div style={{
                    width: '32px', height: '32px', borderRadius: '8px',
                    background: '#1a1a1a', display: 'flex', alignItems: 'center',
                    justifyContent: 'center', cursor: 'pointer', fontSize: '16px',
                  }} title="Ir a conversación">
                    💬
                  </div>
                </Link>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
