-- ============================================================
-- PingOne — constraints & partial indexes that Prisma's schema
-- language cannot express. Run AFTER `prisma migrate dev`:
--
--     npm run db:constraints
--
-- Every statement is idempotent (safe to run repeatedly) so it can
-- follow each migration without failing on already-applied objects.
-- ============================================================

-- ------------------------------------------------------------
-- CHECK constraints
-- ------------------------------------------------------------

-- recurrence_rules.day_of_month BETWEEN 1 AND 31
ALTER TABLE recurrence_rules DROP CONSTRAINT IF EXISTS chk_rr_day_of_month;
ALTER TABLE recurrence_rules
    ADD CONSTRAINT chk_rr_day_of_month
    CHECK (day_of_month IS NULL OR day_of_month BETWEEN 1 AND 31);

-- recurrence_rules.month_of_year BETWEEN 1 AND 12
ALTER TABLE recurrence_rules DROP CONSTRAINT IF EXISTS chk_rr_month_of_year;
ALTER TABLE recurrence_rules
    ADD CONSTRAINT chk_rr_month_of_year
    CHECK (month_of_year IS NULL OR month_of_year BETWEEN 1 AND 12);

-- job_recipients: exactly one of (contact_id, group_id) must be set
ALTER TABLE job_recipients DROP CONSTRAINT IF EXISTS chk_jr_contact_xor_group;
ALTER TABLE job_recipients
    ADD CONSTRAINT chk_jr_contact_xor_group
    CHECK (
        (contact_id IS NOT NULL AND group_id IS NULL) OR
        (contact_id IS NULL AND group_id IS NOT NULL)
    );

-- ------------------------------------------------------------
-- Partial indexes (WHERE deleted_at IS NULL) — speed up the
-- common "only live rows" queries on soft-deletable tables.
-- ------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_users_deleted
    ON users (deleted_at) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_deleted
    ON contacts (deleted_at) WHERE deleted_at IS NULL;
