import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error('Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — see .env.example');
}

export const supabase = createClient(url, key);

export async function requireSession() {
  const { data } = await supabase.auth.getSession();
  if (!data.session) {
    location.href = '/login.html';
    return null;
  }
  return data.session;
}
