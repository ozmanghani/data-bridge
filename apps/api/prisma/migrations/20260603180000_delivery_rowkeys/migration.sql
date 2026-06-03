-- Store the row's primary-key value(s) per delivery so failed rows can be
-- retried precisely (a new run with `pk IN (failed keys)`).
ALTER TABLE "hook_deliveries" ADD COLUMN "row_keys_json" TEXT;
