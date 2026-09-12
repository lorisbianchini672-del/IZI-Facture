-- ============================================================
-- IZI — Schéma de base de données (projet Supabase)
-- À exécuter une seule fois dans : Supabase Dashboard → SQL Editor
-- ============================================================
-- Sécurité : la clé de service (SUPABASE_SERVICE_ROLE_KEY) est
-- utilisée côté serveur UNIQUEMENT et contourne la RLS.
-- L'isolation par utilisateur est garantie dans db.js, et la RLS
-- (activée sans politique) empêche TOUT accès de la clé "anon".
-- ============================================================

-- Identifiants UUID générés côté Supabase
create extension if not exists "pgcrypto";

-- Utilisateurs (compte IZI, mot de passe haché côté serveur)
create table if not exists public.profiles (
  id uuid primary key,
  email text unique not null,
  name text not null default '',
  password_hash text not null,
  created_at timestamptz not null default now()
);

-- Sessions de connexion (token haché en SHA-256)
create table if not exists public.sessions (
  token_hash text primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_user_idx on public.sessions(user_id);

-- Factures et devis (JSON complet)
create table if not exists public.invoices (
  id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  data jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists invoices_user_idx on public.invoices(user_id);

-- Paramètres entreprise (un par utilisateur)
create table if not exists public.settings (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  data jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- Commandes d'abonnement (Stripe / admin)
create table if not exists public.orders (
  id text primary key,
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);

-- RLS : activée, sans politique → refus total pour les clés publiques.
-- La clé "service_role" (serveur) contourne la RLS.
alter table public.profiles enable row level security;
alter table public.sessions enable row level security;
alter table public.invoices enable row level security;
alter table public.settings enable row level security;
alter table public.orders enable row level security;

-- Droits explicites pour la clé de service (server-side only)
grant select, insert, update, delete on public.profiles, public.sessions, public.invoices, public.settings, public.orders to service_role;
