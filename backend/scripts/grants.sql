-- Run as migration owner: psql "$DATABASE_URL" -v app_role=radice_app -f scripts/grants.sql
-- Create the login role/password securely using the provider first. It must NOT own the tables.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO :"app_role";
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO :"app_role";
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO :"app_role";
REVOKE UPDATE,DELETE,TRUNCATE ON legal_consents,legal_versions,credit_transactions,admin_audit FROM :"app_role";
REVOKE ALL ON schema_migrations FROM :"app_role";
REVOKE INSERT ON legal_versions FROM :"app_role";
