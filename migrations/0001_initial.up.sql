-- Verbatim copy of the schema that used to live in docker/db/mysql.sql, so an
-- existing database can be baselined by inserting this name into _migrations
-- rather than re-running DDL against tables that already exist.
--
-- Known problems with this schema are deliberately preserved here and fixed in
-- later migrations: no indexes (C9), no foreign keys (C9), TIMESTAMP with
-- second granularity (N6), no unique constraint on client_id (N5).

SET NAMES utf8mb4;

CREATE TABLE users (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(190) NOT NULL
);

CREATE TABLE conversations (
  id INT PRIMARY KEY AUTO_INCREMENT,
  title VARCHAR(200) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE conversation_participants (
  conversation_id INT NOT NULL,
  user_id INT NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE messages (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  conversation_id INT NOT NULL,
  sender_id INT NOT NULL,
  client_id VARCHAR(64) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
