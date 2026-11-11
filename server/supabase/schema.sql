-- Westgate Sales Assistant: what the server keeps that Close doesn't have.
-- Run once in the Supabase SQL editor. Only the server (service-role key) reads
-- these: row-level security is on and there are no policies.

-- Reps: whose Close account the assistant works in. Added by signing up (their
-- Close API key) or by `npm run push-reps`. token_hash is the side panel's older
-- per-rep token (sha256 hex), kept until everyone signs in with email.
create table if not exists reps (
  email         text primary key,
  name          text not null,
  close_api_key text not null,
  timezone      text,
  token_hash    text unique,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- Sign-in: email + scrypt password hash. Sessions are signed tokens, not stored.
create table if not exists users (
  email         text primary key,
  password_hash text not null,
  created_at    timestamptz not null default now(),
  last_login    timestamptz
);

-- Call reviews the AI built after a call, until they're saved to Close.
-- Saved ones stay a day for the panel; everything but unapproved reviews is deleted after 8 days.
create table if not exists reviews (
  id          text primary key,
  rep_id      text not null,          -- Close user id
  lead_id     text not null,
  call_id     text,
  state       text not null,          -- building | ready | saved | failed | done | discarded
  created_at  timestamptz not null,
  updated_at  timestamptz not null default now(),
  lease_until timestamptz not null default 'epoch',  -- one worker builds a review at a time
  data        jsonb not null
);
create index if not exists reviews_rep_created on reviews (rep_id, created_at desc);
create index if not exists reviews_call on reviews (call_id);
create index if not exists reviews_state on reviews (state);

-- Lead Briefs (AI output), cached for a week so reopening a lead is instant.
create table if not exists brief_cache (
  key        text primary key,
  value      jsonb not null,
  expires_at timestamptz not null
);
create index if not exists brief_cache_expires on brief_cache (expires_at);

-- Email drafts the pre-save checks blocked, for tuning the rules.
create table if not exists draft_rejections (
  id      bigint generated always as identity primary key,
  at      timestamptz not null,
  lead_id text,
  data    jsonb not null
);
create index if not exists draft_rejections_at on draft_rejections (at desc);

-- Emails the automation scheduled, and why (Close has the emails themselves).
create table if not exists automations (
  id         text primary key,      -- the Close email id
  rep_id     text not null,
  lead_id    text not null,
  created_at timestamptz not null,
  status     text not null,         -- scheduled | sent | skipped | stopped | failed
  data       jsonb not null
);
create index if not exists automations_rep_created on automations (rep_id, created_at desc);

-- Per-rep switches (automatic bumps on/off, last planning day).
create table if not exists settings (
  rep_id text not null,
  key    text not null,
  value  jsonb,
  primary key (rep_id, key)
);

-- One record per rep and account (11/10): what Close knows about the lead, trimmed to what the board needs, and
-- what the app made of it (heat, cadence, next step). Close's webhooks keep it current; a nightly rescan rebuilds
-- it. The pages read these rows instead of rescanning 45 days of Close every ten minutes.
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

-- Every scoring event, one row each (Walt 11/11: "store RFQs, line cards sent, etc. so we can display players stats"):
-- a dial, a buyer named, a card to the buyer, a buyer reached, an RFQ. Written from the same facts the West Game
-- scores, once a day for the day before and on every catch-up for today, so seasons and bests never re-read Close.
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

alter table automations      enable row level security;
alter table account_state    enable row level security;
alter table rung_events      enable row level security;
alter table settings         enable row level security;
alter table reps             enable row level security;
alter table users            enable row level security;
alter table reviews          enable row level security;
alter table brief_cache      enable row level security;
alter table draft_rejections enable row level security;
