import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error('Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY. Copy .env.example to .env and fill it in.');
}

export const supabase = createClient(url, anonKey);

export type Lead = {
  org_nr: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  branch: string | null;
  lender_keywords: string | null;
  keyword_line_1: string | null;
  recent_year_value: string | null;
  previous_year_value: string | null;
  keyword_line_2: string | null;
  recent_year_value_2: string | null;
  previous_year_value_2: string | null;
  resolved: boolean;
  resolved_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};
