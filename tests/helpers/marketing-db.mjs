import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
export const admin='10000000-0000-4000-8000-000000000001', outsider='10000000-0000-4000-8000-000000000002';
export async function marketingDatabase(){
 const db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create schema auth;create schema private;
 create table auth.users(id uuid primary key);insert into auth.users values('${admin}'),('${outsider}');
 create table auth.mfa_factors(user_id uuid,status text);insert into auth.mfa_factors values('${admin}','verified');
 create table public.admin_users(user_id uuid primary key);insert into admin_users values('${admin}');
 create function auth.uid() returns uuid language sql stable as $$select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
 create function auth.jwt() returns jsonb language sql stable as $$select nullif(current_setting('request.jwt.claims',true),'')::jsonb$$;
 grant usage on schema public,auth,private to anon,authenticated,service_role;
 create table public.bookings(id bigint primary key,email text,status text,created_at timestamptz default now(),email_confirmed_at timestamptz,booking_date date,price_before_rut numeric,labor_cost_before_rut numeric,material_cost numeric,transport_cost numeric,utm_source text,utm_medium text,utm_campaign text,utm_content text,utm_term text,attribution_ref text);
 create table public.spring_2027_reservations(id uuid primary key,utm_source text,utm_medium text,utm_campaign text,utm_content text,utm_term text,attribution_ref text);
 create table public.booking_invitations(id bigint primary key,spring_reservation_id uuid,booking_id text);
 alter table public.bookings enable row level security;
 `);
 await db.exec((await readFile(new URL('../../supabase/migrations/20260715020000_finalize_rut_security.sql',import.meta.url),'utf8')).split('-- Do not leave')[0]);
 await db.exec(await readFile(new URL('../../supabase/migrations/20261102082305_mkt03_booking_attribution.sql',import.meta.url),'utf8'));
 async function as(id=admin,aal='aal2',fn,role='authenticated'){
  await db.exec('begin');try{await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:id,aal})]);await db.exec(`set local role ${role}`);const value=await fn();await db.exec('commit');return value;}catch(error){await db.exec('rollback');throw error;}
 }
 const rpc=async(name,args=[]) => (await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;
 async function insert(id,fields={}){
  const row={id,email:'test'+id+'@example.invalid',status:'confirmed',created_at:'2026-11-02T10:00:00Z',price_before_rut:2500,...fields};
  await db.query(`insert into bookings(${Object.keys(row).join(',')}) values(${Object.keys(row).map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row));
 }
 return {db,as,rpc,insert,report:()=>as(admin,'aal2',()=>rpc('marketing_report',['2026-11-01','2026-11-30']))};
}
