-- database_additions.sql
-- Run this in the Supabase SQL Editor

-- ── 1. CREATE NEW TABLES ──────────────────────────────────────────────────────

-- user_plans: tracks plan type and monthly usage
CREATE TABLE IF NOT EXISTS public.user_plans (
  id               bigserial PRIMARY KEY,
  user_id          bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  plan             text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'premium')),
  blueprint_count_this_month integer NOT NULL DEFAULT 0,
  chat_message_count_this_session integer NOT NULL DEFAULT 0,
  period_start     date NOT NULL DEFAULT date_trunc('month', now()),
  upgraded_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

-- blueprint_outcomes: 30-day post-generation survey responses
CREATE TABLE IF NOT EXISTS public.blueprint_outcomes (
  id               bigserial PRIMARY KEY,
  user_id          bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  blueprint_id     text NOT NULL,
  outcome          text,
  rating           integer CHECK (rating BETWEEN 1 AND 5),
  submitted_at     timestamptz NOT NULL DEFAULT now()
);

-- testimonials: user-submitted quotes for landing page
CREATE TABLE IF NOT EXISTS public.testimonials (
  id               bigserial PRIMARY KEY,
  user_id          bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  quote            text NOT NULL,
  startup_name     text,
  approved         boolean NOT NULL DEFAULT false,
  submitted_at     timestamptz NOT NULL DEFAULT now()
);

-- calculator_results: saved break-even / GST / runway inputs and outputs
CREATE TABLE IF NOT EXISTS public.calculator_results (
  id               bigserial PRIMARY KEY,
  user_id          bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  calculator_type  text NOT NULL,
  input_params     jsonb,
  result_data      jsonb,
  saved_at         timestamptz NOT NULL DEFAULT now()
);

-- expert_reviews: human expert review requests
CREATE TABLE IF NOT EXISTS public.expert_reviews (
  id               bigserial PRIMARY KEY,
  user_id          bigint NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  blueprint_id     text,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_review', 'completed')),
  requested_at     timestamptz NOT NULL DEFAULT now()
);

-- ── 2. TRIGGERS & FUNCTIONS ──────────────────────────────────────────────────

-- Function: reset blueprint count if the current period has expired
CREATE OR REPLACE FUNCTION reset_monthly_blueprint_count()
RETURNS TRIGGER AS $$
BEGIN
  -- If the stored period_start is not the current month, reset the counter
  IF NEW.period_start < date_trunc('month', now())::date THEN
    NEW.blueprint_count_this_month := 0;
    NEW.period_start := date_trunc('month', now())::date;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger: fires BEFORE any UPDATE on user_plans
DROP TRIGGER IF EXISTS trg_reset_monthly_count ON public.user_plans;
CREATE TRIGGER trg_reset_monthly_count
BEFORE UPDATE ON public.user_plans
FOR EACH ROW
EXECUTE FUNCTION reset_monthly_blueprint_count();

-- Prevent one user from submitting more than 3 testimonials
CREATE OR REPLACE FUNCTION check_testimonial_limit()
RETURNS TRIGGER AS $$
BEGIN
  IF (SELECT COUNT(*) FROM public.testimonials WHERE user_id = NEW.user_id) >= 3 THEN
    RAISE EXCEPTION 'Testimonial limit reached for this user';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_testimonial_limit ON public.testimonials;
CREATE TRIGGER trg_testimonial_limit
BEFORE INSERT ON public.testimonials
FOR EACH ROW
EXECUTE FUNCTION check_testimonial_limit();

-- Function to set transaction-local settings via RPC
CREATE OR REPLACE FUNCTION public.set_config(key text, value text)
RETURNS text AS $$
BEGIN
  PERFORM set_config(key, value, true);
  RETURN value;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to get the current user ID from the transaction setting
CREATE OR REPLACE FUNCTION public.get_current_user_id()
RETURNS bigint AS $$
BEGIN
  RETURN nullif(current_setting('app.current_user_id', true), '')::bigint;
EXCEPTION WHEN OTHERS THEN
  RETURN null;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ── 3. ROW LEVEL SECURITY (RLS) POLICIES ──────────────────────────────────────

ALTER TABLE public.user_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blueprint_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.testimonials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calculator_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expert_reviews ENABLE ROW LEVEL SECURITY;

-- user_plans: users can only read/update their own row
DROP POLICY IF EXISTS "user_plans_self" ON public.user_plans;
CREATE POLICY "user_plans_self" ON public.user_plans
  USING (user_id = public.get_current_user_id());

-- blueprint_outcomes: users can only read/insert their own
DROP POLICY IF EXISTS "outcomes_self" ON public.blueprint_outcomes;
CREATE POLICY "outcomes_self" ON public.blueprint_outcomes
  USING (user_id = public.get_current_user_id());

-- testimonials: users can read approved ones + their own, insert their own
DROP POLICY IF EXISTS "testimonials_read" ON public.testimonials;
CREATE POLICY "testimonials_read" ON public.testimonials
  FOR SELECT USING (approved = true OR user_id = public.get_current_user_id());

DROP POLICY IF EXISTS "testimonials_insert" ON public.testimonials;
CREATE POLICY "testimonials_insert" ON public.testimonials
  FOR INSERT WITH CHECK (user_id = public.get_current_user_id());

-- calculator_results: users see only their own
DROP POLICY IF EXISTS "calculator_self" ON public.calculator_results;
CREATE POLICY "calculator_self" ON public.calculator_results
  USING (user_id = public.get_current_user_id());

-- expert_reviews: users see only their own
DROP POLICY IF EXISTS "expert_self" ON public.expert_reviews;
CREATE POLICY "expert_self" ON public.expert_reviews
  USING (user_id = public.get_current_user_id());

-- ── 4. SEEDING / MIGRATING EXISTING USERS ─────────────────────────────────────

-- Seed user_plans with free plans for all existing users in the users table
INSERT INTO public.user_plans (user_id, plan, blueprint_count_this_month)
SELECT id, 'free', 0 FROM public.users
ON CONFLICT (user_id) DO NOTHING;
