import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';
import { hashPassword } from '@/lib/auth';
import { randomBytes } from 'crypto';

// Seeds the first admin (Stage 1 bootstrap).
//
// NOTE: the `agents` table and the message attribution columns must be created
// FIRST in the Supabase SQL Editor (this project has no exec_sql RPC, so DDL
// cannot run through the client). See supabase-auth-migration.sql.
//
// Gated by ?secret= matching CRON_SECRET (fail closed). Idempotent: won't
// create a second admin if one already exists.
//
//   GET /api/admin/seed-auth?secret=XXX[&username=admin&password=YYY]

export async function GET(request: Request) {
  const url    = new URL(request.url);
  const secret = url.searchParams.get('secret');

  const expected = process.env.CRON_SECRET;
  if (!expected || secret !== expected) {
    return NextResponse.json({ ok: false, error: 'No autorizado' }, { status: 403 });
  }

  // Verify the table exists (DDL must have been applied in the SQL editor first)
  const { error: tableErr } = await supabaseAdmin.from('agents').select('id').limit(1);
  if (tableErr) {
    return NextResponse.json({
      ok: false,
      error: 'La tabla agents no existe. Corré supabase-auth-migration.sql en el SQL Editor de Supabase primero.',
      detail: tableErr.message,
    }, { status: 400 });
  }

  // Seed first admin if none exists
  const { data: existingAdmin } = await supabaseAdmin
    .from('agents').select('id, username').eq('role', 'admin').limit(1).maybeSingle();

  if (existingAdmin) {
    return NextResponse.json({ ok: true, seeded: false, message: `Ya existe un admin (username=${existingAdmin.username}).` });
  }

  const username = url.searchParams.get('username') || 'admin';
  const password = url.searchParams.get('password') || randomBytes(9).toString('base64url');

  const { error } = await supabaseAdmin.from('agents').insert({
    username,
    password_hash: hashPassword(password),
    name: 'Admin',
    role: 'admin',
    active: true,
  });
  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  // Returned once so the owner can log in; change it from the panel afterwards.
  return NextResponse.json({ ok: true, seeded: true, admin: { username, password } });
}
