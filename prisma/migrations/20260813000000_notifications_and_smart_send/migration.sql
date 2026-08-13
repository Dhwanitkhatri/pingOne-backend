-- Durable notifications plus a minimal, privacy-preserving inbound-reply log.

ALTER TABLE "scheduled_jobs" ADD COLUMN "skip_if_replied" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "notifications" (
  "id" SERIAL NOT NULL,
  "user_id" INTEGER NOT NULL,
  "delivery_id" INTEGER,
  "type" VARCHAR(50) NOT NULL,
  "title" VARCHAR(255) NOT NULL,
  "body" TEXT NOT NULL,
  "channel" VARCHAR(20) NOT NULL DEFAULT 'in_app',
  "email_sent_at" TIMESTAMP(6),
  "read_at" TIMESTAMP(6),
  "created_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notifications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "notifications_delivery_id_key" UNIQUE ("delivery_id"),
  CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE INDEX "idx_notifications_user_created" ON "notifications"("user_id", "created_at");

CREATE TABLE "contact_replies" (
  "id" SERIAL NOT NULL,
  "contact_id" INTEGER NOT NULL,
  "platform_id" SMALLINT NOT NULL,
  "replied_at" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "contact_replies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "contact_replies_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "contact_replies_platform_id_fkey" FOREIGN KEY ("platform_id") REFERENCES "platforms"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE INDEX "idx_contact_replies_lookup" ON "contact_replies"("contact_id", "platform_id", "replied_at");
