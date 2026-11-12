-- Both tables the hosted app is missing (11/12), in one paste: the Supabase SQL editor, project "test", run once.

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

create table if not exists rung_events (
  id      text primary key,          -- the call id for a dial; rep:lead:rung for the rest; rep:lead:rfq:day for an RFQ
  rep_id  text not null,             -- Close user id
  lead_id text,
  company text,
  kind    text not null,             -- dial | named | card | reached | rfq
  at      timestamptz not null,
  day     text not null,             -- the rep's local day, YYYY-MM-DD
  points  int not null,
  first   boolean not null default false,  -- an RFQ that was the company's first
  data    jsonb
);
create index if not exists rung_events_rep_day on rung_events (rep_id, day);
alter table rung_events enable row level security;
