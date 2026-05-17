create table public.conversations (
  id bigint generated always as identity primary key,
  session_id text not null,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  created_at timestamptz not null default now()
);

create index conversations_session_created_idx
  on public.conversations (session_id, created_at desc);

alter table public.conversations enable row level security;

create policy "service role full access"
  on public.conversations
  for all
  to service_role
  using (true)
  with check (true);
