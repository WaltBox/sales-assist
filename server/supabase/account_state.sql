-- The one table the live feed (11/11) needs that the Supabase project "test" did not have on 11/11. Paste into the SQL editor and run once.

create table if not exists account_state (
  rep_id     text not null,          -- Close user id
  lead_id    text not null,
  company    text,
  updated_at timestamptz not null default now(),
  suspect    boolean not null default false,  -- an event couldn't bring it up to date: the reconcile does it first
  data       jsonb,
  primary key (rep_id, lead_id)
);
create index if not exists account_state_rep_updated on account_state (rep_id, updated_at);
create index if not exists account_state_lead on account_state (lead_id);
alter table account_state enable row level security;
