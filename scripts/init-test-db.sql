-- Runs once, when the Postgres volume is first created. The suite truncates
-- tables between files, so it needs a database that is not the dev one.
CREATE DATABASE flyrank_test OWNER flyrank;
