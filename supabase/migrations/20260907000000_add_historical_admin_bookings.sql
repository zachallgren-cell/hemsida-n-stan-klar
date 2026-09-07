-- Allow a two-step-verified booking admin to register work that was booked or
-- completed outside the public booking flow. The public flow remains future-only.

set local search_path = pg_catalog, public;

create or replace function public.admin_create_historical_booking(
  p_customer_name text,
  p_email text,
  p_phone text,
  p_booking_date date,
  p_booking_time time without time zone,
  p_address text,
  p_postal_code text default null,
  p_housing_type text default null,
  p_service_scope text default null,
  p_window_count integer default null,
  p_customer_price integer default null,
  p_material_cost integer default 150,
  p_transport_cost integer default 0,
  p_rut_choice text default 'without_rut',
  p_booking_state text default 'completed_unpaid',
  p_internal_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  cleaned_name text := btrim(coalesce(p_customer_name, ''));
  cleaned_email text := lower(btrim(coalesce(p_email, '')));
  cleaned_phone text := regexp_replace(btrim(coalesce(p_phone, '')), '[^0-9+]', '', 'g');
  cleaned_address text := btrim(coalesce(p_address, ''));
  cleaned_postal_code text := nullif(regexp_replace(coalesce(p_postal_code, ''), '[^0-9]', '', 'g'), '');
  cleaned_note text := nullif(btrim(coalesce(p_internal_note, '')), '');
  rut_label text;
  booking_status text;
  payment_status_value text;
  completed_at_value timestamp with time zone;
  paid_at_value timestamp with time zone;
  customer_labor_price integer;
  labor_cost_before_rut_value integer;
  rut_deduction_value integer;
  price_before_rut_value integer;
  created_booking public.bookings%rowtype;
begin
  if not private.is_booking_admin() then
    raise exception 'Tvåstegsverifierad adminbehörighet krävs.' using errcode = '42501';
  end if;

  if char_length(cleaned_name) < 2 or char_length(cleaned_name) > 100 then
    raise exception 'Ange ett giltigt kundnamn med högst 100 tecken.' using errcode = '22023';
  end if;
  if char_length(cleaned_email) > 254 or cleaned_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Ange en giltig e-postadress.' using errcode = '22023';
  end if;
  if cleaned_phone !~ '^\+?[0-9]{7,15}$' then
    raise exception 'Ange ett giltigt telefonnummer.' using errcode = '22023';
  end if;
  if char_length(cleaned_address) < 3 or char_length(cleaned_address) > 240 then
    raise exception 'Ange en giltig adress med högst 240 tecken.' using errcode = '22023';
  end if;
  if cleaned_postal_code is not null and cleaned_postal_code !~ '^[0-9]{5}$' then
    raise exception 'Postnumret ska innehålla fem siffror.' using errcode = '22023';
  end if;
  if p_booking_date is null
    or p_booking_date > (now() at time zone 'Europe/Stockholm')::date
  then
    raise exception 'Bokningsdatumet måste vara i dag eller tidigare.' using errcode = '22023';
  end if;
  if p_booking_time is null then
    raise exception 'Ange en giltig bokningstid.' using errcode = '22023';
  end if;
  if p_booking_state not in ('confirmed', 'completed_unpaid', 'completed_paid') then
    raise exception 'Välj ett giltigt läge för bokningen.' using errcode = '22023';
  end if;
  if p_customer_price is null or p_customer_price < 1 or p_customer_price > 1000000
    or p_material_cost is null or p_material_cost < 0 or p_material_cost > 1000000
    or p_transport_cost is null or p_transport_cost < 0 or p_transport_cost > 1000000
    or p_material_cost + p_transport_cost > p_customer_price
  then
    raise exception 'Kontrollera kundpris, material och transport.' using errcode = '22023';
  end if;
  if p_window_count is not null and (p_window_count < 1 or p_window_count > 250) then
    raise exception 'Antal fönster måste vara mellan 1 och 250.' using errcode = '22023';
  end if;
  if p_housing_type is not null and p_housing_type not in (
    'En våning',
    'Två våningar',
    'Lägenhet – fönstren öppnas inåt',
    'Lägenhet – fönstren öppnas utåt'
  ) then
    raise exception 'Välj en giltig bostadstyp.' using errcode = '22023';
  end if;
  if p_service_scope is not null and p_service_scope not in (
    'Endast utvändig',
    'Invändig + utvändig',
    'Fyrsidiga fönster'
  ) then
    raise exception 'Välj en giltig tjänst.' using errcode = '22023';
  end if;
  if cleaned_note is not null and char_length(cleaned_note) > 2000 then
    raise exception 'Den interna anteckningen får vara högst 2 000 tecken.' using errcode = '22023';
  end if;

  rut_label := case p_rut_choice
    when 'with_rut' then 'Ja, skicka säkert RUT-formulär via bekräftelsemejl'
    when 'without_rut' then 'Nej, jag vill inte använda RUT-avdrag'
    else null
  end;
  if rut_label is null then
    raise exception 'Välj ett giltigt RUT-alternativ.' using errcode = '22023';
  end if;

  customer_labor_price := p_customer_price - p_material_cost - p_transport_cost;
  if p_rut_choice = 'with_rut' and customer_labor_price < 1 then
    raise exception 'Kundpriset måste vara högre än material och transport för en RUT-bokning.' using errcode = '22023';
  end if;

  labor_cost_before_rut_value := case
    when p_rut_choice = 'with_rut' then customer_labor_price * 2
    else customer_labor_price
  end;
  rut_deduction_value := case
    when p_rut_choice = 'with_rut' then customer_labor_price
    else 0
  end;
  price_before_rut_value := labor_cost_before_rut_value + p_material_cost + p_transport_cost;
  booking_status := case when p_booking_state = 'confirmed' then 'confirmed' else 'completed' end;
  payment_status_value := case when p_booking_state = 'completed_paid' then 'paid' else 'unpaid' end;
  completed_at_value := case when p_booking_state like 'completed_%' then now() else null end;
  paid_at_value := case when p_booking_state = 'completed_paid' then now() else null end;

  insert into public.bookings (
    customer_name,
    email,
    phone,
    booking_date,
    booking_time,
    address,
    postal_code,
    housing_type,
    service_scope,
    window_count,
    transport_type,
    payment_method,
    price,
    original_price,
    discount_amount,
    labor_cost_before_rut,
    material_cost,
    transport_cost,
    rut_deduction,
    price_before_rut,
    customer_price_before_discount,
    rut_choice,
    rut_status,
    rut_application_status,
    internal_note,
    consent_accepted,
    status,
    email_confirmed_at,
    completed_at,
    payment_status,
    paid_at
  ) values (
    cleaned_name,
    cleaned_email,
    cleaned_phone,
    p_booking_date,
    p_booking_time,
    cleaned_address,
    cleaned_postal_code,
    nullif(p_housing_type, ''),
    nullif(p_service_scope, ''),
    p_window_count::text,
    'Fastland',
    'Swish Företag',
    p_customer_price::text,
    p_customer_price,
    0,
    labor_cost_before_rut_value,
    p_material_cost,
    p_transport_cost,
    rut_deduction_value,
    price_before_rut_value,
    p_customer_price,
    rut_label,
    case when p_rut_choice = 'with_rut' then 'Ej skickat' else 'Ej RUT' end,
    'not_ready',
    cleaned_note,
    false,
    booking_status,
    now(),
    completed_at_value,
    payment_status_value,
    paid_at_value
  )
  returning * into created_booking;

  insert into public.admin_activity_log (
    actor_user_id,
    action,
    object_type,
    object_id,
    new_value,
    metadata
  ) values (
    auth.uid(),
    'historical_booking_created',
    'booking',
    created_booking.id::text,
    jsonb_build_object(
      'booking_date', created_booking.booking_date,
      'status', created_booking.status,
      'payment_status', created_booking.payment_status
    ),
    jsonb_build_object('source', 'admin')
  );

  return jsonb_build_object(
    'success', true,
    'bookingId', created_booking.id,
    'status', created_booking.status,
    'paymentStatus', created_booking.payment_status
  );
end;
$$;

revoke all on function public.admin_create_historical_booking(
  text, text, text, date, time without time zone, text, text, text, text,
  integer, integer, integer, integer, text, text, text
) from public, anon, authenticated;

grant execute on function public.admin_create_historical_booking(
  text, text, text, date, time without time zone, text, text, text, text,
  integer, integer, integer, integer, text, text, text
) to authenticated;
