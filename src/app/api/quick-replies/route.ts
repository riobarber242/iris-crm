import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/db';

export async function GET() {
  const { data, error } = await supabaseAdmin
    .from('quick_replies')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data ?? []);
}

export async function POST(req: NextRequest) {
  const { title, content } = await req.json();
  if (!title?.trim() || !content?.trim()) {
    return NextResponse.json({ error: 'title y content son requeridos' }, { status: 400 });
  }
  const { data, error } = await supabaseAdmin
    .from('quick_replies')
    .insert({ title: title.trim(), content: content.trim() })
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}

export async function PUT(req: NextRequest) {
  const { id, title, content } = await req.json();
  if (!id) return NextResponse.json({ error: 'id requerido' }, { status: 400 });
  if (!title?.trim() || !content?.trim()) {
    return NextResponse.json({ error: 'title y content son requeridos' }, { status: 400 });
  }
  const { data, error } = await supabaseAdmin
    .from('quick_replies')
    .update({ title: title.trim(), content: content.trim() })
    .eq('id', id)
    .select()
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest) {
  const { id } = await req.json();
  if (!id) return NextResponse.json({ error: 'id requerido' }, { status: 400 });
  const { error } = await supabaseAdmin.from('quick_replies').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
