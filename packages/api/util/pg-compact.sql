BEGIN;
LOCK users;

CREATE TABLE users_temp (LIKE users INCLUDING ALL);

INSERT INTO users_temp -- no target list in this case
SELECT row_number() OVER (ORDER BY id), email, name, created, number  -- all columns in default order
FROM   users;

ALTER SEQUENCE users_id_seq OWNED BY users_temp.id;  -- make new table own sequence

DROP TABLE users;
ALTER TABLE users_temp RENAME TO users;

SELECT setval('users_id_seq', max(id)) FROM users;  -- reset sequence

COMMIT;
