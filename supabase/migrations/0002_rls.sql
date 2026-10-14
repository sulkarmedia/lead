-- Row-level security. A signed-in user only sees rows for orgs they belong to.
-- Owners/admins edit everything in their org; reps see all org leads but only edit leads
-- assigned to them or unassigned. Platform admins get cross-tenant access (audited in app code).
-- The worker and webhooks connect as the table owner / service_role and bypass RLS.

create schema if not exists app;
grant usage on schema app to authenticated, anon, service_role;

create or replace function app.is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from platform_admins where user_id = auth.uid())
$$;

create or replace function app.is_member(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select app.is_platform_admin() or exists (
    select 1 from memberships m where m.org_id = p_org and m.user_id = auth.uid() and m.active
  )
$$;

create or replace function app.is_org_admin(p_org uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select app.is_platform_admin() or exists (
    select 1 from memberships m
    where m.org_id = p_org and m.user_id = auth.uid() and m.active and m.role in ('owner', 'admin')
  )
$$;

-- Can the current user edit this lead? Admins: any lead in the org. Reps: assigned to them or unassigned.
create or replace function app.can_edit_lead(p_lead uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from leads l
    where l.id = p_lead
      and (app.is_org_admin(l.org_id)
           or (app.is_member(l.org_id) and (l.assigned_user_id is null or l.assigned_user_id = auth.uid())))
  )
$$;

create or replace function app.membership_role(p_id uuid) returns member_role
language sql stable security definer set search_path = public as $$ select role from memberships where id = p_id $$;
create or replace function app.membership_active(p_id uuid) returns boolean
language sql stable security definer set search_path = public as $$ select active from memberships where id = p_id $$;

grant execute on all functions in schema app to authenticated, service_role;

grant usage on schema public to authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated, service_role;

do $$
declare t text;
begin
  foreach t in array array[
    'organizations','platform_admins','memberships','integrations','playbooks','lead_sources',
    'knowledge_items','leads','ai_runs','consent_records','messages','appointments','availability',
    'jobs','stage_events','capi_events','audit_log','do_not_contact','ad_spend_daily','platform_state'
  ] loop
    execute format('alter table %I enable row level security', t);
  end loop;
end $$;

-- RLS is enabled but not forced: the table owner (migrations, the worker and webhooks on the
-- DATABASE_URL connection) is exempt. User requests run as `authenticated` via withUserDb().

-- organizations
create policy org_select on organizations for select to authenticated using (app.is_member(id));
create policy org_update on organizations for update to authenticated using (app.is_org_admin(id)) with check (app.is_org_admin(id));
create policy org_insert on organizations for insert to authenticated with check (app.is_platform_admin());
create policy org_delete on organizations for delete to authenticated using (app.is_platform_admin());

-- platform_admins: you can see whether you are one; nothing else.
create policy pa_select on platform_admins for select to authenticated using (user_id = auth.uid());

-- memberships
create policy mem_select on memberships for select to authenticated using (app.is_member(org_id));
create policy mem_write on memberships for all to authenticated using (app.is_org_admin(org_id)) with check (app.is_org_admin(org_id));
-- a rep may update their own notification settings and mobile number, not their role
create policy mem_self_update on memberships for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and role = app.membership_role(id) and active = app.membership_active(id));

-- Admin-managed configuration tables: members read, admins write.
do $$
declare t text;
begin
  foreach t in array array['integrations','playbooks','lead_sources','knowledge_items','availability','ad_spend_daily'] loop
    execute format('create policy %I on %I for select to authenticated using (app.is_member(org_id))', t || '_select', t);
    execute format('create policy %I on %I for insert to authenticated with check (app.is_org_admin(org_id))', t || '_insert', t);
    execute format('create policy %I on %I for update to authenticated using (app.is_org_admin(org_id)) with check (app.is_org_admin(org_id))', t || '_update', t);
    execute format('create policy %I on %I for delete to authenticated using (app.is_org_admin(org_id))', t || '_delete', t);
  end loop;
end $$;
-- reps manage their own availability and their own calendar connection
create policy availability_self on availability for all to authenticated
  using (user_id = auth.uid() and app.is_member(org_id)) with check (user_id = auth.uid() and app.is_member(org_id));
create policy integrations_self on integrations for all to authenticated
  using (kind = 'google_calendar' and user_id = auth.uid() and app.is_member(org_id))
  with check (kind = 'google_calendar' and user_id = auth.uid() and app.is_member(org_id));

-- leads
create policy leads_select on leads for select to authenticated using (app.is_member(org_id));
create policy leads_insert on leads for insert to authenticated with check (app.is_member(org_id));
create policy leads_update on leads for update to authenticated
  using (app.is_org_admin(org_id) or (app.is_member(org_id) and (assigned_user_id is null or assigned_user_id = auth.uid())))
  with check (app.is_org_admin(org_id) or (app.is_member(org_id) and (assigned_user_id is null or assigned_user_id = auth.uid())));
create policy leads_delete on leads for delete to authenticated using (app.is_org_admin(org_id));

-- Lead-scoped history: members read; writes need edit rights on the lead.
do $$
declare t text;
begin
  foreach t in array array['messages','appointments','stage_events'] loop
    execute format('create policy %I on %I for select to authenticated using (app.is_member(org_id))', t || '_select', t);
    execute format('create policy %I on %I for insert to authenticated with check (app.is_member(org_id) and app.can_edit_lead(lead_id))', t || '_insert', t);
    execute format('create policy %I on %I for update to authenticated using (app.is_member(org_id) and app.can_edit_lead(lead_id)) with check (app.is_member(org_id) and app.can_edit_lead(lead_id))', t || '_update', t);
  end loop;
end $$;
create policy appointments_delete on appointments for delete to authenticated using (app.is_org_admin(org_id));

-- Read-only to users; written by the worker/webhooks only.
create policy ai_runs_select on ai_runs for select to authenticated using (app.is_member(org_id));
create policy capi_select on capi_events for select to authenticated using (app.is_member(org_id));
create policy jobs_select on jobs for select to authenticated using (app.is_org_admin(org_id));
create policy consent_select on consent_records for select to authenticated using (app.is_member(org_id));
-- consent_records: insert-only for members (manual entry with evidence); never update/delete (trigger also blocks).
create policy consent_insert on consent_records for insert to authenticated with check (app.is_member(org_id));
create policy dnc_select on do_not_contact for select to authenticated using (app.is_org_admin(org_id));

-- audit_log: members append, admins read; never edited.
create policy audit_insert on audit_log for insert to authenticated with check (org_id is null and app.is_platform_admin() or app.is_member(org_id));
create policy audit_select on audit_log for select to authenticated using (app.is_org_admin(org_id) or app.is_platform_admin());

-- platform_state: platform admins read only.
create policy platform_state_select on platform_state for select to authenticated using (app.is_platform_admin());

-- Jobs/ai_runs/capi are worker-owned: no user write policies, so writes from `authenticated` are denied.
revoke update, delete on consent_records from authenticated;
revoke update, delete on audit_log from authenticated;
