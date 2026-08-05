-- Per-user personalization: app accent color + initials-avatar color.
ALTER TABLE "User" ADD COLUMN "accentColor" TEXT;
ALTER TABLE "User" ADD COLUMN "avatarColor" TEXT;

-- Optional background color on contact notes (named key, e.g. "yellow").
ALTER TABLE "ContactActivity" ADD COLUMN "color" TEXT;
