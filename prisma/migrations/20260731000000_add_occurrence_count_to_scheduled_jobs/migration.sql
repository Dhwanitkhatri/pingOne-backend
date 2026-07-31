-- Tracks how many times a recurring job has fired, so
-- recurrence_rules.max_occurrences can be enforced. Existing rows start at 0;
-- jobs already mid-series simply get their full allowance from here on.

-- AlterTable
ALTER TABLE "scheduled_jobs" ADD COLUMN     "occurrence_count" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
-- Deliveries are looked up by platform_message_id on every inbound webhook
-- callback (Meta/Telegram identify a message only by their own id).
CREATE INDEX "idx_md_platform_message_id" ON "message_deliveries"("platform_message_id");

-- CreateIndex
-- Analytics buckets deliveries by send time; without this, /analytics/summary
-- and /analytics/best-send-times sequentially scan the whole table.
CREATE INDEX "idx_md_sent_at" ON "message_deliveries"("sent_at");
