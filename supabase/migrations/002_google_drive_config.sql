create table if not exists google_drive_folders (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  folder_id text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into settings(key, value, description) values
('GOOGLE_DRIVE_IMAGES_FOLDER_ID', '"1Uq5u6yDCMHcDm9EF2iQBqdUITap67aRu"', '[GOOGLE_DRIVE] Pasta Imagens de destino'),
('GOOGLE_DRIVE_INTERVAL_MINUTES', '60', '[GOOGLE_DRIVE] Intervalo em minutos entre coletas automaticas')
on conflict (key) do update set
  value = excluded.value,
  description = excluded.description,
  updated_at = now();
