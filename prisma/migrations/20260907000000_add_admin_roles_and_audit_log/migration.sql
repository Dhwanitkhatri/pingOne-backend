-- Back-office roles + the admin audit trail.
--
-- Every existing row becomes a plain USER by the column default, so this is a
-- safe forward-only migration: no account gains rights implicitly. Promote the
-- first operator with `npm run db:seed` (see ADMIN_EMAIL in .env) or with an
-- explicit UPDATE.

-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('USER', 'ADMIN', 'SUPER_ADMIN');

-- AlterTable
ALTER TABLE "users"
  ADD COLUMN "role" "user_role" NOT NULL DEFAULT 'USER',
  ADD COLUMN "last_login_at" TIMESTAMP(6);

-- The admin dashboard filters and sorts users on exactly these three columns
-- (role for the operator list, created_at for the sign-up trend, last_login_at
-- for the active-user count), and each one is a full-table scan without help.
CREATE INDEX "idx_users_role" ON "users"("role");
CREATE INDEX "idx_users_created_at" ON "users"("created_at");
CREATE INDEX "idx_users_last_login_at" ON "users"("last_login_at");

-- CreateTable
CREATE TABLE "admin_audit_logs" (
    "id" SERIAL NOT NULL,
    "admin_id" INTEGER NOT NULL,
    "action" VARCHAR(60) NOT NULL,
    "target_type" VARCHAR(30),
    "target_id" INTEGER,
    "target_label" VARCHAR(255),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(255),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "target_user_id" INTEGER,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_aal_admin_created" ON "admin_audit_logs"("admin_id", "created_at");
CREATE INDEX "idx_aal_created_at" ON "admin_audit_logs"("created_at");
CREATE INDEX "idx_aal_action" ON "admin_audit_logs"("action");

-- AddForeignKey
-- The ACTOR cascades: if an admin account is erased outright, their trail goes
-- with it (there is no longer a subject the log describes).
ALTER TABLE "admin_audit_logs"
  ADD CONSTRAINT "admin_audit_logs_admin_id_fkey"
  FOREIGN KEY ("admin_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- The TARGET does not cascade. "Admin X deleted user Y" must survive the
-- deletion of Y — otherwise the record of the most consequential action erases
-- itself. target_label keeps the email readable after the FK goes null.
ALTER TABLE "admin_audit_logs"
  ADD CONSTRAINT "admin_audit_logs_target_user_id_fkey"
  FOREIGN KEY ("target_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
