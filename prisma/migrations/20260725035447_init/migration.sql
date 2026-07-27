-- CreateTable
CREATE TABLE "platforms" (
    "id" SMALLSERIAL NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platforms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_statuses" (
    "id" SMALLSERIAL NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "description" VARCHAR(100) NOT NULL,

    CONSTRAINT "message_statuses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurrence_types" (
    "id" SMALLSERIAL NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "description" VARCHAR(100) NOT NULL,

    CONSTRAINT "recurrence_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "file_types" (
    "id" SMALLSERIAL NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "mime_prefix" VARCHAR(50) NOT NULL,

    CONSTRAINT "file_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" SERIAL NOT NULL,
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "is_verified" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_platform_credentials" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "platform_id" SMALLINT NOT NULL,
    "encrypted_token" TEXT NOT NULL,
    "token_iv" VARCHAR(255) NOT NULL,
    "extra_info" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "connected_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(6),
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_platform_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "notify_on_failure" BOOLEAN NOT NULL DEFAULT true,
    "notify_on_success" BOOLEAN NOT NULL DEFAULT false,
    "notify_on_token_expiry" BOOLEAN NOT NULL DEFAULT true,
    "digest_frequency" VARCHAR(20) NOT NULL DEFAULT 'weekly',
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100),
    "preferred_platform_id" SMALLINT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(6),

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_phones" (
    "id" SERIAL NOT NULL,
    "contact_id" INTEGER NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_phones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_emails" (
    "id" SERIAL NOT NULL,
    "contact_id" INTEGER NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_platform_handles" (
    "id" SERIAL NOT NULL,
    "contact_id" INTEGER NOT NULL,
    "platform_id" SMALLINT NOT NULL,
    "handle" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_platform_handles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_groups" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(255),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(6),

    CONSTRAINT "contact_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_group_members" (
    "contact_id" INTEGER NOT NULL,
    "group_id" INTEGER NOT NULL,
    "added_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_group_members_pkey" PRIMARY KEY ("contact_id","group_id")
);

-- CreateTable
CREATE TABLE "templates" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "platform_id" SMALLINT,
    "title" VARCHAR(100) NOT NULL,
    "content" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template_variables" (
    "id" SERIAL NOT NULL,
    "template_id" INTEGER NOT NULL,
    "variable_name" VARCHAR(50) NOT NULL,
    "default_value" VARCHAR(255),
    "is_required" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "template_variables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "template_id" INTEGER,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_attachments" (
    "id" SERIAL NOT NULL,
    "message_id" INTEGER NOT NULL,
    "file_type_id" SMALLINT NOT NULL,
    "file_name" VARCHAR(255) NOT NULL,
    "file_url" VARCHAR(500) NOT NULL,
    "file_size_bytes" INTEGER NOT NULL,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurrence_rules" (
    "id" SERIAL NOT NULL,
    "recurrence_type_id" SMALLINT NOT NULL,
    "interval_value" SMALLINT NOT NULL DEFAULT 1,
    "days_of_week" VARCHAR(20),
    "day_of_month" SMALLINT,
    "month_of_year" SMALLINT,
    "end_date" DATE,
    "max_occurrences" INTEGER,

    CONSTRAINT "recurrence_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_jobs" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "message_id" INTEGER NOT NULL,
    "recurrence_rule_id" INTEGER,
    "status_id" SMALLINT NOT NULL DEFAULT 1,
    "scheduled_at" TIMESTAMP(6) NOT NULL,
    "next_run_at" TIMESTAMP(6),
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scheduled_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_recipients" (
    "id" SERIAL NOT NULL,
    "job_id" INTEGER NOT NULL,
    "contact_id" INTEGER,
    "group_id" INTEGER,
    "platform_id" SMALLINT NOT NULL,

    CONSTRAINT "job_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_deliveries" (
    "id" SERIAL NOT NULL,
    "job_id" INTEGER NOT NULL,
    "contact_id" INTEGER NOT NULL,
    "platform_id" SMALLINT NOT NULL,
    "status_id" SMALLINT NOT NULL,
    "platform_message_id" VARCHAR(255),
    "sent_at" TIMESTAMP(6),
    "delivered_at" TIMESTAMP(6),
    "read_at" TIMESTAMP(6),
    "retry_count" SMALLINT NOT NULL DEFAULT 0,
    "error_reason" TEXT,
    "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_status_logs" (
    "id" SERIAL NOT NULL,
    "delivery_id" INTEGER NOT NULL,
    "old_status_id" SMALLINT,
    "new_status_id" SMALLINT NOT NULL,
    "changed_by" VARCHAR(20) NOT NULL DEFAULT 'system',
    "changed_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_status_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "platforms_code_key" ON "platforms"("code");

-- CreateIndex
CREATE UNIQUE INDEX "message_statuses_code_key" ON "message_statuses"("code");

-- CreateIndex
CREATE UNIQUE INDEX "recurrence_types_code_key" ON "recurrence_types"("code");

-- CreateIndex
CREATE UNIQUE INDEX "file_types_code_key" ON "file_types"("code");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "idx_users_email" ON "users"("email");

-- CreateIndex
CREATE INDEX "idx_upc_user_id" ON "user_platform_credentials"("user_id");

-- CreateIndex
CREATE INDEX "idx_upc_platform_id" ON "user_platform_credentials"("platform_id");

-- CreateIndex
CREATE UNIQUE INDEX "user_platform_credentials_user_id_platform_id_key" ON "user_platform_credentials"("user_id", "platform_id");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preferences_user_id_key" ON "notification_preferences"("user_id");

-- CreateIndex
CREATE INDEX "idx_contacts_user_id" ON "contacts"("user_id");

-- CreateIndex
CREATE INDEX "idx_contact_phones_contact_id" ON "contact_phones"("contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_phones_contact_id_phone_key" ON "contact_phones"("contact_id", "phone");

-- CreateIndex
CREATE INDEX "idx_contact_emails_contact_id" ON "contact_emails"("contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_emails_contact_id_email_key" ON "contact_emails"("contact_id", "email");

-- CreateIndex
CREATE INDEX "idx_cph_contact_id" ON "contact_platform_handles"("contact_id");

-- CreateIndex
CREATE INDEX "idx_cph_platform_id" ON "contact_platform_handles"("platform_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_platform_handles_contact_id_platform_id_key" ON "contact_platform_handles"("contact_id", "platform_id");

-- CreateIndex
CREATE INDEX "idx_contact_groups_user_id" ON "contact_groups"("user_id");

-- CreateIndex
CREATE INDEX "idx_cgm_group_id" ON "contact_group_members"("group_id");

-- CreateIndex
CREATE INDEX "idx_cgm_contact_id" ON "contact_group_members"("contact_id");

-- CreateIndex
CREATE INDEX "idx_templates_user_id" ON "templates"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "template_variables_template_id_variable_name_key" ON "template_variables"("template_id", "variable_name");

-- CreateIndex
CREATE INDEX "idx_messages_user_id" ON "messages"("user_id");

-- CreateIndex
CREATE INDEX "idx_sj_user_id" ON "scheduled_jobs"("user_id");

-- CreateIndex
CREATE INDEX "idx_sj_status_id" ON "scheduled_jobs"("status_id");

-- CreateIndex
CREATE INDEX "idx_sj_next_run" ON "scheduled_jobs"("next_run_at");

-- CreateIndex
CREATE INDEX "idx_sj_scheduled_at" ON "scheduled_jobs"("scheduled_at");

-- CreateIndex
CREATE INDEX "idx_jr_job_id" ON "job_recipients"("job_id");

-- CreateIndex
CREATE INDEX "idx_jr_contact_id" ON "job_recipients"("contact_id");

-- CreateIndex
CREATE INDEX "idx_jr_group_id" ON "job_recipients"("group_id");

-- CreateIndex
CREATE INDEX "idx_md_job_id" ON "message_deliveries"("job_id");

-- CreateIndex
CREATE INDEX "idx_md_contact_id" ON "message_deliveries"("contact_id");

-- CreateIndex
CREATE INDEX "idx_md_status_id" ON "message_deliveries"("status_id");

-- CreateIndex
CREATE INDEX "idx_md_platform_id" ON "message_deliveries"("platform_id");

-- CreateIndex
CREATE INDEX "idx_dsl_delivery_id" ON "delivery_status_logs"("delivery_id");

-- AddForeignKey
ALTER TABLE "user_platform_credentials" ADD CONSTRAINT "user_platform_credentials_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "platforms"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "user_platform_credentials" ADD CONSTRAINT "user_platform_credentials_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_preferred_platform_id_fkey" FOREIGN KEY ("preferred_platform_id") REFERENCES "platforms"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "contact_phones" ADD CONSTRAINT "contact_phones_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "contact_emails" ADD CONSTRAINT "contact_emails_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "contact_platform_handles" ADD CONSTRAINT "contact_platform_handles_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "contact_platform_handles" ADD CONSTRAINT "contact_platform_handles_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "platforms"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "contact_groups" ADD CONSTRAINT "contact_groups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "contact_group_members" ADD CONSTRAINT "contact_group_members_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "contact_group_members" ADD CONSTRAINT "contact_group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "contact_groups"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "platforms"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "templates" ADD CONSTRAINT "templates_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "template_variables" ADD CONSTRAINT "template_variables_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "templates"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_file_type_id_fkey" FOREIGN KEY ("file_type_id") REFERENCES "file_types"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "recurrence_rules" ADD CONSTRAINT "recurrence_rules_recurrence_type_id_fkey" FOREIGN KEY ("recurrence_type_id") REFERENCES "recurrence_types"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_recurrence_rule_id_fkey" FOREIGN KEY ("recurrence_rule_id") REFERENCES "recurrence_rules"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "message_statuses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "scheduled_jobs" ADD CONSTRAINT "scheduled_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "job_recipients" ADD CONSTRAINT "job_recipients_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "job_recipients" ADD CONSTRAINT "job_recipients_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "contact_groups"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "job_recipients" ADD CONSTRAINT "job_recipients_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "scheduled_jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "job_recipients" ADD CONSTRAINT "job_recipients_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "platforms"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "scheduled_jobs"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "platforms"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "message_deliveries" ADD CONSTRAINT "message_deliveries_status_id_fkey" FOREIGN KEY ("status_id") REFERENCES "message_statuses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "delivery_status_logs" ADD CONSTRAINT "delivery_status_logs_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "message_deliveries"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "delivery_status_logs" ADD CONSTRAINT "delivery_status_logs_new_status_id_fkey" FOREIGN KEY ("new_status_id") REFERENCES "message_statuses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "delivery_status_logs" ADD CONSTRAINT "delivery_status_logs_old_status_id_fkey" FOREIGN KEY ("old_status_id") REFERENCES "message_statuses"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
