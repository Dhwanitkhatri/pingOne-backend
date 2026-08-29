-- Splits "what the user typed" from "what the platform needs".
--
-- Telegram's Bot API addresses a private user ONLY by numeric chat_id, and
-- offers no way to resolve one from an @username — the id exists only after
-- that person has messaged the bot. Until now the single `handle` column had
-- to hold whichever of the two you had, so storing a readable "@aarav" meant
-- sends failed with "Bad Request: chat not found".
--
-- `handle` now stays the display value; `chat_id` holds the captured address
-- and is what the recipient resolver sends to. Null means "not linked yet".

-- AlterTable
ALTER TABLE "contact_platform_handles" ADD COLUMN     "chat_id" VARCHAR(64);
ALTER TABLE "contact_platform_handles" ADD COLUMN     "linked_at" TIMESTAMP(6);

-- Backfill: a handle that is already all digits IS a chat id — that is what
-- anyone who worked around the old limitation would have stored. Treat those
-- as linked so existing working contacts keep sending without re-linking.
UPDATE "contact_platform_handles" cph
SET "chat_id" = cph."handle",
    "linked_at" = cph."created_at"
FROM "platforms" p
WHERE p."id" = cph."platform_id"
  AND p."code" = 'telegram'
  AND cph."handle" ~ '^-?[0-9]+$';

-- CreateIndex
-- Every inbound Telegram update looks a contact up by (platform, chat_id) to
-- attribute the reply, so this is on the hot path of the webhook.
CREATE INDEX "idx_cph_platform_chat_id" ON "contact_platform_handles"("platform_id", "chat_id");
