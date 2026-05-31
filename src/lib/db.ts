import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl) {
  throw new Error('Falta NEXT_PUBLIC_SUPABASE_URL en las variables de entorno');
}

if (!supabaseAnonKey) {
  throw new Error('Falta NEXT_PUBLIC_SUPABASE_ANON_KEY en las variables de entorno');
}

if (!supabaseServiceRoleKey) {
  throw new Error('Falta SUPABASE_SERVICE_ROLE_KEY en las variables de entorno');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    persistSession: false,
  },
});
