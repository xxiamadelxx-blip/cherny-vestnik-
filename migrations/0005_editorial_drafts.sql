-- Preserve a rejected editorial draft so a Groq quota pause does not force a
-- second initial generation. Kept under digests chat/day privacy controls.
ALTER TABLE digests ADD COLUMN editorial_draft TEXT;
ALTER TABLE digests ADD COLUMN editorial_attempts INTEGER NOT NULL DEFAULT 0;
