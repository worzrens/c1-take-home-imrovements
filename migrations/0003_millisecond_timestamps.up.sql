-- created_at was TIMESTAMP, which has second granularity and stops working in
-- 2038. Two messages sent in the same second were indistinguishable by time, and
-- the value the API returned was generated separately in Node, so the timestamp
-- broadcast over the WebSocket and the one seen on reload disagreed.
--
-- Note for anyone running this against existing data: TIMESTAMP stores UTC and
-- converts on read using the session time zone, DATETIME stores the literal
-- value. The conversion is clean when the server runs in UTC, which the
-- containers do. Check the session time zone first anywhere else.
ALTER TABLE messages
  MODIFY created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

ALTER TABLE conversations
  MODIFY created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
