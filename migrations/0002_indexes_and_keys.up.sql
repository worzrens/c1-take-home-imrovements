-- Every message read filtered by conversation_id against no index at all, so the
-- sidebar scanned the whole messages table twice per conversation. Participant
-- lookup by user_id could not use the primary key either, since user_id is its
-- second column.
--
-- (conversation_id, id) rather than (conversation_id): InnoDB appends the primary
-- key to a secondary index anyway, so the two are physically the same. Written out
-- to state the intent, which is filter by conversation then order by id.
ALTER TABLE messages
  ADD INDEX idx_messages_conversation (conversation_id, id);

ALTER TABLE conversation_participants
  ADD INDEX idx_participants_user (user_id);

-- Makes client_id usable for idempotency. NULLs are not equal to each other in a
-- MySQL unique index, so existing rows with a NULL client_id are unaffected.
ALTER TABLE messages
  ADD UNIQUE INDEX uq_messages_client (conversation_id, client_id);

ALTER TABLE users
  ADD UNIQUE INDEX uq_users_email (email);

-- No foreign keys existed, so a message could reference a conversation that was
-- never created and nothing noticed. CASCADE where the child has no meaning
-- without its parent; RESTRICT on sender so a user with history cannot vanish.
ALTER TABLE messages
  ADD CONSTRAINT fk_messages_conversation
    FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_messages_sender
    FOREIGN KEY (sender_id) REFERENCES users (id);

ALTER TABLE conversation_participants
  ADD CONSTRAINT fk_participants_conversation
    FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE,
  ADD CONSTRAINT fk_participants_user
    FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE;
