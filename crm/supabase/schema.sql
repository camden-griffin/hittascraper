-- Run this in the Supabase SQL editor for your project.

create table if not exists public.leads (
  org_nr             text primary key,
  name               text,
  email              text,
  phone              text,
  branch             text,
  lender_keywords    text,
  keyword_line_1     text,
  recent_year_value  text,
  previous_year_value text,
  keyword_line_2     text,
  recent_year_value_2  text,
  previous_year_value_2 text,
  resolved           boolean not null default false,
  resolved_at        timestamptz,
  notes              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists leads_branch_idx   on public.leads (branch);
create index if not exists leads_resolved_idx on public.leads (resolved);
create index if not exists leads_name_idx     on public.leads (name);

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if new.resolved is distinct from old.resolved then
    new.resolved_at := case when new.resolved then now() else null end;
  end if;
  return new;
end;
$$;

drop trigger if exists leads_set_updated_at on public.leads;
create trigger leads_set_updated_at
before update on public.leads
for each row execute function public.set_updated_at();

alter table public.leads enable row level security;

drop policy if exists "authenticated read"   on public.leads;
drop policy if exists "authenticated write"  on public.leads;
drop policy if exists "authenticated update" on public.leads;
drop policy if exists "authenticated delete" on public.leads;

create policy "authenticated read"   on public.leads for select using (auth.role() = 'authenticated');
create policy "authenticated write"  on public.leads for insert with check (auth.role() = 'authenticated');
create policy "authenticated update" on public.leads for update using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "authenticated delete" on public.leads for delete using (auth.role() = 'authenticated');
