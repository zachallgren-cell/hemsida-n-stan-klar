-- Synthetic PostgreSQL integration checks. Caller wraps migration + this file in BEGIN/ROLLBACK.
create temporary table mkt03_checks(name text primary key,passed boolean) on commit drop;
select set_config('request.jwt.claims',(select jsonb_build_object('sub',a.user_id,'aal','aal2')::text from public.admin_users a where exists(select 1 from auth.mfa_factors f where f.user_id=a.user_id and f.status='verified') limit 1),true);
insert into public.bookings(id,customer_name,email,phone,booking_date,booking_time,status,payment_status,created_at,email_confirmed_at,price_before_rut,labor_cost_before_rut,material_cost,transport_cost,utm_source,utm_medium,utm_campaign,customer_source_answer,tracking_consent) overriding system value
values(-930001,'TEST MKT03 ROLLBACK','test-mkt03-a@example.invalid','0700000000','2020-01-01','10:00','confirmed','unpaid','2050-01-05T10:00:00Z',now(),5000,4800,200,0,'facebook','paid_social','TEST-var2050','instagram',true);
insert into public.bookings(id,customer_name,email,phone,booking_date,booking_time,status,payment_status,created_at,email_confirmed_at,price_before_rut,referrer_host,tracking_consent) overriding system value
values(-930002,'TEST MKT03 ROLLBACK','test-mkt03-b@example.invalid','0700000000','2020-01-02','10:00','confirmed','unpaid','2050-01-06T10:00:00Z',now(),2500,'www.google.com',true);
set local role authenticated;
do $check$ declare r jsonb; e jsonb; begin
 r:=public.marketing_report('2050-01-01','2050-01-31');
 if (r->>'bookings')::int<>2 or (r->>'revenue_ex_vat')::numeric<>6000 then raise exception 'report totals failed: %',r; end if;
 r:=public.marketing_booking(-930001);
 if r->>'source'<>'facebook' or r->>'traffic'<>'Betald' then raise exception 'UTM precedence failed'; end if;
 r:=public.marketing_booking(-930002);
 if r->>'source'<>'google' or r->>'traffic'<>'Betald/organisk okänd' then raise exception 'referrer classification failed'; end if;
 e:=public.marketing_save(null,0,null,'TEST inquiry','tiktok','TEST-flyer2050','phone','TEST customer statement');
 r:=public.marketing_report('2050-01-01','2050-01-31');if (r->>'bookings')::int<>2 then raise exception 'inquiry counted as booking'; end if;
 e:=public.marketing_save((e->>'id')::uuid,(e->>'revision')::int,-930001,'TEST inquiry','tiktok','TEST-flyer2050','phone','TEST became booking');
 r:=public.marketing_booking(-930001);if r->>'source'<>'tiktok' or r->>'route'<>'phone' then raise exception 'manual source transfer failed'; end if;
 r:=public.marketing_list(-930001);if jsonb_array_length(r->'audit')<>2 then raise exception 'audit trail failed'; end if;
 begin
  perform public.marketing_save((e->>'id')::uuid,1,-930001,'TEST','facebook',null,'phone','TEST stale revision');
  raise exception 'stale revision was accepted';
 exception when serialization_failure then null; end;
 begin perform 1 from public.marketing_audit;raise exception 'direct table read accepted';exception when insufficient_privilege then null;end;
end $check$;
reset role;
insert into mkt03_checks values('real admin AAL2: report, UTM/referrer, manual request/link, audit, revision guard and direct-table denial',true);
update public.bookings set price_before_rut=6250,booking_date='2020-01-03' where id=-930001;
update public.bookings set status='cancelled' where id=-930002;
set local role authenticated;
do $check$ declare r jsonb;begin
 r:=public.marketing_report('2050-01-01','2050-01-31');
 if (r->>'bookings')::int<>1 or (r->>'revenue_ex_vat')::numeric<>5000 then raise exception 'cancellation/reprice/reschedule failed: %',r; end if;
end $check$;
reset role;
insert into mkt03_checks values('actual database: cancellation, price update and reschedule keep one job and correct value incl RUT',true);
-- Both missing AAL and explicit AAL1 must fail even for an existing allowlisted admin.
select set_config('request.jwt.claims',(current_setting('request.jwt.claims')::jsonb-'aal')::text,true);
set local role authenticated;
do $check$ begin
 begin perform public.marketing_report('2050-01-01','2050-01-31');raise exception 'missing AAL accepted';exception when insufficient_privilege then null;end;
 begin perform public.marketing_save(null,0,null,'TEST','google',null,'phone','TEST denied');raise exception 'write without AAL accepted';exception when insufficient_privilege then null;end;
end $check$;
reset role;
select set_config('request.jwt.claims',jsonb_set(current_setting('request.jwt.claims')::jsonb,'{aal}','"aal1"')::text,true);
set local role authenticated;
do $check$ begin begin perform public.marketing_booking(-930001);raise exception 'AAL1 accepted';exception when insufficient_privilege then null;end;end $check$;
reset role;
insert into mkt03_checks values('existing admin without AAL and with AAL1 denied',true);
select set_config('request.jwt.claims','{"sub":"00000000-0000-4000-8000-000000000099","aal":"aal2"}',true);
set local role authenticated;
do $check$ begin
 begin perform public.marketing_list();raise exception 'non-admin accepted';exception when insufficient_privilege then null;end;
 begin perform public.marketing_save(null,0,null,'TEST','google',null,'phone','TEST denied');raise exception 'non-admin write accepted';exception when insufficient_privilege then null;end;
end $check$;
reset role;
insert into mkt03_checks values('non-admin AAL2 denied read and write',true);
select set_config('request.jwt.claims','{}',true);
set local role anon;
do $check$ begin
 begin perform public.marketing_report('2050-01-01','2050-01-31');raise exception 'anon RPC accepted';exception when insufficient_privilege then null;end;
 begin perform 1 from public.marketing_entries;raise exception 'anon table read accepted';exception when insufficient_privilege then null;end;
end $check$;
reset role;
insert into mkt03_checks values('anon denied RPC and source-table access',true);
-- Trigger test uses a cancelled invitation: no slot is reserved, no email is sent.
insert into public.spring_2027_reservations(id,request_id,name,email,phone,location,requested_period,service_interest,status,utm_source,utm_campaign,customer_source_answer)
values('00000000-0000-4000-8000-000000093001','00000000-0000-4000-8000-000000093002','TEST MKT03 ROLLBACK','test-mkt03-c@example.invalid','0700000000','TEST only','flexible','unsure','paxed','instagram','TEST-pax2050','recommendation');
insert into public.booking_invitations(id,email,booking_date,token_hash,status,expires_at,spring_reservation_id) overriding system value
values(-930001,'test-mkt03-c@example.invalid','2020-01-04',repeat('a',64),'cancelled',now()+interval '1 day','00000000-0000-4000-8000-000000093001');
insert into public.bookings(id,customer_name,email,phone,booking_date,booking_time,status,payment_status,created_at) overriding system value
values(-930003,'TEST MKT03 ROLLBACK','test-mkt03-c@example.invalid','0700000000','2020-01-04','10:00','awaiting_confirmation','unpaid','2050-01-07T10:00:00Z');
update public.booking_invitations set booking_id='-930003' where id=-930001;
do $check$ begin
 if not exists(select 1 from public.bookings where id=-930003 and utm_source='instagram' and utm_campaign='TEST-pax2050' and customer_source_answer='recommendation') then raise exception 'spring request transfer failed';end if;
 if not exists(select 1 from public.bookings where id=-930001 and utm_source='facebook' and customer_source_answer='instagram') then raise exception 'original attribution was overwritten';end if;
end $check$;
insert into mkt03_checks values('spring request trigger transfers source while original booking attribution remains unchanged',true);
select jsonb_agg(jsonb_build_object('check',name,'passed',passed) order by name) as mkt03_verification from mkt03_checks;
