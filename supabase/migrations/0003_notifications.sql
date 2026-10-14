-- Rep/owner alerts (handoffs, SLA misses, daily digest). Kept apart from lead threads so an alert
-- can never land in a conversation with a lead.
create table notifications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid,
  lead_id uuid references leads(id) on delete cascade,
  channel text not null check (channel in ('sms', 'email', 'in_app')),
  kind text not null,
  to_address text,
  subject text,
  body text not null,
  status text not null default 'queued' check (status in ('queued', 'sent', 'failed', 'skipped')),
  dry_run boolean not null default false,
  error text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index on notifications (org_id, created_at desc);
alter table notifications enable row level security;
create policy notifications_select on notifications for select to authenticated using (app.is_member(org_id) and (user_id is null or user_id = auth.uid() or app.is_org_admin(org_id)));
create policy notifications_read on notifications for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
grant select, insert, update, delete on notifications to authenticated, service_role;
