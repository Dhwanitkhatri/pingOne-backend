-- When the summary email (daily / weekly / monthly digest) last went out.
-- NULL until the first one; the digest scheduler measures each period from it.
ALTER TABLE "notification_preferences" ADD COLUMN "last_digest_sent_at" TIMESTAMP(6);
