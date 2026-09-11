/* Generic Persian Telegram Bot for Cloudflare Workers + D1.
   Dashboard-first: no runtime dependencies and no Node/Termux required.
*/
const TG=(method,body,env)=>fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(async r=>{const j=await r.json();if(!j.ok) console.error(method,j);return j;});
const now=()=>Math.floor(Date.now()/1000);
const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const btn=(text,data)=>({text,callback_data:data});
const kb=rows=>({inline_keyboard:rows});
const idToken=()=>crypto.randomUUID().replaceAll('-','').slice(0,20);

async function getSetting(env,key,fallback=''){const r=await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first();return r?.value??fallback;}
async function setSetting(env,key,value){await env.DB.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(key,String(value)).run();}
async function send(env,chat,text,extra={}){return TG('sendMessage',{chat_id:chat,text,...extra},env)}
async function copy(env,to,from,msg,extra={}){return TG('copyMessage',{chat_id:to,from_chat_id:from,message_id:msg,...extra},env)}
async function edit(env,chat,msg,text,extra={}){return TG('editMessageText',{chat_id:chat,message_id:msg,text,...extra},env)}
async function del(env,chat,msg){return TG('deleteMessage',{chat_id:chat,message_id:msg},env)}
async function isAdmin(env,uid){const ids=(env.ADMIN_IDS||'').split(',').map(x=>x.trim()).filter(Boolean);if(ids.includes(String(uid)))return true;return !!(await env.DB.prepare('SELECT 1 FROM admins WHERE user_id=? AND enabled=1').bind(String(uid)).first());}
async function isBlocked(env,uid){return !!(await env.DB.prepare('SELECT 1 FROM blocks WHERE user_id=?').bind(String(uid)).first());}
async function session(env,uid){return env.DB.prepare('SELECT * FROM sessions WHERE user_id=?').bind(String(uid)).first();}
async function putSession(env,uid,state,data={}){await env.DB.prepare('INSERT INTO sessions(user_id,state,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET state=excluded.state,data=excluded.data,updated_at=excluded.updated_at').bind(String(uid),state,JSON.stringify(data),now()).run();}
async function clearSession(env,uid){await env.DB.prepare('DELETE FROM sessions WHERE user_id=?').bind(String(uid)).run();}

function media(m){
 if(m.document)return ['document',m.document.file_id,m.document.file_name||''];
 if(m.video)return ['video',m.video.file_id,m.video.file_name||''];
 if(m.audio)return ['audio',m.audio.file_id,m.audio.file_name||''];
 if(m.animation)return ['animation',m.animation.file_id,''];
 if(m.voice)return ['voice',m.voice.file_id,''];
 if(m.video_note)return ['video_note',m.video_note.file_id,''];
 if(m.photo?.length)return ['photo',m.photo.at(-1).file_id,''];
 if(m.sticker)return ['sticker',m.sticker.file_id,''];
 return null;
}

async function userMenu(env,parent=null){
 const r=await env.DB.prepare(parent===null?'SELECT id,label FROM buttons WHERE parent_id IS NULL AND enabled=1 ORDER BY sort_order,id':'SELECT id,label FROM buttons WHERE parent_id=? AND enabled=1 ORDER BY sort_order,id').bind(...(parent===null?[]:[parent])).all();
 const rows=(r.results||[]).map(x=>[btn(x.label,`ub:${x.id}`)]);
 if(parent!==null)rows.push([btn('بازگشت','home')]);
 if(parent===null && (await getSetting(env,'contact_enabled','1'))==='1')rows.push([btn('ارتباط با ما','contact')]);
 return kb(rows);
}

async function start(env,m){
 const p=(m.text||'').split(' ')[1]||'';
 if(p.startsWith('f_'))return fileStart(env,m,p.slice(2));
 if(p==='admin' && await isAdmin(env,m.from.id))return adminHome(env,m.chat.id);
 return send(env,m.chat.id,await getSetting(env,'welcome_text'),{reply_markup:await userMenu(env)});
}

async function contact(env,chat,uid){
 await putSession(env,uid,'contact_choose');
 return send(env,chat,await getSetting(env,'contact_text'),{reply_markup:kb([[btn('با هویت من','contact:known'),btn('ناشناس','contact:anon')],[btn('بازگشت','home')]])});
}

async function adminIds(env){const a=(env.ADMIN_IDS||'').split(',').map(x=>x.trim()).filter(Boolean);const r=await env.DB.prepare('SELECT user_id FROM admins WHERE enabled=1').all();return [...new Set([...a,...(r.results||[]).map(x=>String(x.user_id))])];}

async function notifyAdmins(env,m,anonymous){
 const ids=await adminIds(env);const name=[m.from.first_name,m.from.last_name].filter(Boolean).join(' ');const who=anonymous?'پیام ناشناس':'پیام از کاربر';
 for(const a of ids){
   const header=`${who}${anonymous?'':`\nنام: ${name||'—'}\nنام کاربری: ${m.from.username?`@${m.from.username}`:'—'}\nشناسه: ${m.from.id}`}`;
   const h=await send(env,a,header,{reply_markup:kb([[btn('پاسخ','cr:reply:'+m.from.id),btn('واکنش','cr:react:'+m.from.id+':'+m.message_id),btn('بلاک','cr:block:'+m.from.id)]])});
   const cm=await copy(env,a,m.chat.id,m.message_id);
   await env.DB.prepare('INSERT INTO conversations(user_id,admin_id,anonymous,user_message_id,admin_message_id,created_at) VALUES(?,?,?,?,?,?)').bind(String(m.from.id),String(a),anonymous?1:0,m.message_id,h.result?.message_id||null,now()).run();
   if(cm.result?.message_id)await env.DB.prepare('UPDATE conversations SET admin_message_id=? WHERE user_id=? AND admin_id=? AND user_message_id=?').bind(cm.result.message_id,String(m.from.id),String(a),m.message_id).run();
 }
}

async function handleContactMessage(env,m,s){
 if(!s?.state?.startsWith('contact_'))return false;
 const anonymous=s.state==='contact_anon';
 await notifyAdmins(env,m,anonymous);await clearSession(env,m.from.id);await send(env,m.chat.id,await getSetting(env,'message_sent_text'));return true;
}

async function adminHome(env,chat){
 return send(env,chat,await getSetting(env,'admin_title','پنل مدیریت'),{reply_markup:kb([
  [btn('تنظیمات','a:settings'),btn('متن‌ها','a:texts')],
  [btn('آپلودر','a:upload'),btn('ارسال خودکار','a:forward')],
  [btn('دکمه‌های کاربر','a:buttons'),btn('مدیریت ادمین‌ها','a:admins')],
  [btn('کاربران و آمار','a:stats')]
 ])});
}

const SETS=[['upload_channel_id','شناسه کانال آپلود'],['upload_notify_chat_id','چت دریافت لینک‌های آپلود'],['forward_source_channel_id','شناسه کانال مبدأ ارسال خودکار'],['auto_delete_minutes','زمان حذف خودکار فایل (دقیقه)']];
const TEXTS=[['bot_name','نام نمایشی'],['welcome_text','پیام خوش‌آمد'],['contact_text','متن ارتباط با مدیریت'],['message_sent_text','پیام پس از ارسال کاربر'],['admin_reply_text','متن اعلان پاسخ مدیریت'],['blocked_text','پیام کاربر مسدودشده'],['upload_link_text','متن همراه فایل'],['invalid_file_text','پیام لینک نامعتبر'],['admin_title','عنوان پنل مدیریت']];

async function settingsPage(env,chat){
 let t='⚙️ تنظیمات\n\n';for(const [k,l] of SETS){const v=await getSetting(env,k,'');t+=`${l}: ${v||'تنظیم نشده'}\n`;}
 return send(env,chat,t,{reply_markup:kb([[btn('کانال آپلود','aset:upload_channel_id'),btn('چت لینک‌ها','aset:upload_notify_chat_id')],[btn('کانال مبدأ','aset:forward_source_channel_id'),btn('حذف خودکار','aset:auto_delete_minutes')],[btn('بازگشت','a:home')]])});
}
async function textPage(env,chat){
 let t='✏️ متن‌های قابل تنظیم\n\n';for(const [k,l] of TEXTS)t+=`${l}: ${String(await getSetting(env,k,'')).slice(0,80)}\n`;
 const rows=TEXTS.map(([k,l])=>[btn(l,`atext:${k}`)]);rows.push([btn('بازگشت','a:home')]);return send(env,chat,t,{reply_markup:kb(rows)});
}
async function uploadPage(env,chat){return send(env,chat,'📦 آپلودر\n\nربات از کانال مشخص‌شده فایل دریافت می‌کند، برای هر فایل یک لینک یکتا می‌سازد و لینک را برای چت اعلان می‌فرستد. فایل روی سرور جداگانه ذخیره نمی‌شود و از file_id تلگرام استفاده می‌شود.',{reply_markup:kb([[btn('تنظیم کانال و چت','a:settings')],[btn('بازگشت','a:home')]])});}
async function forwardPage(env,chat){const src=await getSetting(env,'forward_source_channel_id','');const r=await env.DB.prepare('SELECT chat_id,title,enabled FROM forward_targets ORDER BY title,chat_id').all();let t=`📤 ارسال خودکار\n\nمبدأ: ${src||'تنظیم نشده'}\n\nمقصدها:\n`;for(const x of r.results||[])t+=`• ${x.title||x.chat_id} — ${x.enabled?'فعال':'خاموش'}\n`;return send(env,chat,t,{reply_markup:kb([[btn('تنظیم مبدأ','aset:forward_source_channel_id'),btn('افزودن مقصد','f:add')],[btn('مدیریت مقصدها','f:list')],[btn('بازگشت','a:home')]])});}

async function buttonsPage(env,chat,parent=null){
 const r=await env.DB.prepare(parent===null?'SELECT id,label,enabled FROM buttons WHERE parent_id IS NULL ORDER BY sort_order,id':'SELECT id,label,enabled FROM buttons WHERE parent_id=? ORDER BY sort_order,id').bind(...(parent===null?[]:[parent])).all();
 const rows=(r.results||[]).map(x=>[btn(`${x.enabled?'●':'○'} ${x.label}`,`be:${x.id}:${parent??'root'}`)]);
 rows.push([btn('＋ افزودن دکمه','b:add:'+ (parent??'root'))]);if(parent!==null)rows.push([btn('↩ بازگشت','b:root')]);else rows.push([btn('بازگشت','a:home')]);
 return send(env,chat,parent===null?'🧩 دکمه‌های اصلی':'🧩 زیرمجموعه', {reply_markup:kb(rows)});
}
async function adminsPage(env,chat){const r=await env.DB.prepare('SELECT user_id,role,enabled FROM admins ORDER BY user_id').all();let t='👥 ادمین‌ها\n\n';for(const x of r.results||[])t+=`${x.user_id} — ${x.role} — ${x.enabled?'فعال':'خاموش'}\n`;return send(env,chat,t,{reply_markup:kb([[btn('افزودن ادمین','ad:add')],[btn('بازگشت','a:home')]])});}
async function statsPage(env,chat){const u=await env.DB.prepare('SELECT COUNT(*) c FROM users').first();const f=await env.DB.prepare('SELECT COUNT(*) c FROM files WHERE enabled=1').first();const c=await env.DB.prepare('SELECT COUNT(*) c FROM conversations').first();return send(env,chat,`📊 آمار\n\nکاربران: ${u?.c||0}\nفایل‌های فعال: ${f?.c||0}\nپیام‌های ارتباطی: ${c?.c||0}`,{reply_markup:kb([[btn('بازگشت','a:home')]])});}

async function fileStart(env,m,t){const f=await env.DB.prepare('SELECT * FROM files WHERE token=? AND enabled=1').bind(t).first();if(!f)return send(env,m.chat.id,await getSetting(env,'invalid_file_text'));let payload={chat_id:m.chat.id};payload[f.type]=f.file_id;const method={document:'sendDocument',video:'sendVideo',audio:'sendAudio',animation:'sendAnimation',voice:'sendVoice',video_note:'sendVideoNote',photo:'sendPhoto',sticker:'sendSticker'}[f.type];if(!method)return send(env,m.chat.id,'این نوع فایل پشتیبانی نمی‌شود.');const r=await TG(method,{...payload,caption:await getSetting(env,'upload_link_text')},env);const mins=parseInt(await getSetting(env,'auto_delete_minutes','0'),10)||0;if(mins>0&&r.result?.message_id)await env.DB.prepare('INSERT INTO deletions(chat_id,message_id,delete_at) VALUES(?,?,?)').bind(String(m.chat.id),r.result.message_id,now()+mins*60).run();}

async function channelPost(env,m){
 const uploadEnabled=await getSetting(env,'uploader_enabled','1')==='1';const uploadChannel=await getSetting(env,'upload_channel_id','');
 if(uploadEnabled&&uploadChannel&&String(m.chat.id)===String(uploadChannel)){const x=media(m);if(x){const token=idToken();await env.DB.prepare('INSERT INTO files(token,source_chat_id,source_message_id,type,file_id,file_name,created_at) VALUES(?,?,?,?,?,?,?)').bind(token,String(m.chat.id),m.message_id,x[0],x[1],x[2],now()).run();let un=env.BOT_USERNAME;if(!un){const me=await TG('getMe',{},env);un=me.result?.username||'';}const link=`https://t.me/${un}?start=f_${token}`;const notify=await getSetting(env,'upload_notify_chat_id','');if(notify)await send(env,notify,`لینک یکتای فایل:\n${link}`);}}
 const forwardEnabled=await getSetting(env,'forwarder_enabled','1')==='1';const source=await getSetting(env,'forward_source_channel_id','');if(forwardEnabled&&source&&String(m.chat.id)===String(source)){const r=await env.DB.prepare('SELECT chat_id FROM forward_targets WHERE enabled=1').all();for(const x of r.results||[])await copy(env,x.chat_id,m.chat.id,m.message_id);}
}

async function adminInput(env,m,s){const uid=String(m.from.id);if(!s)return false;let d={};try{d=JSON.parse(s.data||'{}')}catch{}
 if(s.state==='reply'){const r=await copy(env,d.user_id,m.chat.id,m.message_id);if(r.ok)await send(env,m.chat.id,'پاسخ ارسال شد.');await clearSession(env,uid);if(r.ok)await send(env,d.user_id,await getSetting(env,'admin_reply_text'));return true;}
 if(s.state==='set_setting'){await setSetting(env,d.key,m.text||'');await clearSession(env,uid);await settingsPage(env,m.chat.id);return true;}
 if(s.state==='set_text'){await setSetting(env,d.key,m.text||'');await clearSession(env,uid);await textPage(env,m.chat.id);return true;}
 if(s.state==='forward_target'){await env.DB.prepare('INSERT INTO forward_targets(chat_id,title,enabled) VALUES(?,?,1) ON CONFLICT(chat_id) DO UPDATE SET enabled=1,title=excluded.title').bind(m.text||'',m.text||'').run();await clearSession(env,uid);return forwardPage(env,m.chat.id);}
 if(s.state==='admin_add'){await env.DB.prepare('INSERT OR REPLACE INTO admins(user_id,role,enabled) VALUES(?,?,1)').bind((m.text||'').trim(),'admin').run();await clearSession(env,uid);return adminsPage(env,m.chat.id);}
 if(s.state==='button_add'){if(!d.label){await putSession(env,uid,'button_add',{parent_id:d.parent_id,label:m.text||''});return send(env,m.chat.id,'حالا پیام پاسخ این دکمه را بفرستید. می‌تواند متن، عکس، فایل یا هر پیام دیگری باشد.');}const r=await env.DB.prepare('INSERT INTO buttons(label,parent_id,response_chat_id,response_message_id,sort_order,enabled) VALUES(?,?,?,?,?,1)').bind(d.label,d.parent_id==='root'?null:d.parent_id,String(m.chat.id),m.message_id,0).run();await clearSession(env,uid);return buttonsPage(env,m.chat.id,d.parent_id==='root'?null:Number(d.parent_id));}
 return false;}

async function callback(env,q){const data=q.data||'',chat=q.message.chat.id,uid=q.from.id;await TG('answerCallbackQuery',{callback_query_id:q.id},env);
 if(data==='home'){await clearSession(env,uid);return send(env,chat,await getSetting(env,'welcome_text'),{reply_markup:await userMenu(env)});}
 if(data==='contact')return contact(env,chat,uid);
 if(data.startsWith('contact:')){await putSession(env,uid,data==='contact:anon'?'contact_anon':'contact_known');return send(env,chat,'حالا پیام خود را ارسال کنید.');}
 if(data.startsWith('ub:')){const id=Number(data.slice(3));const b=await env.DB.prepare('SELECT * FROM buttons WHERE id=? AND enabled=1').bind(id).first();if(!b)return;const ch=await env.DB.prepare('SELECT id,label FROM buttons WHERE parent_id=? AND enabled=1 ORDER BY sort_order,id').bind(id).all();if(b.response_message_id)await copy(env,chat,b.response_chat_id,b.response_message_id);if((ch.results||[]).length)return send(env,chat,'لطفاً یکی از گزینه‌ها را انتخاب کنید.',{reply_markup:await userMenu(env,id)});return;}
 if(!(await isAdmin(env,uid)))return;
 if(data==='a:home')return adminHome(env,chat);if(data==='a:settings')return settingsPage(env,chat);if(data==='a:texts')return textPage(env,chat);if(data==='a:upload')return uploadPage(env,chat);if(data==='a:forward')return forwardPage(env,chat);if(data==='a:buttons')return buttonsPage(env);if(data==='a:admins')return adminsPage(env,chat);if(data==='a:stats')return statsPage(env,chat);
 if(data.startsWith('aset:')){const key=data.slice(5);await putSession(env,uid,'set_setting',{key});return send(env,chat,'مقدار جدید را ارسال کنید.');}
 if(data.startsWith('atext:')){const key=data.slice(6);await putSession(env,uid,'set_text',{key});return send(env,chat,`متن جدید «${key}» را ارسال کنید.`);}
 if(data==='f:add'){await putSession(env,uid,'forward_target');return send(env,chat,'شناسه عددی یا @username مقصد را ارسال کنید.');}
 if(data==='f:list'){const r=await env.DB.prepare('SELECT chat_id,title,enabled FROM forward_targets ORDER BY title,chat_id').all();const rows=(r.results||[]).map(x=>[btn(`${x.enabled?'●':'○'} ${x.title||x.chat_id}`,`ft:${x.chat_id}`)]);rows.push([btn('بازگشت','a:forward')]);return send(env,chat,'مقصدها:',{reply_markup:kb(rows)});}
 if(data.startsWith('ft:')){const cid=data.slice(3);await env.DB.prepare('UPDATE forward_targets SET enabled=CASE enabled WHEN 1 THEN 0 ELSE 1 END WHERE chat_id=?').bind(cid).run();return forwardPage(env,chat);}
 if(data==='ad:add'){await putSession(env,uid,'admin_add');return send(env,chat,'شناسه عددی کاربر را ارسال کنید.');}
 if(data==='b:root')return buttonsPage(env,chat,null);
 if(data.startsWith('b:add:')){const p=data.slice(6);await putSession(env,uid,'button_add',{parent_id:p});return send(env,chat,'نام دکمه را ارسال کنید.');}
 if(data.startsWith('be:')){const [id,p]=data.slice(3).split(':');const b=await env.DB.prepare('SELECT * FROM buttons WHERE id=?').bind(id).first();if(!b)return;return send(env,chat,`دکمه: ${b.label}\nوضعیت: ${b.enabled?'فعال':'خاموش'}`,{reply_markup:kb([[btn(b.enabled?'خاموش کردن':'فعال کردن',`bt:${id}:${p}`)],[btn('افزودن زیرمجموعه',`b:add:${id}`),btn('ویرایش پاسخ',`br:${id}`)],[btn('مشاهده زیرمجموعه','bc:'+id)],[btn('بازگشت','b:root')]])});}
 if(data.startsWith('bt:')){const [id,p]=data.slice(3).split(':');await env.DB.prepare('UPDATE buttons SET enabled=CASE enabled WHEN 1 THEN 0 ELSE 1 END WHERE id=?').bind(id).run();return buttonsPage(env,chat,p==='root'?null:Number(p));}
 if(data.startsWith('bc:'))return buttonsPage(env,chat,Number(data.slice(3)));
 if(data.startsWith('br:')){await putSession(env,uid,'button_replace',{button_id:Number(data.slice(3))});return send(env,chat,'پیام پاسخ جدید را ارسال کنید.');}
 if(data.startsWith('cr:reply:')){await putSession(env,uid,'reply',{user_id:data.slice(9)});return send(env,chat,'پاسخ خود را ارسال کنید. متن، فایل، عکس و سایر پیام‌ها قابل ارسال است.');}
 if(data.startsWith('cr:block:')){const id=data.slice(9);await env.DB.prepare('INSERT OR REPLACE INTO blocks(user_id,created_at,reason) VALUES(?,?,?)').bind(id,now(),'admin').run();return send(env,chat,'کاربر مسدود شد.');}
 if(data.startsWith('cr:react:')){const [id,msg]=data.slice(9).split(':');await putSession(env,uid,'react',{user_id:id,message_id:Number(msg)});return send(env,chat,'یک ایموجی برای واکنش ارسال کنید؛ مثلاً 👍');}
}

async function regularInput(env,m,s){if(!s)return false;const uid=String(m.from.id);if(s.state==='button_replace'){const d=JSON.parse(s.data||'{}');await env.DB.prepare('UPDATE buttons SET response_chat_id=?,response_message_id=? WHERE id=?').bind(String(m.chat.id),m.message_id,d.button_id).run();await clearSession(env,uid);await buttonsPage(env,m.chat.id,null);return true;}if(s.state==='react'){const d=JSON.parse(s.data||'{}');const emoji=(m.text||'👍').trim().slice(0,8);const source=await env.DB.prepare('SELECT user_message_id FROM conversations WHERE user_id=? ORDER BY id DESC LIMIT 1').bind(d.user_id).first();if(source?.user_message_id){await TG('setMessageReaction',{chat_id:d.user_id,message_id:source.user_message_id,reaction:[{type:'emoji',emoji}]},env);}await clearSession(env,uid);return send(env,m.chat.id,'واکنش ارسال شد.');}return false;}

export default {async fetch(request,env){if(request.method!=='POST')return new Response('OK');if(env.WEBHOOK_SECRET){const got=request.headers.get('X-Telegram-Bot-Api-Secret-Token');if(got!==env.WEBHOOK_SECRET)return new Response('forbidden',{status:403});}let u;try{u=await request.json()}catch{return new Response('bad request',{status:400});}try{
 if(u.callback_query){await callback(env,u.callback_query);return new Response('ok');}
 if(u.channel_post){await channelPost(env,u.channel_post);return new Response('ok');}
 const m=u.message;if(!m?.from)return new Response('ok');const uid=String(m.from.id);
 await env.DB.prepare('INSERT INTO users(user_id,username,first_name,last_name,last_seen) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username,first_name=excluded.first_name,last_name=excluded.last_name,last_seen=excluded.last_seen').bind(uid,m.from.username||'',m.from.first_name||'',m.from.last_name||'',now()).run();
 if(await isBlocked(env,uid))return send(env,m.chat.id,await getSetting(env,'blocked_text'));
 if(m.text?.startsWith('/start')){await start(env,m);return new Response('ok');}
 const s=await session(env,uid);
 if(await isAdmin(env,uid)&&s){if(await adminInput(env,m,s))return new Response('ok');if(await regularInput(env,m,s))return new Response('ok');}
 if(s&&await handleContactMessage(env,m,s))return new Response('ok');
 if(await isAdmin(env,uid)&&m.chat.type==='private'){await adminHome(env,m.chat.id);return new Response('ok');}
 return new Response('ok');
 }catch(e){console.error(e);return new Response('ok');}},
 async scheduled(_event,env){const r=await env.DB.prepare('SELECT id,chat_id,message_id FROM deletions WHERE delete_at<=? ORDER BY delete_at LIMIT 100').bind(now()).all();for(const x of r.results||[]){await del(env,x.chat_id,x.message_id);await env.DB.prepare('DELETE FROM deletions WHERE id=?').bind(x.id).run();}}
};
