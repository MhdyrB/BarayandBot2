CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admins (user_id TEXT PRIMARY KEY, role TEXT DEFAULT 'admin', enabled INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS users (user_id TEXT PRIMARY KEY, username TEXT, first_name TEXT, last_name TEXT, last_seen INTEGER, blocked INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions (user_id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT DEFAULT '{}', updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS conversations (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, admin_id TEXT, anonymous INTEGER DEFAULT 0, user_message_id INTEGER, admin_message_id INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS blocks (user_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, reason TEXT);
CREATE TABLE IF NOT EXISTS files (token TEXT PRIMARY KEY, source_chat_id TEXT NOT NULL, source_message_id INTEGER NOT NULL, type TEXT NOT NULL, file_id TEXT NOT NULL, file_name TEXT, created_at INTEGER NOT NULL, enabled INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS deletions (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT NOT NULL, message_id INTEGER NOT NULL, delete_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_deletions_due ON deletions(delete_at);
CREATE TABLE IF NOT EXISTS forward_targets (chat_id TEXT PRIMARY KEY, title TEXT, enabled INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS buttons (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, parent_id INTEGER, response_chat_id TEXT, response_message_id INTEGER, sort_order INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1);
CREATE INDEX IF NOT EXISTS idx_buttons_parent ON buttons(parent_id, enabled, sort_order);

INSERT OR IGNORE INTO settings(key,value) VALUES
('bot_name',''),
('welcome_text','خوش آمدید. لطفاً یکی از گزینه‌های زیر را انتخاب کنید.'),
('contact_text','پیام خود را ارسال کنید. سپس انتخاب کنید پیام با هویت شما ارسال شود یا ناشناس.'),
('message_sent_text','پیام شما برای مدیریت ارسال شد.'),
('admin_reply_text','پاسخ جدیدی از مدیریت برای شما ارسال شده است.'),
('blocked_text','دسترسی شما به این بخش محدود شده است.'),
('upload_link_text','فایل شما آماده دریافت است.'),
('invalid_file_text','این لینک معتبر نیست یا فایل دیگر در دسترس نیست.'),
('admin_title','پنل مدیریت'),
('upload_channel_id',''),
('upload_notify_chat_id',''),
('forward_source_channel_id',''),
('auto_delete_minutes','0'),
('contact_enabled','1'),
('uploader_enabled','1'),
('forwarder_enabled','1');
