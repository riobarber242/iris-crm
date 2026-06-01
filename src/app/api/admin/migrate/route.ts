import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

export async function GET() {
  const steps: string[] = [];

  try {
    const { error: e1 } = await supabaseAdmin.rpc('exec_sql', {
      sql: `ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_status_check;`,
    });
    steps.push(e1 ? `drop constraint error: ${e1.message}` : 'drop constraint OK');

    const { error: e2 } = await supabaseAdmin.rpc('exec_sql', {
      sql: `ALTER TABLE contacts ADD CONSTRAINT contacts_status_check CHECK (status IN ('nuevo', 'cliente_activo', 'inactivo', 'bloqueado', 'en_proceso', 'activo'));`,
    });
    steps.push(e2 ? `add constraint error: ${e2.message}` : 'add constraint OK');

    const { error: e3 } = await supabaseAdmin.rpc('exec_sql', {
      sql: `UPDATE contacts SET status = 'cliente_activo' WHERE status IN ('en_proceso', 'activo');`,
    });
    steps.push(e3 ? `update status error: ${e3.message}` : 'update status OK');

    return NextResponse.json({ ok: true, steps });
  } catch (err: any) {
    return NextResponse.json({ ok: false, steps, error: String(err?.message ?? err) }, { status: 500 });
  }
}
