-- The players' stats table (11/11). Paste into the Supabase SQL editor for project "test" and run once.

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
alter table rung_events enable row level security;
