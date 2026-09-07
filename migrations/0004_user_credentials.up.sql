-- The users table held only id, name and email, so there was nothing to
-- authenticate against. Identity was whatever userId the caller put in the query
-- string.
--
-- Nullable rather than NOT NULL: existing rows have no credential, and a NOT NULL
-- column with a default would give every one of them the same fake hash. A NULL
-- hash means "this account cannot log in", which the login route treats exactly
-- like a wrong password.
ALTER TABLE users
  ADD COLUMN password_hash VARCHAR(255) NULL AFTER email;
