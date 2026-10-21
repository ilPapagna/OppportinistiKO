CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE TYPE user_role AS ENUM ('STUDENT','TUTOR','ADMIN');
CREATE TABLE users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL UNIQUE CHECK(email=lower(email)),
 first_name text NOT NULL, last_name text NOT NULL, birth_date date NOT NULL,
 password_hash text, role user_role NOT NULL DEFAULT 'STUDENT', disabled boolean NOT NULL DEFAULT false,
 email_verified_at timestamptz, zoom_user_id text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE wallets (user_id uuid PRIMARY KEY REFERENCES users(id), balance integer NOT NULL DEFAULT 0 CHECK(balance>=0));
CREATE TABLE sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), token_hash text NOT NULL UNIQUE, csrf_hash text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX sessions_user ON sessions(user_id); CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE auth_tokens (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), token_hash text NOT NULL UNIQUE, purpose text NOT NULL CHECK(purpose IN ('verify','reset')), expires_at timestamptz NOT NULL, used_at timestamptz);
CREATE INDEX auth_tokens_user ON auth_tokens(user_id);
CREATE TABLE legal_versions (version text PRIMARY KEY, body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO legal_versions(version,body) VALUES ('parent-recording-v1','In qualità di genitore/tutore, autorizzo l''iscrizione del minore e acconsento alla registrazione video e audio obbligatoria di tutte le lezioni individuali 1-a-1 a fini di tutela, sicurezza e qualità didattica');
CREATE TABLE parent_challenges (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), student_id uuid NOT NULL REFERENCES users(id), guardian_encrypted text NOT NULL, otp_hash text NOT NULL, legal_version text NOT NULL REFERENCES legal_versions(version), attempts integer NOT NULL DEFAULT 0, expires_at timestamptz NOT NULL, verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX parent_challenges_student ON parent_challenges(student_id,created_at DESC);
CREATE TABLE legal_consents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), student_id uuid NOT NULL REFERENCES users(id), challenge_id uuid NOT NULL UNIQUE REFERENCES parent_challenges(id), guardian_encrypted text NOT NULL, ip inet NOT NULL, user_agent text NOT NULL, legal_version text NOT NULL REFERENCES legal_versions(version), accepted_text text NOT NULL, accepted_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX legal_consents_student ON legal_consents(student_id,accepted_at DESC);
CREATE TABLE admin_audit (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, actor_id uuid NOT NULL REFERENCES users(id), target_id uuid REFERENCES users(id), action text NOT NULL, reason text NOT NULL, details jsonb NOT NULL DEFAULT '{}', ip inet NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE credit_transactions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), delta integer NOT NULL CHECK(delta<>0), balance_after integer NOT NULL CHECK(balance_after>=0), kind text NOT NULL CHECK(kind IN ('TOPUP','LESSON','BUNDLE','RECORDING','ADMIN')), reference text NOT NULL, idempotency_key text NOT NULL, request_hash text NOT NULL, actor_id uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,idempotency_key));
CREATE INDEX credit_transactions_history ON credit_transactions(user_id,created_at DESC,id);
CREATE FUNCTION immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable audit record' USING ERRCODE='55000'; END $$;
CREATE TRIGGER immutable_credits BEFORE UPDATE OR DELETE OR TRUNCATE ON credit_transactions FOR EACH STATEMENT EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_consents BEFORE UPDATE OR DELETE OR TRUNCATE ON legal_consents FOR EACH STATEMENT EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_admin BEFORE UPDATE OR DELETE OR TRUNCATE ON admin_audit FOR EACH STATEMENT EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_legal BEFORE UPDATE OR DELETE OR TRUNCATE ON legal_versions FOR EACH STATEMENT EXECUTE FUNCTION immutable_record();
CREATE TABLE lessons (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL UNIQUE, storage_key text, introduction boolean NOT NULL DEFAULT false, active boolean NOT NULL DEFAULT true);
INSERT INTO lessons(title,introduction) VALUES ('Ripassi programmati',true),('Metodo dei Loci',false),('Conversione fonetica',false),('Mappe mentali',false);
CREATE TABLE orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), lesson_id uuid NOT NULL REFERENCES lessons(id), product text NOT NULL CHECK(product IN ('single','bundle')), transaction_id uuid NOT NULL UNIQUE REFERENCES credit_transactions(id), created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX orders_user ON orders(user_id,created_at DESC);
CREATE TABLE call_entitlements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), order_id uuid NOT NULL UNIQUE REFERENCES orders(id), consumed boolean NOT NULL DEFAULT false);
CREATE INDEX entitlement_available ON call_entitlements(user_id) WHERE NOT consumed;
CREATE TABLE reviews (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), subject text NOT NULL, topic text NOT NULL, study_date date NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX reviews_user ON reviews(user_id,created_at DESC,id);
CREATE TABLE review_steps (review_id uuid NOT NULL REFERENCES reviews(id) ON DELETE CASCADE, step integer NOT NULL CHECK(step BETWEEN 0 AND 3), due_date date NOT NULL, done boolean NOT NULL DEFAULT false, PRIMARY KEY(review_id,step));
CREATE TABLE associations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), number text NOT NULL CHECK(number ~ '^[0-9]{1,12}$'), word text NOT NULL, image_key text, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX associations_user ON associations(user_id,created_at DESC,id);
CREATE TABLE tutor_slots (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tutor_id uuid NOT NULL REFERENCES users(id), starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, CHECK(ends_at=starts_at+interval '1 hour'), EXCLUDE USING gist(tutor_id WITH =,tstzrange(starts_at,ends_at,'[)') WITH &&));
CREATE INDEX slots_future ON tutor_slots(starts_at,tutor_id);
CREATE TABLE bookings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), student_id uuid NOT NULL REFERENCES users(id), slot_id uuid NOT NULL UNIQUE REFERENCES tutor_slots(id), entitlement_id uuid NOT NULL UNIQUE REFERENCES call_entitlements(id), consent_id uuid REFERENCES legal_consents(id), recording_notice_version text NOT NULL, status text NOT NULL DEFAULT 'PROVISIONING' CHECK(status IN ('PROVISIONING','READY','ACTION_REQUIRED','COMPLETED')), zoom_meeting_id text UNIQUE, zoom_uuid text, join_url text, creation_started_at timestamptz, idempotency_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(student_id,idempotency_key));
CREATE INDEX bookings_student ON bookings(student_id,created_at DESC,id);
CREATE TABLE recordings (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), booking_id uuid NOT NULL REFERENCES bookings(id), zoom_file_id text NOT NULL UNIQUE, storage_key text, status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','READY','FAILED')), created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX recordings_booking ON recordings(booking_id,created_at DESC);
CREATE TABLE recording_unlocks (recording_id uuid NOT NULL REFERENCES recordings(id), user_id uuid NOT NULL REFERENCES users(id), transaction_id uuid NOT NULL UNIQUE REFERENCES credit_transactions(id), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(recording_id,user_id));
CREATE TABLE checkout_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id), credits integer NOT NULL, amount_cents integer NOT NULL, currency text NOT NULL DEFAULT 'eur', stripe_session_id text UNIQUE, credited boolean NOT NULL DEFAULT false, idempotency_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id,idempotency_key));
CREATE TABLE webhook_events (provider text NOT NULL, event_id text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(provider,event_id));
CREATE TABLE jobs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), kind text NOT NULL CHECK(kind IN ('EMAIL','ZOOM_CREATE','ZOOM_IMPORT')), dedup_key text NOT NULL UNIQUE, payload_encrypted text, status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','RUNNING','DONE','FAILED')), attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, lease_token uuid, last_error text, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX jobs_claim ON jobs(available_at,created_at) WHERE status IN ('PENDING','RUNNING');
