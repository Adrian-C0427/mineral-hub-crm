-- 2026-07 integration ecosystem cut: Perplexity, Gmail, Slack, OpenAI, Gemini,
-- Dropbox, Box, Google Calendar, Mailchimp, and Google Sign-In were removed
-- from the product. Purge any per-org rows (and their encrypted credentials)
-- stored while those providers existed. OAuthAccount rows for Google sign-in
-- are left in place: they hold no credentials and are inert without the
-- sign-in route, but preserve the account link history.
DELETE FROM "Integration"
WHERE "provider" IN (
  'perplexity', 'gmail', 'slack', 'openai', 'gemini', 'dropbox', 'box',
  'googlecalendar', 'mailchimp', 'googlesignin'
);
