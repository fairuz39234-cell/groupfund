alter table public.payments
  add column slip_check_status text not null default 'not_checked'
    check (slip_check_status in ('not_checked','not_configured','verified','mismatch','duplicate','invalid','manual_review','error')),
  add column slip_check_result jsonb,
  add column slip_check_error text,
  add column slip_check_at timestamptz;
