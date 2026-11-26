-- =====================================================================
-- Fangbuch Lerchenberg-Teich.de – Supabase-Schema
-- Einmalig im Supabase-Dashboard unter "SQL Editor" ausführen.
-- Ersetzt server.py: Regeln, Festschreibung und Rechte laufen in der Datenbank.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------- Tabellen
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  first_name  text not null check (char_length(first_name) between 1 and 60),
  last_name   text not null check (char_length(last_name) between 2 and 60),
  group_id    text not null check (group_id ~ '^[A-Za-z0-9ÄÖÜäöüß./_ -]{1,32}$'),
  is_admin    boolean not null default false,
  approved    boolean not null default false,   -- Freischaltung durch einen Admin
  created_at  timestamptz not null default now()
);

create table public.species (
  id        int generated always as identity primary key,
  slug      text not null unique,
  name      text not null,
  aliases   text not null default '',
  min_cm    numeric(5,1) check (min_cm between 1 and 300),
  max_cm    numeric(5,1) check (max_cm between 1 and 300),
  image     text not null,
  is_other  boolean not null default false,
  check (min_cm is null or max_cm is null or min_cm <= max_cm)
);

create table public.catches (
  id             bigint generated always as identity primary key,
  catch_date     date not null,
  species_id     int  not null references public.species(id),
  species_name   text not null,
  length_cm      numeric(5,1) not null check (length_cm between 1 and 300),
  min_cm_at      numeric(5,1),
  max_cm_at      numeric(5,1),
  size_status    text not null check (size_status in ('ok','under','over')),
  angler_user_id uuid references auth.users(id),
  angler_name    text not null,
  entered_by     uuid not null references auth.users(id),
  entered_at     timestamptz not null default now(),
  added_by_admin boolean not null default false,
  fate           text not null check (fate in ('taken','released')),
  health         text not null default 'none' check (health in ('none','disease','injury')),
  remark         text not null default ''
);
create index idx_catches_date on public.catches(catch_date);

-- ---------------------------------------------------------------- Fänge sind festgeschrieben
create or replace function public.catches_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'Fänge sind festgeschrieben und können nicht geändert oder gelöscht werden';
end $$;

create trigger catches_no_update before update on public.catches
  for each row execute function public.catches_immutable();
create trigger catches_no_delete before delete on public.catches
  for each row execute function public.catches_immutable();
create trigger catches_no_truncate before truncate on public.catches
  for each statement execute function public.catches_immutable();

-- ---------------------------------------------------------------- Rechte (Row Level Security)
alter table public.profiles enable row level security;
alter table public.species  enable row level security;
alter table public.catches  enable row level security;

revoke all on public.profiles, public.species, public.catches from anon, authenticated;
grant select on public.profiles, public.species, public.catches to authenticated;

create or replace function public.current_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin and approved from public.profiles where id = auth.uid()), false)
$$;

create or replace function public.current_is_approved() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select approved from public.profiles where id = auth.uid()), false)
$$;

-- Eigenes Profil ist immer lesbar (für die Anzeige "Freischaltung ausstehend").
-- Fischarten und Fänge sehen nur von einem Admin freigeschaltete Mitglieder.
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.current_is_admin());
create policy species_select on public.species for select to authenticated using (public.current_is_approved());
create policy catches_select on public.catches for select to authenticated using (public.current_is_approved());
-- Es gibt bewusst KEINE insert/update/delete-Policies: Schreiben geht nur über die Funktionen unten.

-- ---------------------------------------------------------------- Profil bei Registrierung anlegen
-- Der erste registrierte Benutzer wird automatisch Admin (und ist freigeschaltet).
-- Alle weiteren Profile müssen von einem Admin freigeschaltet werden.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_first text := left(regexp_replace(btrim(coalesce(new.raw_user_meta_data->>'first_name','')), '\s+', ' ', 'g'), 60);
  v_last  text := left(regexp_replace(btrim(coalesce(new.raw_user_meta_data->>'last_name','')),  '\s+', ' ', 'g'), 60);
  v_gid   text := left(btrim(coalesce(new.raw_user_meta_data->>'group_id','')), 32);
  v_first_user boolean;
begin
  lock table public.profiles in share row exclusive mode;
  select not exists (select 1 from public.profiles) into v_first_user;
  insert into public.profiles(id, first_name, last_name, group_id, is_admin, approved)
  values (new.id, v_first, v_last, v_gid, v_first_user, v_first_user);
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- Fang eintragen (interne Prüfung)
create or replace function public._insert_catch(
  p_date date, p_species int, p_other text, p_length numeric,
  p_angler_user uuid, p_angler_name text, p_entered_by uuid, p_by_admin boolean,
  p_fate text, p_health text, p_remark text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  s        public.species;
  v_len    numeric(5,1);
  v_name   text;
  v_other  text;
  v_status text;
  v_health text := coalesce(p_health, 'none');
  v_remark text := left(btrim(regexp_replace(coalesce(p_remark,''), '\s+', ' ', 'g')), 300);
begin
  if p_date is null then raise exception 'Bitte ein gültiges Fangdatum angeben.'; end if;
  if extract(year from p_date) < 1990 then raise exception 'Das Fangdatum ist unplausibel.'; end if;
  if p_date > (now() at time zone 'Europe/Berlin')::date then
    raise exception 'Das Fangdatum darf nicht in der Zukunft liegen.';
  end if;
  if p_length is null or p_length < 1 or p_length > 300 then
    raise exception 'Die Länge muss zwischen 1 und 300 cm liegen.';
  end if;
  v_len := round(p_length, 1);
  if p_fate is null or p_fate not in ('taken','released') then
    raise exception 'Bitte angeben, ob der Fisch entnommen oder zurückgesetzt wurde.';
  end if;
  if v_health not in ('none','disease','injury') then
    raise exception 'Ungültige Angabe zum Zustand des Fisches.';
  end if;

  select * into s from public.species where id = p_species;
  if not found then raise exception 'Bitte eine Fischart auswählen.'; end if;
  v_name := s.name;
  if s.is_other then
    v_other := left(btrim(regexp_replace(coalesce(p_other,''), '\s+', ' ', 'g')), 60);
    if char_length(v_other) < 2 then raise exception 'Bitte bei „Sonstige“ die Fischart eintragen.'; end if;
    v_name := 'Sonstige: ' || v_other;
  end if;

  v_status := case
    when s.min_cm is not null and v_len < s.min_cm then 'under'
    when s.max_cm is not null and v_len > s.max_cm then 'over'
    else 'ok' end;

  if p_fate = 'taken' and v_status <> 'ok' then
    if v_health = 'none' then
      raise exception 'Wird ein nicht maßiger Fisch entnommen, muss Krankheit oder Verletzung ausgewählt werden.';
    end if;
    if char_length(v_remark) < 3 then
      raise exception 'Bitte eine Bemerkung eintragen (Pflicht bei Entnahme eines nicht maßigen Fisches).';
    end if;
  elsif v_health <> 'none' and char_length(v_remark) < 3 then
    raise exception 'Bitte eine Bemerkung zu Krankheit oder Verletzung eintragen.';
  end if;

  insert into public.catches(catch_date, species_id, species_name, length_cm, min_cm_at, max_cm_at, size_status,
                             angler_user_id, angler_name, entered_by, added_by_admin, fate, health, remark)
  values (p_date, s.id, v_name, v_len, s.min_cm, s.max_cm, v_status,
          p_angler_user, p_angler_name, p_entered_by, p_by_admin, p_fate, v_health, v_remark);
end $$;

create or replace function public._angler_label(p_first text, p_last text) returns text
language sql immutable as $$
  select upper(left(btrim(p_first), 1)) || '. ' || btrim(p_last)
$$;

-- Eigener Fang
create or replace function public.add_catch(
  p_date date, p_species_id int, p_species_other text, p_length numeric,
  p_fate text, p_health text, p_remark text, p_confirmed boolean
) returns void
language plpgsql security definer set search_path = public as $$
declare pr public.profiles;
begin
  select * into pr from public.profiles where id = auth.uid();
  if not found then raise exception 'Bitte anmelden.'; end if;
  if not pr.approved then raise exception 'Dein Profil ist noch nicht von einem Admin freigeschaltet.'; end if;
  if p_confirmed is not true then raise exception 'Bitte die Eintragung zuerst bestätigen.'; end if;
  perform public._insert_catch(p_date, p_species_id, p_species_other, p_length, pr.id,
            public._angler_label(pr.first_name, pr.last_name), pr.id, false, p_fate, p_health, p_remark);
end $$;

-- Nachtrag durch Admin (Mitglied oder nicht registrierte Person)
create or replace function public.admin_add_catch(
  p_date date, p_species_id int, p_species_other text, p_length numeric,
  p_angler_user uuid, p_angler_name text,
  p_fate text, p_health text, p_remark text, p_confirmed boolean
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_label text; v_uid uuid; r public.profiles; v_name text; m text[];
begin
  if not public.current_is_admin() then raise exception 'Nur für Administratoren.'; end if;
  if p_confirmed is not true then raise exception 'Bitte die Eintragung zuerst bestätigen.'; end if;
  if p_angler_user is not null then
    select * into r from public.profiles where id = p_angler_user;
    if not found then raise exception 'Angler nicht gefunden.'; end if;
    v_label := public._angler_label(r.first_name, r.last_name);
    v_uid := r.id;
  else
    v_name := left(btrim(regexp_replace(coalesce(p_angler_name,''), '\s+', ' ', 'g')), 80);
    m := regexp_match(v_name, '^(\S+)\s+(.+)$');
    if m is null then raise exception 'Bitte Vor- und Nachnamen des Anglers angeben.'; end if;
    v_label := public._angler_label(m[1], m[2]);
    v_uid := null;
  end if;
  perform public._insert_catch(p_date, p_species_id, p_species_other, p_length, v_uid, v_label,
            auth.uid(), true, p_fate, p_health, p_remark);
end $$;

-- ---------------------------------------------------------------- Admin-Funktionen
create or replace function public.admin_list_users()
returns table(id uuid, first_name text, last_name text, email text, group_id text, is_admin boolean, verified boolean, approved boolean)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.current_is_admin() then raise exception 'Nur für Administratoren.'; end if;
  return query
    select p.id, p.first_name, p.last_name, u.email::text, p.group_id, p.is_admin,
           (u.email_confirmed_at is not null), p.approved
    from public.profiles p join auth.users u on u.id = p.id
    order by lower(p.last_name), lower(p.first_name);
end $$;

create or replace function public.admin_set_admin(p_user uuid, p_admin boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.current_is_admin() then raise exception 'Nur für Administratoren.'; end if;
  if p_user = auth.uid() then raise exception 'Du kannst dir die eigene Admin-Rolle nicht entziehen.'; end if;
  -- Wer Admin wird, ist automatisch auch freigeschaltet.
  update public.profiles set is_admin = (p_admin is true), approved = approved or (p_admin is true) where id = p_user;
  if not found then raise exception 'Benutzer nicht gefunden.'; end if;
end $$;

-- Neuanmeldung freischalten bzw. Mitglied sperren
create or replace function public.admin_set_approved(p_user uuid, p_approved boolean) returns void
language plpgsql security definer set search_path = public as $$
declare r public.profiles;
begin
  if not public.current_is_admin() then raise exception 'Nur für Administratoren.'; end if;
  if p_user = auth.uid() then raise exception 'Du kannst dein eigenes Profil nicht sperren.'; end if;
  select * into r from public.profiles where id = p_user;
  if not found then raise exception 'Benutzer nicht gefunden.'; end if;
  if r.is_admin and p_approved is not true then raise exception 'Bitte zuerst die Admin-Rolle entziehen.'; end if;
  update public.profiles set approved = (p_approved is true) where id = p_user;
end $$;

create or replace function public.admin_verify_user(p_user uuid) returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.current_is_admin() then raise exception 'Nur für Administratoren.'; end if;
  update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = p_user;
  if not found then raise exception 'Benutzer nicht gefunden.'; end if;
end $$;

-- Passwort eines Mitglieds setzen (beendet dessen Sitzungen).
create or replace function public.admin_set_password(p_user uuid, p_password text) returns void
language plpgsql security definer set search_path = public, auth, extensions as $$
begin
  if not public.current_is_admin() then raise exception 'Nur für Administratoren.'; end if;
  if p_password is null or char_length(p_password) < 8 or char_length(p_password) > 200 then
    raise exception 'Das Passwort muss mindestens 8 Zeichen lang sein.';
  end if;
  update auth.users
     set encrypted_password = extensions.crypt(p_password, extensions.gen_salt('bf')),
         email_confirmed_at = coalesce(email_confirmed_at, now()),
         updated_at = now()
   where id = p_user;
  if not found then raise exception 'Benutzer nicht gefunden.'; end if;
  delete from auth.sessions where user_id = p_user;
end $$;

create or replace function public.admin_set_limits(p_species int, p_min numeric, p_max numeric) returns void
language plpgsql security definer set search_path = public as $$
declare s public.species;
begin
  if not public.current_is_admin() then raise exception 'Nur für Administratoren.'; end if;
  if (p_min is not null and (p_min < 1 or p_min > 300)) or (p_max is not null and (p_max < 1 or p_max > 300)) then
    raise exception 'Die Länge muss zwischen 1 und 300 cm liegen.';
  end if;
  if p_min is not null and p_max is not null and p_min > p_max then
    raise exception 'Das Mindestmaß darf nicht größer als das Höchstmaß sein.';
  end if;
  select * into s from public.species where id = p_species;
  if not found then raise exception 'Bitte eine Fischart auswählen.'; end if;
  if s.is_other then raise exception 'Für „Sonstige“ gibt es keine Maße.'; end if;
  update public.species set min_cm = round(p_min,1), max_cm = round(p_max,1) where id = p_species;
end $$;

create or replace function public.admin_summary(p_year int, p_month int default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  a date; b date; v_rows jsonb; v_pm jsonb; v_years jsonb;
begin
  if not public.current_is_admin() then raise exception 'Nur für Administratoren.'; end if;
  if p_year is null or p_year < 1990 or p_year > 2100 or (p_month is not null and p_month not between 1 and 12) then
    raise exception 'Ungültige Angabe.';
  end if;
  if p_month is null then
    a := make_date(p_year, 1, 1); b := (a + interval '1 year')::date;
  else
    a := make_date(p_year, p_month, 1); b := (a + interval '1 month')::date;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'species', species_name, 'count', n, 'under', under_n, 'over', over_n,
           'taken', taken_n, 'released', rel_n, 'sick', sick_n, 'min', lmin, 'max', lmax, 'avg', lavg)
         order by lower(species_name)), '[]'::jsonb)
    into v_rows
    from (select species_name, count(*) n,
                 count(*) filter (where size_status = 'under') under_n,
                 count(*) filter (where size_status = 'over')  over_n,
                 count(*) filter (where fate = 'taken')        taken_n,
                 count(*) filter (where fate = 'released')     rel_n,
                 count(*) filter (where health <> 'none')      sick_n,
                 min(length_cm) lmin, max(length_cm) lmax, round(avg(length_cm), 1) lavg
            from public.catches where catch_date >= a and catch_date < b
           group by species_name) t;

  select coalesce(jsonb_agg(jsonb_build_object('month', mo, 'species', species_name, 'count', n)), '[]'::jsonb)
    into v_pm
    from (select extract(month from catch_date)::int mo, species_name, count(*) n
            from public.catches
           where catch_date >= make_date(p_year,1,1) and catch_date < make_date(p_year+1,1,1)
           group by 1, 2) t;

  select coalesce(jsonb_agg(y order by y desc), '[]'::jsonb) into v_years
    from (select distinct extract(year from catch_date)::int y from public.catches) t;

  return jsonb_build_object('year', p_year, 'month', p_month, 'years', v_years, 'rows', v_rows, 'per_month', v_pm);
end $$;

-- Öffentlicher Mini-Aufruf, damit ein wöchentlicher Ping das Projekt aktiv hält (siehe README)
create or replace function public.ping() returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.species
$$;

-- ---------------------------------------------------------------- Funktionsrechte
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.current_is_admin() to authenticated;
grant execute on function public.current_is_approved() to authenticated;
grant execute on function public.admin_set_approved(uuid,boolean) to authenticated;
grant execute on function public.add_catch(date,int,text,numeric,text,text,text,boolean) to authenticated;
grant execute on function public.admin_add_catch(date,int,text,numeric,uuid,text,text,text,text,boolean) to authenticated;
grant execute on function public.admin_list_users() to authenticated;
grant execute on function public.admin_set_admin(uuid,boolean) to authenticated;
grant execute on function public.admin_verify_user(uuid) to authenticated;
grant execute on function public.admin_set_password(uuid,text) to authenticated;
grant execute on function public.admin_set_limits(int,numeric,numeric) to authenticated;
grant execute on function public.admin_summary(int,int) to authenticated;
grant execute on function public.ping() to anon, authenticated;

-- ---------------------------------------------------------------- Fischarten (Mindestmaße RLP, bitte prüfen!)
insert into public.species(slug, name, aliases, min_cm, max_cm, image, is_other) values
 ('aal','Aal','Flussaal',50,null,'fish/aal.jpg',false),
 ('bachsaibling','Bachsaibling','Saibling',null,null,'fish/bachsaibling.jpg',false),
 ('brasse','Brasse','Brassen, Blei, Brachse',null,null,'fish/brasse.jpg',false),
 ('flussbarsch','Flussbarsch','Barsch, Egli, Kretzer',null,null,'fish/flussbarsch.jpg',false),
 ('forelle','Forelle','Bachforelle, Seeforelle',25,null,'fish/forelle.jpg',false),
 ('giebel','Giebel','Silberkarausche',null,null,'fish/giebel.jpg',false),
 ('goldforelle','Goldforelle','',null,null,'fish/goldforelle.jpg',false),
 ('gruendling','Gründling','Gressling',null,null,'fish/gruendling.jpg',false),
 ('hecht','Hecht','Esox',50,null,'fish/hecht.jpg',false),
 ('karausche','Karausche','Moorkarpfen',null,null,'fish/karausche.jpg',false),
 ('lachsforelle','Lachsforelle','',null,null,'fish/lachsforelle.jpg',false),
 ('lederkarpfen','Lederkarpfen','Karpfen',35,null,'fish/lederkarpfen.jpg',false),
 ('moderlieschen','Moderlieschen','',null,null,'fish/moderlieschen.jpg',false),
 ('nase','Nase','Näsling',30,null,'fish/nase.jpg',false),
 ('regenbogenforelle','Regenbogenforelle','',null,null,'fish/regenbogenforelle.jpg',false),
 ('rotauge','Rotauge','Plötze',15,null,'fish/rotauge.jpg',false),
 ('rotfeder','Rotfeder','',15,null,'fish/rotfeder.jpg',false),
 ('schleie','Schleie','Schlei',25,null,'fish/schleie.jpg',false),
 ('schuppenkarpfen','Schuppenkarpfen','Karpfen',35,null,'fish/schuppenkarpfen.jpg',false),
 ('schwarzmaul-grundel','Schwarzmaul-Grundel','Schwarzmeergrundel, Grundel',null,null,'fish/schwarzmaul-grundel.jpg',false),
 ('spiegelkarpfen','Spiegelkarpfen','Karpfen',35,null,'fish/spiegelkarpfen.jpg',false),
 ('stoer','Stör','Störe',null,null,'fish/stoer.jpg',false),
 ('wels','Wels','Waller, Flusswels, Schaiden',60,null,'fish/wels.jpg',false),
 ('zander','Zander','Sander, Schill',45,null,'fish/zander.jpg',false),
 ('zwergwels','Zwergwels','Katzenwels',null,null,'fish/zwergwels.jpg',false),
 ('sonstige','Sonstige','Anderer Fisch, nicht in der Liste',null,null,'fish/sonstige.svg',true);
