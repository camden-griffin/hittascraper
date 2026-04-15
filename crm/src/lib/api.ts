export type Lead = {
  org_nr: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  branch: string | null;
  branch_segment: string | null;
  sni_code: string | null;
  icp_score: number | null;
  icp_reasons: string | null;
  is_ab: number | null;
  reg_year: number | null;
  company_age: number | null;
  employees: number | null;
  omsattning_sek: number | null;
  omsattning_year: number | null;
  rorelseresultat_sek: number | null;
  arets_resultat_sek: number | null;
  kortfristiga_skulder_sek: number | null;
  langfristiga_skulder_sek: number | null;
  lender_keywords: string | null;
  keyword_line_1: string | null;
  recent_year_value: string | null;
  previous_year_value: string | null;
  keyword_line_2: string | null;
  recent_year_value_2: string | null;
  previous_year_value_2: string | null;
  resolved: number;
  resolved_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

const TOKEN_KEY = 'crm_token';

export function getToken() { return localStorage.getItem(TOKEN_KEY); }
function saveToken(t: string) { localStorage.setItem(TOKEN_KEY, t); }
function clearToken() { localStorage.removeItem(TOKEN_KEY); }

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  if (res.status === 401) { clearToken(); window.location.reload(); throw new Error('Unauthorized'); }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  async login(email: string, password: string) {
    const data = await request<{ token: string; email: string }>('/api/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    saveToken(data.token);
    return data;
  },
  logout() { clearToken(); },
  getLeads() { return request<Lead[]>('/api/leads'); },
  patchLead(org_nr: string, patch: Partial<Lead>) {
    return request<Lead>(`/api/leads/${encodeURIComponent(org_nr)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  },
  getBranches() { return request<string[]>('/api/branches'); },
};
