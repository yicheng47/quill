CREATE INDEX IF NOT EXISTS idx_chats_pinned_updated
ON chats(pinned DESC, updated_at DESC, id ASC);
