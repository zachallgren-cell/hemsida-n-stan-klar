import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import {APPLICATION_LABELS} from '../../job-application-shared.mjs';
export const adminId='10000000-0000-4000-8000-000000000001';
export const martinId='10000000-0000-4000-8000-000000000002';
export const outsiderId='10000000-0000-4000-8000-000000000003';
export const candidateId='20000000-0000-4000-8000-000000000001';
export const answers=Object.fromEntries(Object.keys(APPLICATION_LABELS).map(key => [key,`TEST ${key}`]));
answers.name='TEST – Kandidat Åsa <script>';answers.email='test@example.invalid';answers.phone='0700000000';
Object.assign(answers,{adult:'Ja',license:'Ja',weekends:'Ja',minimumHours:'Ja',extraShifts:'Kanske',extension:'Kanske',car:'Nej'});
export async function database() {
 const db=new PGlite();
 await db.exec(`create role anon; create role authenticated; create role service_role;
 create schema auth; create schema private;
 create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
 create table auth.mfa_factors(user_id uuid, status text);
 create table public.admin_users(user_id uuid primary key, created_at timestamptz default now());
 create table public.staff_profiles(user_id uuid primary key,display_name text);
 create function auth.uid() returns uuid language sql stable as $$select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
 `);
 await db.exec(`create function auth.jwt() returns jsonb language sql stable as $$select nullif(current_setting('request.jwt.claims',true),'')::jsonb$$;
 grant usage on schema public,auth,private to authenticated,anon;
 grant execute on function auth.uid(),auth.jwt() to authenticated,anon;
 insert into auth.users values ('${adminId}','zacke@example.invalid','{}'),('${martinId}','martin@example.invalid','{}'),('${outsiderId}','outsider@example.invalid','{}');
 insert into public.admin_users(user_id) values ('${adminId}'),('${martinId}');
 insert into auth.mfa_factors values ('${adminId}','verified'),('${martinId}','verified');`);
 const helper=(await readFile(new URL('../../supabase/migrations/20260715020000_finalize_rut_security.sql',import.meta.url),'utf8')).split('-- Do not leave')[0];
 await db.exec(helper);
 await db.exec(await readFile(new URL('../../supabase/migrations/20261004000000_add_job_applications.sql',import.meta.url),'utf8'));
 await db.query('insert into public.job_applications(id,request_id,answers) values ($1,$2,$3)',[candidateId,crypto.randomUUID(),JSON.stringify(answers)]);
 await db.exec(await readFile(new URL('../../supabase/migrations/20261027163536_rek03_application_follow_up.sql',import.meta.url),'utf8'));
 return db;
}
export async function asRole(db,role,id,aal,callback) {
 await db.exec('begin');
 try {
  await db.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:id,aal})]);
  await db.exec(`set local role ${role}`);
  const result=await callback();await db.exec('commit');return result;
 } catch(error) {await db.exec('rollback');throw error;}
}
export const save=(db,revision=1,changes={}) => db.query(`select * from public.recruitment_save_application($1,$2,$3,$4,$5,$6,$7)`,[candidateId,revision,changes.status ?? 'Intervju',changes.responsible ?? 'Martin',changes.next_step ?? 'TEST Ring och boka intervju',changes.follow_up_date ?? '2027-03-01',changes.internal_notes ?? 'TEST Intern anteckning']);
