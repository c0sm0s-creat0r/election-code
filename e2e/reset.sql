-- Empties the LOCAL dev database before a smoke run.
--
-- The run seeds a society with a fixed slug, and `.wrangler` keeps its D1 on
-- disk between runs, so without this the second run fails on "slug already
-- exists". Deleting in dependency order rather than relying on cascades:
-- election_seal and election_result reference election WITHOUT a cascade, so a
-- run that closed an election would otherwise hit a foreign-key error here.
--
-- This only ever touches the local file-backed database that `wrangler dev
-- --local` creates. It is never run against a deployed database.
DELETE FROM election_result;
DELETE FROM election_seal;
DELETE FROM ballot;
DELETE FROM vote_receipt;
DELETE FROM candidate;
DELETE FROM election;
DELETE FROM check_in;
DELETE FROM guest;
DELETE FROM voter_roll;
DELETE FROM audit_log;
DELETE FROM batch;
