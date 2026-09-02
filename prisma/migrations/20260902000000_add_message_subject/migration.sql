-- A subject is meaningful only for Gmail, so it remains nullable for all
-- existing and non-email messages. No existing message row is rewritten.
ALTER TABLE "messages" ADD COLUMN "subject" VARCHAR(250);
