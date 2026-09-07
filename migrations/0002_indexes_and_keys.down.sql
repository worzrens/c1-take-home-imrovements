ALTER TABLE conversation_participants
  DROP FOREIGN KEY fk_participants_conversation,
  DROP FOREIGN KEY fk_participants_user;

ALTER TABLE messages
  DROP FOREIGN KEY fk_messages_conversation,
  DROP FOREIGN KEY fk_messages_sender;

ALTER TABLE users DROP INDEX uq_users_email;
ALTER TABLE messages DROP INDEX uq_messages_client;
ALTER TABLE conversation_participants DROP INDEX idx_participants_user;
ALTER TABLE messages DROP INDEX idx_messages_conversation;
