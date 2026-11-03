-- Exclusão de conta (feature account): tudo roda numa transação.

-- name: LockUserForDelete :one
SELECT id, avatar_key, banner_key, deleted_at FROM users WHERE id = $1 FOR UPDATE;

-- name: ListOwnedGuilds :many
SELECT id, name FROM guilds WHERE owner_id = $1 ORDER BY id;

-- name: ListMemberGuildIDs :many
SELECT guild_id FROM guild_members WHERE user_id = $1;

-- name: AnonymizeUser :exec
UPDATE users
SET email = $2, username = $3, display_name = NULL, avatar_key = NULL, banner_key = NULL, banner_color = NULL,
    bio = NULL, pronouns = NULL, password_hash = '!', custom_status_text = NULL, custom_status_emoji = NULL,
    custom_status_expires_at = NULL, is_admin = false, email_verified_at = NULL, pending_email = NULL, deleted_at = now()
WHERE id = $1;

-- name: DeleteMembershipsByUser :exec
DELETE FROM guild_members WHERE user_id = $1;

-- name: DeleteSessionsByUser :exec
DELETE FROM sessions WHERE user_id = $1;

-- name: DeletePushSubscriptionsByUser :exec
DELETE FROM push_subscriptions WHERE user_id = $1;

-- name: DeleteNotificationSettingsByUser :exec
DELETE FROM notification_settings WHERE user_id = $1;

-- name: DeleteReadStatesByUser :exec
DELETE FROM read_states WHERE user_id = $1;

-- name: ListGroupDMsByUser :many
SELECT c.id, c.owner_id
FROM channels c
JOIN channel_recipients r ON r.channel_id = c.id
WHERE r.user_id = $1 AND c.type = 4
ORDER BY c.id;

-- name: ListOtherRecipients :many
SELECT user_id FROM channel_recipients WHERE channel_id = $1 AND user_id <> $2 ORDER BY user_id;

-- name: DeleteRecipientRow :exec
DELETE FROM channel_recipients WHERE channel_id = $1 AND user_id = $2;

-- name: SetChannelOwner :exec
UPDATE channels SET owner_id = $2 WHERE id = $1;

-- name: DeleteChannelByID :exec
DELETE FROM channels WHERE id = $1;

-- name: DeleteSocialAccountsByUser :exec
DELETE FROM social_accounts WHERE user_id = $1;

-- name: DeleteEmailTokensByUser :exec
DELETE FROM email_tokens WHERE user_id = $1;
