-- Indexes for the administrative prefix search and sparse tutor directory.
CREATE INDEX users_email_prefix ON users(email text_pattern_ops);
CREATE INDEX users_last_name_prefix ON users(lower(last_name) text_pattern_ops);
CREATE INDEX users_tutor_directory ON users(last_name,id)
 WHERE role='TUTOR' AND NOT disabled AND zoom_user_id IS NOT NULL;
CREATE UNIQUE INDEX users_zoom_identity ON users(zoom_user_id) WHERE zoom_user_id IS NOT NULL;
CREATE INDEX auth_tokens_expiry ON auth_tokens(expires_at);
ALTER TABLE credit_transactions ADD CONSTRAINT credit_kind_amount CHECK (
 (kind='LESSON' AND delta=-8) OR (kind='BUNDLE' AND delta=-15) OR
 (kind='RECORDING' AND delta=-3) OR (kind='TOPUP' AND delta>0) OR kind='ADMIN'
);
