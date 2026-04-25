import { createClient } from '@supabase/supabase-js';

// ─── SUPABASE SETUP ───────────────────────────────────────────────────────
// Option A: create a .env file using .env.example
// Option B: leave it empty and the app will use local-only classroom accounts
//
// Required SQL in Supabase SQL Editor:
//
// create table if not exists profiles (
//   id uuid references auth.users(id) primary key,
//   name text,
//   email text,
//   coins int default 50,
//   blynk jsonb,
//   tests_taken int default 0,
//   best_score int default 0,
//   avg_score int default 0,
//   created_at timestamptz default now()
// );
// alter table profiles enable row level security;
// create policy "profiles are searchable"
//   on profiles for select using (true);
// create policy "users can insert own profile"
//   on profiles for insert with check (auth.uid() = id);
// create policy "users can update own profile"
//   on profiles for update using (auth.uid() = id);
//
// Email/password accounts work without OAuth provider setup.
// Search across devices requires Supabase and the public select policy above.
// ─────────────────────────────────────────────────────────────────────────

const ENV_URL = import.meta.env.VITE_SUPABASE_URL || '';
const ENV_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

function getRuntimeConfig() {
  try {
    return {
      url: localStorage.getItem('cpea_supabase_url') || '',
      key: localStorage.getItem('cpea_supabase_key') || '',
    };
  } catch {
    return { url: '', key: '' };
  }
}

const runtime = getRuntimeConfig();
const SUPABASE_URL = ENV_URL || runtime.url;
const SUPABASE_ANON_KEY = ENV_KEY || runtime.key;

export const supabase = SUPABASE_URL && SUPABASE_ANON_KEY
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

export const supabaseReady = !!supabase;

export function saveSupabaseConfig(url: string, key: string) {
  localStorage.setItem('cpea_supabase_url', url.trim());
  localStorage.setItem('cpea_supabase_key', key.trim());
}

export function clearSupabaseConfig() {
  localStorage.removeItem('cpea_supabase_url');
  localStorage.removeItem('cpea_supabase_key');
}

export type SupabaseProfile = {
  id: string;
  name: string;
  coins: number;
  blynk: Record<string, string> | null;
};
