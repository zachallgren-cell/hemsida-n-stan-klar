alter table public.bookings
  add column if not exists payment_provider text,
  add column if not exists stripe_product_id text,
  add column if not exists stripe_price_id text,
  add column if not exists stripe_checkout_session_id text,
  add column if not exists stripe_payment_intent_id text,
  add column if not exists stripe_payment_url text,
  add column if not exists stripe_checkout_expires_at timestamp with time zone,
  add column if not exists stripe_paid_at timestamp with time zone;

comment on column public.bookings.payment_provider is 'Betalleverantör, till exempel stripe.';
comment on column public.bookings.stripe_product_id is 'Stripe Product ID som skapades för bokningen.';
comment on column public.bookings.stripe_price_id is 'Stripe Price ID som används i Checkout-sessionen.';
comment on column public.bookings.stripe_checkout_session_id is 'Stripe Checkout Session ID för bokningen.';
comment on column public.bookings.stripe_payment_intent_id is 'Stripe Payment Intent ID när betalningen är slutförd.';
comment on column public.bookings.stripe_payment_url is 'Unik Stripe Checkout-länk som kunden kan betala via.';
comment on column public.bookings.stripe_checkout_expires_at is 'När Stripe Checkout-länken går ut.';
comment on column public.bookings.stripe_paid_at is 'När Stripe-webhook markerade bokningen som betald.';
