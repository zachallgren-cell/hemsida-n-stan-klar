-- Explicit demo seed; run manually in a local/dev database only.
do $$
declare e uuid; p uuid; i integer;
begin
  insert into public.puts_gp_events (name, event_date, status)
  values ('BERGA PUTS-GP – demo', current_date, 'running') returning id into e;
  for i in 1..15 loop
    insert into public.puts_gp_participants (event_id, full_name, public_display_name, phone_number, birth_year, public_name_consent, terms_consent_at)
    values (e, 'Testperson ' || i, 'Testperson ' || i, '070000' || lpad(i::text, 4, '0'), 1950 + i, true, now()) returning id into p;
    insert into public.puts_gp_attempts (event_id, participant_id, raw_time_ms, penalty_ms, status, published_at)
    values (e, p, 25000 + i * 1137, (i % 4) * 1000, 'published', now() - (16-i) * interval '1 minute');
  end loop;
end $$;
