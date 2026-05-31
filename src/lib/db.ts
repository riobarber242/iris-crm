import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function missingProxy(name: string) {
  return new Proxy({}, {
    get() {
      throw new Error(`${name} no está configurado. Configurá las variables de entorno apropiadas.`);
    },
  }) as any;
}

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('NEXT_PUBLIC_SUPABASE_URL o NEXT_PUBLIC_SUPABASE_ANON_KEY no configurados. Supabase cliente inactivo.');
}

export const supabase = supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : missingProxy('supabase');
export const supabaseAdmin = supabaseUrl && supabaseServiceRoleKey
  ? createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false } })
  : missingProxy('supabaseAdmin');
