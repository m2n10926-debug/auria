-- intro-writer: Postgres スキーマ定義
-- scripts/migrate-accounts-to-db.js から自動実行される（手動実行も可）

create extension if not exists pgcrypto;

create table if not exists accounts (
  account_id       text primary key,
  display_name     text not null,
  password_salt    text not null,
  password_hash    text not null,
  banned_words_raw text not null default '',
  style_notes_raw  text not null default '',
  heading_structure_raw text not null default '',
  is_admin         boolean not null default false,
  session_version  integer not null default 1,
  created_at       timestamptz not null default now(),
  last_login_at    timestamptz
);

create table if not exists personal_examples (
  id         uuid primary key default gen_random_uuid(),
  account_id text not null references accounts(account_id) on delete cascade,
  title      text not null default '',
  content    text not null,
  created_at timestamptz not null default now()
);
create index if not exists personal_examples_account_id_idx
  on personal_examples (account_id, created_at desc);

create table if not exists history (
  id                     uuid primary key default gen_random_uuid(),
  account_id             text not null references accounts(account_id) on delete cascade,
  name                   text,
  memo                   text,
  output                 text,
  recommendation         text default '',
  model                  text,
  banned_hits            text[] not null default '{}',
  missing_headings       text[] not null default '{}',
  closing_repetition     boolean not null default false,
  missing_recommendation boolean not null default false,
  consistency_warnings   text[] not null default '{}',
  height                 text,
  weight                 text,
  bust                   text,
  type                   text,
  age                    text,
  occupation             text,
  hobby                  text,
  impression             text,
  copied_at              timestamptz,
  edited_at              timestamptz,
  created_at             timestamptz not null default now()
);
create index if not exists history_account_id_created_at_idx
  on history (account_id, created_at desc);

create table if not exists login_events (
  id         uuid primary key default gen_random_uuid(),
  account_id text not null references accounts(account_id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists login_events_account_id_created_at_idx
  on login_events (account_id, created_at desc);
