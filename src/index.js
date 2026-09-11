/**
 * ربات تلگرامی پیشرفته فارسی برای Cloudflare Workers
 * قابلیت‌ها: ارتباط با ادمین، آپلودر فایل، فوروارد خودکار، دکمه‌های سفارشی،
 * پنل تنظیمات کامل، پیام همگانی دسته‌ای، آنتی‌اسپم و ...
 */

const TELEGRAM_API = 'https://api.telegram.org/bot';

async function tg(token, method, body = null) {
  const url = `${TELEGRAM_API}${token}/${method}`;
  const opts = {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'Content-Type': 'application/json' } : {},
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!data.ok) console.error(`TG Error [${method}]:`, data.description || data);
  return data;
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function generateCode(len = 8) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < len; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return code;
}

async function getConfig(kv) {
  const raw = await kv.get('config');
  if (raw) return JSON.parse(raw);
  return {
    welcome: 'سلام! به ربات خوش اومدید 🌟\nاز دکمه‌های زیر استفاده کنید.',
    contactBtn: '📨 ارتباط با ادمین',
    adminContactText: 'پیام خود را بنویسید. ادمین به زودی پاسخ می‌دهد.',
    blockedText: 'شما بلاک شده‌اید و نمی‌توانید از ربات استفاده کنید.',
    antiSpam: { enabled: true, maxMessages: 8, windowSeconds: 60 },
    uploaderChannel: null,
    sourceChannels: [],
    targetGroups: [],
    forceJoinChannels: [],
    forceJoinText: 'برای استفاده از ربات ابتدا در کانال‌های زیر عضو شوید:',
    admins: [],
    buttons: [],
    broadcastBatchSize: 10,
    broadcastDelayMs: 800,
  };
}

async function saveConfig(kv, config) {
  await kv.put('config', JSON.stringify(config));
}

async function isAdmin(kv, userId, envAdmins) {
  const config = await getConfig(kv);
  const envList = (envAdmins || '').split(',').map(s => s.trim()).filter(Boolean);
  return envList.includes(String(userId)) || (config.admins || []).includes(Number(userId));
}

async function isBlocked(kv, userId) {
  return !!(await kv.get(`blocked:${userId}`));
}

async function setBlocked(kv, userId, blocked = true) {
  if (blocked) await kv.put(`blocked:${userId}`, '1');
  else await kv.delete(`blocked:${userId}`);
}

async function addUser(kv, userId) {
  const key = `user:${userId}`;
  if (!(await kv.get(key))) {
    await kv.put(key, JSON.stringify({ id: userId, joined: Date.now() }));
    let list = [];
    const raw = await kv.get('users_list');
    if (raw) list = JSON.parse(raw);
    if (!list.includes(userId)) {
      list.push(userId);
      await kv.put('users_list', JSON.stringify(list));
    }
  }
}

async function getUsersList(kv) {
  const raw = await kv.get('users_list');
  return raw ? JSON.parse(raw) : [];
}

async function getState(kv, userId) {
  const raw = await kv.get(`state:${userId}`);
  return raw ? JSON.parse(raw) : null;
}

async function setState(kv, userId, state) {
  if (state) await kv.put(`state:${userId}`, JSON.stringify(state), { expirationTtl: 3600 });
  else await kv.delete(`state:${userId}`);
}

async function checkAntiSpam(kv, userId, config) {
  if (!config.antiSpam?.enabled) return true;
  const key = `spam:${userId}`;
  const raw = await kv.get(key);
  let times = raw ? JSON.parse(raw) : [];
  const now = Date.now();
  const windowMs = (config.antiSpam.windowSeconds || 60) * 1000;
  times = times.filter(t => now - t < windowMs);
  if (times.length >= (config.antiSpam.maxMessages || 8)) return false;
  times.push(now);
  await kv.put(key, JSON.stringify(times), { expirationTtl: Math.ceil(windowMs / 1000) + 10 });
  return true;
}

function mainUserKeyboard(config) {
  const rows = [];
  if (config.buttons?.length) {
    let row = [];
    for (const btn of config.buttons) {
      row.push({ text: btn.text });
      if (row.length === 2) { rows.push([...row]); row = []; }
    }
    if (row.length) rows.push(row);
  }
  rows.push([{ text: config.contactBtn || '📨 ارتباط با ادمین' }]);
  return { keyboard: rows, resize_keyboard: true };
}

function adminKeyboard() {
  return {
    keyboard: [
      [{ text: '⚙️ تنظیمات' }, { text: '📤 آپلود فایل' }],
      [{ text: '📢 پیام همگانی' }, { text: '📊 آمار' }],
      [{ text: '🚫 مدیریت بلاک' }, { text: '🔙 منوی کاربر' }],
    ],
    resize_keyboard: true,
  };
}

function settingsKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '✏️ متن خوش‌آمد', callback_data: 'set:welcome' }],
      [{ text: '✏️ متن دکمه ارتباط', callback_data: 'set:contactBtn' }],
      [{ text: '✏️ متن پیام به ادمین', callback_data: 'set:adminContactText' }],
      [{ text: '📁 کانال آپلودر', callback_data: 'set:uploaderChannel' }],
      [{ text: '📡 کانال‌های منبع فوروارد', callback_data: 'set:sourceChannels' }],
      [{ text: '👥 گروه‌های هدف فوروارد', callback_data: 'set:targetGroups' }],
      [{ text: '🔒 کانال‌های فورس‌جوین', callback_data: 'set:forceJoin' }],
      [{ text: '🛡️ تنظیمات آنتی‌اسپم', callback_data: 'set:antispam' }],
      [{ text: '🔘 مدیریت دکمه‌های سفارشی', callback_data: 'set:buttons' }],
      [{ text: '👤 مدیریت ادمین‌ها', callback_data: 'set:admins' }],
      [{ text: '📋 نمایش تنظیمات فعلی', callback_data: 'set:show' }],
    ],
  };
}

async function checkForceJoin(token, userId, channels) {
  if (!channels?.length) return true;
  for (const ch of channels) {
    try {
      const res = await tg(token, 'getChatMember', { chat_id: ch, user_id: userId });
      if (!res.ok || !['creator', 'administrator', 'member', 'restricted'].includes(res.result.status)) return false;
    } catch { return false; }
  }
  return true;
}

async function handleFileUpload(token, kv, message, config, adminId) {
  const chatId = message.chat.id;
  if (!config.uploaderChannel) {
    await tg(token, 'sendMessage', { chat_id: chatId, text: '❌ کانال آپلودر تنظیم نشده.' });
    return;
  }
  try {
    const copyRes = await tg(token, 'copyMessage', {
      chat_id: config.uploaderChannel,
      from_chat_id: chatId,
      message_id: message.message_id,
    });
    if (!copyRes.ok) throw new Error(copyRes.description || 'copy failed');
    const code = generateCode(8);
    const fileData = {
      channel_id: config.uploaderChannel,
      message_id: copyRes.result.message_id,
      from_user: adminId,
      date: Date.now(),
      type: message.document ? 'document' : message.photo ? 'photo' : message.video ? 'video' : message.audio ? 'audio' : message.voice ? 'voice' : 'unknown',
    };
    if (message.document) fileData.file_id = message.document.file_id;
    else if (message.photo) fileData.file_id = message.photo[message.photo.length - 1].file_id;
    else if (message.video) fileData.file_id = message.video.file_id;
    else if (message.audio) fileData.file_id = message.audio.file_id;
    else if (message.voice) fileData.file_id = message.voice.file_id;
    await kv.put(`file:${code}`, JSON.stringify(fileData));
    const botInfo = await tg(token, 'getMe');
    const username = botInfo.result?.username || 'Bot';
    const link = `https://t.me/${username}?start=f_${code}`;
    await tg(token, 'sendMessage', {
      chat_id: chatId,
      text: `✅ فایل ذخیره شد!\n\n🔗 لینک یکتا:\n<code>${link}</code>\n\nکد: <code>${code}</code>`,
      parse_mode: 'HTML',
    });
  } catch (e) {
    await tg(token, 'sendMessage', {
      chat_id: chatId,
      text: '❌ خطا در ذخیره فایل. مطمئن شوید ربات ادمین کانال است.\n' + (e.message || ''),
    });
  }
}

async function sendFileByCode(token, kv, chatId, code) {
  const raw = await kv.get(`file:${code}`);
  if (!raw) {
    await tg(token, 'sendMessage', { chat_id: chatId, text: '❌ فایل یافت نشد.' });
    return;
  }
  const fileData = JSON.parse(raw);
  try {
    await tg(token, 'copyMessage', {
      chat_id: chatId,
      from_chat_id: fileData.channel_id,
      message_id: fileData.message_id,
    });
  } catch {
    if (fileData.file_id) {
      const methodMap = { photo: 'sendPhoto', video: 'sendVideo', document: 'sendDocument', audio: 'sendAudio', voice: 'sendVoice' };
      const method = methodMap[fileData.type] || 'sendDocument';
      const field = fileData.type === 'photo' ? 'photo' : fileData.type === 'video' ? 'video' : fileData.type === 'audio' ? 'audio' : fileData.type === 'voice' ? 'voice' : 'document';
      await tg(token, method, { chat_id: chatId, [field]: fileData.file_id });
    } else {
      await tg(token, 'sendMessage', { chat_id: chatId, text: '❌ خطا در ارسال فایل.' });
    }
  }
}

async function doBroadcast(token, kv, config, fromChatId, messageId, adminChatId) {
  const users = await getUsersList(kv);
  if (!users.length) {
    await tg(token, 'sendMessage', { chat_id: adminChatId, text: 'هیچ کاربری ثبت نشده.' });
    return;
  }
  const batchSize = config.broadcastBatchSize || 10;
  const delay = config.broadcastDelayMs || 800;
  let success = 0, fail = 0;
  await tg(token, 'sendMessage', {
    chat_id: adminChatId,
    text: `🚀 شروع ارسال به ${users.length} کاربر (دسته‌های ${batchSize} تایی)...`,
  });
  for (let i = 0; i < users.length; i += batchSize) {
    const batch = users.slice(i, i + batchSize);
    await Promise.all(batch.map(async (uid) => {
      try {
        if (await isBlocked(kv, uid)) return;
        const res = await tg(token, 'copyMessage', { chat_id: uid, from_chat_id: fromChatId, message_id: messageId });
        if (res.ok) success++; else fail++;
      } catch { fail++; }
    }));
    if (i + batchSize < users.length) await new Promise(r => setTimeout(r, delay));
  }
  await tg(token, 'sendMessage', {
    chat_id: adminChatId,
    text: `✅ تمام شد.\nموفق: ${success}\nناموفق: ${fail}`,
  });
}

async function handleUpdate(update, env) {
  const token = env.BOT_TOKEN;
  const kv = env.KV;
  if (!token || !kv) return;

  const config = await getConfig(kv);

  if (update.channel_post) {
    const post = update.channel_post;
    const chatId = post.chat.id;
    if (config.sourceChannels?.includes(chatId) && config.targetGroups?.length) {
      for (const target of config.targetGroups) {
        try {
          await tg(token, 'forwardMessage', { chat_id: target, from_chat_id: chatId, message_id: post.message_id });
        } catch (e) { console.error('Forward error', e); }
      }
    }
    return;
  }

  if (update.callback_query) {
    const cq = update.callback_query;
    const data = cq.data || '';
    const chatId = cq.message.chat.id;
    const userId = cq.from.id;
    const messageId = cq.message.message_id;
    await tg(token, 'answerCallbackQuery', { callback_query_id: cq.id });
    if (!(await isAdmin(kv, userId, env.ADMIN_IDS))) return;

    if (data === 'set:show') {
      const txt = `📋 <b>تنظیمات فعلی:</b>\n\n` +
        `خوش‌آمد: ${escapeHtml((config.welcome || '').slice(0, 80))}...\n` +
        `دکمه ارتباط: ${escapeHtml(config.contactBtn)}\n` +
        `کانال آپلودر: <code>${config.uploaderChannel || 'تنظیم نشده'}</code>\n` +
        `کانال‌های منبع: ${JSON.stringify(config.sourceChannels)}\n` +
        `گروه‌های هدف: ${JSON.stringify(config.targetGroups)}\n` +
        `فورس‌جوین: ${JSON.stringify(config.forceJoinChannels)}\n` +
        `آنتی‌اسپم: ${config.antiSpam?.enabled ? 'فعال' : 'غیرفعال'} (${config.antiSpam?.maxMessages}/${config.antiSpam?.windowSeconds}s)\n` +
        `دکمه‌های سفارشی: ${(config.buttons || []).length}`;
      await tg(token, 'editMessageText', {
        chat_id: chatId, message_id: messageId, text: txt, parse_mode: 'HTML', reply_markup: settingsKeyboard(),
      });
      return;
    }

    if (data.startsWith('set:')) {
      const key = data.slice(4);
      await setState(kv, userId, { mode: 'setting', key });
      let prompt = 'مقدار جدید را ارسال کنید:';
      if (['uploaderChannel', 'sourceChannels', 'targetGroups', 'forceJoin'].includes(key)) {
        prompt = 'آیدی عددی را بفرستید (مثال: -100xxxxxxxxxx).\nچند مورد را با کاما جدا کنید.\nبرای پاک کردن بنویسید: پاک';
      } else if (key === 'antispam') {
        prompt = 'فرمت: enabled,max,window\nمثال: true,8,60\nیا false برای غیرفعال';
      } else if (key === 'buttons') {
        prompt = 'فعلاً برای افزودن دکمه از دستور زیر استفاده کنید:\n/addbtn متن دکمه | پاسخ متنی\nیا /addbtn متن دکمه | file:کدفایل';
      } else if (key === 'admins') {
        prompt = 'آیدی عددی ادمین‌ها را با کاما بفرستید. برای پاک کردن: پاک';
      }
      await tg(token, 'sendMessage', { chat_id: chatId, text: prompt });
      return;
    }
    return;
  }

  if (!update.message) return;
  const msg = update.message;
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = (msg.text || '').trim();
  if (!userId || msg.chat.type !== 'private') return;

  if (await isBlocked(kv, userId)) {
    await tg(token, 'sendMessage', { chat_id: chatId, text: config.blockedText || 'شما بلاک شده‌اید.' });
    return;
  }

  const admin = await isAdmin(kv, userId, env.ADMIN_IDS);
  await addUser(kv, userId);

  if (!admin && !(await checkAntiSpam(kv, userId, config))) {
    await tg(token, 'sendMessage', { chat_id: chatId, text: '⏳ لطفاً کمی صبر کنید (آنتی‌اسپم).' });
    return;
  }

  if (!admin && config.forceJoinChannels?.length) {
    const joined = await checkForceJoin(token, userId, config.forceJoinChannels);
    if (!joined) {
      await tg(token, 'sendMessage', {
        chat_id: chatId,
        text: (config.forceJoinText || 'عضویت اجباری:') + '\n\nبعد از عضویت /start را بزنید.',
      });
      return;
    }
  }

  const state = await getState(kv, userId);

  // تنظیمات
  if (state?.mode === 'setting' && admin) {
    const key = state.key;
    await setState(kv, userId, null);
    if (key === 'welcome') { config.welcome = text; await saveConfig(kv, config); await tg(token, 'sendMessage', { chat_id: chatId, text: '✅ ذخیره شد.' }); }
    else if (key === 'contactBtn') { config.contactBtn = text; await saveConfig(kv, config); await tg(token, 'sendMessage', { chat_id: chatId, text: '✅ ذخیره شد.' }); }
    else if (key === 'adminContactText') { config.adminContactText = text; await saveConfig(kv, config); await tg(token, 'sendMessage', { chat_id: chatId, text: '✅ ذخیره شد.' }); }
    else if (key === 'uploaderChannel') {
      config.uploaderChannel = text === 'پاک' ? null : Number(text.trim());
      await saveConfig(kv, config);
      await tg(token, 'sendMessage', { chat_id: chatId, text: '✅ کانال آپلودر تنظیم شد.' });
    } else if (['sourceChannels', 'targetGroups', 'forceJoin'].includes(key)) {
      const field = key === 'sourceChannels' ? 'sourceChannels' : key === 'targetGroups' ? 'targetGroups' : 'forceJoinChannels';
      config[field] = text === 'پاک' ? [] : text.split(',').map(s => Number(s.trim())).filter(n => !isNaN(n));
      await saveConfig(kv, config);
      await tg(token, 'sendMessage', { chat_id: chatId, text: '✅ تنظیم شد.' });
    } else if (key === 'antispam') {
      if (text.toLowerCase() === 'false') config.antiSpam.enabled = false;
      else {
        const p = text.split(',').map(s => s.trim());
        config.antiSpam.enabled = p[0] === 'true' || p[0] === '1';
        if (p[1]) config.antiSpam.maxMessages = Number(p[1]) || 8;
        if (p[2]) config.antiSpam.windowSeconds = Number(p[2]) || 60;
      }
      await saveConfig(kv, config);
      await tg(token, 'sendMessage', { chat_id: chatId, text: '✅ آنتی‌اسپم تنظیم شد.' });
    } else if (key === 'admins') {
      config.admins = text === 'پاک' ? [] : text.split(',').map(s => Number(s.trim())).filter(n => !isNaN(n));
      await saveConfig(kv, config);
      await tg(token, 'sendMessage', { chat_id: chatId, text: '✅ ادمین‌ها به‌روز شد.' });
    }
    return;
  }

  // دستورات
  if (text === '/start' || text.startsWith('/start ')) {
    const payload = text.slice(7).trim();
    if (payload.startsWith('f_')) {
      await sendFileByCode(token, kv, chatId, payload.slice(2));
      return;
    }
    await tg(token, 'sendMessage', {
      chat_id: chatId,
      text: config.welcome || 'سلام!',
      reply_markup: admin ? adminKeyboard() : mainUserKeyboard(config),
      parse_mode: 'HTML',
    });
    return;
  }

  if (text.startsWith('/addbtn ') && admin) {
    const parts = text.slice(8).split('|').map(s => s.trim());
    if (parts.length >= 2) {
      const btn = { text: parts[0], response: parts[1] };
      if (parts[1].startsWith('file:')) {
        btn.fileCode = parts[1].slice(5);
        btn.response = null;
      }
      config.buttons = config.buttons || [];
      config.buttons.push(btn);
      await saveConfig(kv, config);
      await tg(token, 'sendMessage', { chat_id: chatId, text: `✅ دکمه «${parts[0]}» اضافه شد.` });
    }
    return;
  }

  if (text === '/admin' || text === '⚙️ تنظیمات') {
    if (!admin) return;
    await tg(token, 'sendMessage', {
      chat_id: chatId,
      text: '⚙️ پنل تنظیمات\nیکی را انتخاب کنید:',
      reply_markup: settingsKeyboard(),
    });
    return;
  }

  if (text === '📤 آپلود فایل' && admin) {
    await setState(kv, userId, { mode: 'waiting_file' });
    await tg(token, 'sendMessage', { chat_id: chatId, text: 'فایل را ارسال کنید تا لینک یکتا بسازم.' });
    return;
  }

  if (text === '📢 پیام همگانی' && admin) {
    await setState(kv, userId, { mode: 'broadcast' });
    await tg(token, 'sendMessage', { chat_id: chatId, text: 'پیام همگانی (متن یا مدیا) را بفرستید.' });
    return;
  }

  if (text === '📊 آمار' && admin) {
    const users = await getUsersList(kv);
    await tg(token, 'sendMessage', {
      chat_id: chatId,
      text: `📊 آمار\n\n👥 کاربران: ${users.length}\n📁 آپلودر: ${config.uploaderChannel || '—'}\n📡 منبع: ${(config.sourceChannels || []).length}\n👥 هدف: ${(config.targetGroups || []).length}`,
    });
    return;
  }

  if (text === '🚫 مدیریت بلاک' && admin) {
    await setState(kv, userId, { mode: 'block_manage' });
    await tg(token, 'sendMessage', {
      chat_id: chatId,
      text: 'آیدی کاربر را بفرستید.\nبرای آن‌بلاک: unban آیدی',
    });
    return;
  }

  if (text === '🔙 منوی کاربر') {
    await tg(token, 'sendMessage', {
      chat_id: chatId,
      text: config.welcome || 'منوی اصلی',
      reply_markup: mainUserKeyboard(config),
    });
    return;
  }

  // دکمه‌های سفارشی
  if (config.buttons?.length) {
    const found = config.buttons.find(b => b.text === text);
    if (found) {
      if (found.response) await tg(token, 'sendMessage', { chat_id: chatId, text: found.response, parse_mode: 'HTML' });
      if (found.fileCode) await sendFileByCode(token, kv, chatId, found.fileCode);
      return;
    }
  }

  if (state?.mode === 'waiting_file' && admin && (msg.document || msg.photo || msg.video || msg.audio || msg.voice || msg.animation)) {
    await setState(kv, userId, null);
    await handleFileUpload(token, kv, msg, config, userId);
    return;
  }

  if (state?.mode === 'broadcast' && admin) {
    await setState(kv, userId, null);
    await doBroadcast(token, kv, config, chatId, msg.message_id, chatId);
    return;
  }

  if (state?.mode === 'block_manage' && admin) {
    await setState(kv, userId, null);
    if (text.startsWith('unban ')) {
      const id = Number(text.slice(6).trim());
      if (!isNaN(id)) { await setBlocked(kv, id, false); await tg(token, 'sendMessage', { chat_id: chatId, text: `✅ ${id} آن‌بلاک شد.` }); }
    } else {
      const id = Number(text.trim());
      if (!isNaN(id)) { await setBlocked(kv, id, true); await tg(token, 'sendMessage', { chat_id: chatId, text: `🚫 ${id} بلاک شد.` }); }
      else await tg(token, 'sendMessage', { chat_id: chatId, text: 'آیدی نامعتبر.' });
    }
    return;
  }

  // ارتباط با ادمین
  if (text === (config.contactBtn || '📨 ارتباط با ادمین')) {
    await setState(kv, userId, { mode: 'contacting_admin' });
    await tg(token, 'sendMessage', { chat_id: chatId, text: config.adminContactText || 'پیام خود را بنویسید:' });
    return;
  }

  if (state?.mode === 'contacting_admin' || (!admin && !state)) {
    await setState(kv, userId, null);
    const envAdmins = (env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
    const allAdmins = [...new Set([...envAdmins, ...(config.admins || []).map(String)])];
    const userInfo = `👤 ${escapeHtml(msg.from.first_name || '')} ${escapeHtml(msg.from.last_name || '')}\n🆔 <code>${userId}</code>\n🔗 @${msg.from.username || '—'}\n────────────\n`;
    for (const adm of allAdmins) {
      try {
        await tg(token, 'sendMessage', { chat_id: adm, text: userInfo + 'پیام کاربر:', parse_mode: 'HTML' });
        const copied = await tg(token, 'copyMessage', { chat_id: adm, from_chat_id: chatId, message_id: msg.message_id });
        if (copied.ok) await kv.put(`replymap:${adm}:${copied.result.message_id}`, String(userId), { expirationTtl: 604800 });
      } catch {}
    }
    await tg(token, 'sendMessage', { chat_id: chatId, text: '✅ پیام شما به ادمین ارسال شد.' });
    return;
  }

  // ریپلای ادمین
  if (admin && msg.reply_to_message) {
    const mapKey = `replymap:${chatId}:${msg.reply_to_message.message_id}`;
    const targetUser = await kv.get(mapKey);
    if (targetUser) {
      try {
        await tg(token, 'copyMessage', { chat_id: Number(targetUser), from_chat_id: chatId, message_id: msg.message_id });
        await tg(token, 'sendMessage', { chat_id: chatId, text: '✅ پاسخ ارسال شد.', reply_to_message_id: msg.message_id });
      } catch {
        await tg(token, 'sendMessage', { chat_id: chatId, text: '❌ خطا در ارسال (کاربر شاید ربات را بلاک کرده).' });
      }
      return;
    }
  }

  if (admin) {
    await tg(token, 'sendMessage', { chat_id: chatId, text: 'از منوی ادمین استفاده کنید.', reply_markup: adminKeyboard() });
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'POST') {
      try {
        const update = await request.json();
        ctx.waitUntil(handleUpdate(update, env));
        return new Response('OK');
      } catch (e) {
        console.error(e);
        return new Response('Error', { status: 500 });
      }
    }
    if (request.method === 'GET') {
      const url = new URL(request.url);
      if (url.pathname === '/setwebhook' && env.BOT_TOKEN) {
        const res = await tg(env.BOT_TOKEN, 'setWebhook', {
          url: url.origin,
          allowed_updates: ['message', 'callback_query', 'channel_post'],
          drop_pending_updates: true,
        });
        return new Response(JSON.stringify(res, null, 2), { headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('Persian Telegram Bot on Cloudflare Workers is running.\nGo to /setwebhook to configure.', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    return new Response('Method not allowed', { status: 405 });
  },
};
