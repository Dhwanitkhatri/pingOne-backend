-- Template variables gain a fill mode.
--
-- Until now every {placeholder} was filled the same way: the sender supplied a
-- value (or the row's default) and the template rendered once, so a broadcast
-- to fifty people said "Hi {name}" fifty times with the same name — or, since
-- the composer never rendered at all, with the literal braces still in it.
--
-- `source` splits that into the two things people actually mean:
--   'manual'  — one value for the whole send, typed when the template is
--               picked. Substituted before the message row is written.
--   'contact' — read off each recipient's own contact row (`contact_field`),
--               so the value differs per delivery. These placeholders stay
--               literal in messages.content and are substituted by the
--               delivery worker, one recipient at a time.
--
-- 'manual' is the default, which is exactly the old behaviour, so every
-- existing variable keeps working untouched.

-- AlterTable
ALTER TABLE "template_variables" ADD COLUMN     "source" VARCHAR(20) NOT NULL DEFAULT 'manual';
ALTER TABLE "template_variables" ADD COLUMN     "contact_field" VARCHAR(30);

-- The CHECK that keeps `source` and `contact_field` consistent lives in
-- prisma/sql/constraints.sql (chk_tv_source_field), with the rest of the
-- constraints Prisma's schema language can't express. Run `npm run
-- db:constraints` after this migration.
