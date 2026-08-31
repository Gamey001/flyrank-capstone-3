-- Runs once when the Postgres volume is first created.
-- `npm test` needs its own database because the suite truncates tables between
-- test files; pointing it at the development database would delete seed data.
CREATE DATABASE flyrank_test OWNER flyrank;
