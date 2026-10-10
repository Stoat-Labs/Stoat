ALTER TABLE "instance_settings" ALTER COLUMN "signups_enabled" SET DEFAULT false;--> statement-breakpoint
-- Users now create or join organizations explicitly instead of getting a personal one.
DROP TRIGGER user_default_organization ON "user";
--> statement-breakpoint
DROP FUNCTION provision_user_organization();
--> statement-breakpoint
-- The very first account becomes the instance admin. The lock lasts until the inserting
-- transaction commits, so racing first sign-ups serialize and only one of them sees no users.
CREATE FUNCTION promote_first_user() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('stoat:first-user-admin'));
    IF NOT EXISTS (SELECT 1 FROM "user") THEN
        NEW.role := 'admin';
    END IF;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER user_first_is_admin
BEFORE INSERT ON "user"
FOR EACH ROW EXECUTE FUNCTION promote_first_user();
