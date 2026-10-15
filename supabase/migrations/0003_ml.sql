-- ═══════════════════════════════════════════════════════════════════════
-- NEXUS × Supabase — migration 0003 · model registry & training runs
-- ═══════════════════════════════════════════════════════════════════════

-- ── model_versions: registry, artifacts, metrics, deployment status ────────────────
create table if not exists model_versions (
  id              text primary key,                       -- e.g. 'nexus-wf-20261014-001'
  kind            text not null default 'strategy-weights',
  artifact_bucket text not null default 'models',         -- Supabase Storage (private)
  artifact_path   text not null,                          -- e.g. artifacts/<id>.json
  artifact_sha256 text not null check (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_bytes  bigint,
  artifact_payload jsonb,                                 -- verified mirror for read-only consumers (weights are small)
  status          text not null default 'shadow' check (status in ('shadow','candidate','deployed','retired','rolled_back')),
  is_deployed     boolean not null default false,
  metrics         jsonb not null default '{}'::jsonb,     -- walk-forward / holdout / replay metrics
  trained_at      timestamptz,
  promoted_at     timestamptz,
  retired_at      timestamptz,
  notes           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
drop trigger if exists trg_model_versions_updated on model_versions;
create trigger trg_model_versions_updated before update on model_versions
  for each row execute function set_updated_at();

-- exactly one deployed model per kind
create unique index if not exists one_deployed_model on model_versions (kind) where is_deployed;

-- late FK from predictions (table created in 0002)
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'predictions_model_version_fkey'
  ) then
    alter table predictions
      add constraint predictions_model_version_fkey
      foreign key (model_version) references model_versions(id) on delete set null;
  end if;
end $$;

-- ── training_runs: status, dataset window, metrics, decisions, errors ──────────────
create table if not exists training_runs (
  id                    uuid primary key default gen_random_uuid(),
  model_version_id      text references model_versions(id) on delete set null,
  status                text not null default 'pending'
                          check (status in ('pending','running','succeeded','failed','rejected')),
  started_at            timestamptz,
  finished_at           timestamptz,
  dataset_window_start  timestamptz not null,
  dataset_window_end    timestamptz not null,
  dataset_feature_version text not null,
  dataset_sha256        text,
  dataset_rows          int not null default 0 check (dataset_rows >= 0),
  train_rows            int not null default 0,
  validation_rows       int not null default 0,
  holdout_rows          int not null default 0,
  metrics               jsonb not null default '{}'::jsonb,
  baseline_metrics      jsonb not null default '{}'::jsonb,   -- deployed model + simple baseline comparison
  decision              text check (decision in ('promoted','kept_previous','rejected','shadow')),
  error                 text,
  created_at            timestamptz not null default now()
);
create index if not exists idx_training_runs_started on training_runs (started_at desc);
