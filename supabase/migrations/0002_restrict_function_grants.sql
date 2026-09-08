-- Tighten EXECUTE grants on the SECURITY DEFINER functions from 0001.
-- Supabase exposes every function in `public` at /rest/v1/rpc/<name>, so the
-- default "grant to PUBLIC" made all three callable by anonymous visitors.

-- handle_new_user() is a trigger function: nothing should call it over the API.
revoke all on function public.handle_new_user() from public, anon, authenticated;

-- The RLS helpers must stay callable by `authenticated`: RLS policy expressions
-- are evaluated with the querying role's privileges, so revoking EXECUTE here
-- would make every policy that calls them fail. Anonymous callers have no
-- auth.uid(), so they have no reason to reach them.
revoke all on function public.current_role_name() from public, anon;
revoke all on function public.current_group_name() from public, anon;

grant execute on function public.current_role_name() to authenticated;
grant execute on function public.current_group_name() to authenticated;
