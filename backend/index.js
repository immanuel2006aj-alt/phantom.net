require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const PORT = process.env.PORT || 3000;

// Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Telegram Bot
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

app.use(cors());
app.use(express.json());

// Helper: notify admin
async function notifyAdmin(message) {
  try {
    await bot.sendMessage(ADMIN_CHAT_ID, message, { parse_mode: 'Markdown' });
  } catch (e) { console.error(e); }
}

// ---------- BOT COMMANDS ----------
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, 
    '🔥 PHANTOM Admin Bot\n' +
    '/stats – show stats\n' +
    '/withdrawals – pending withdrawals\n' +
    '/approve <id> – approve withdrawal\n' +
    '/reject <id> – reject withdrawal'
  );
});

bot.onText(/\/stats/, async (msg) => {
  const { count: users } = await supabase.from('profiles').select('*', { count: 'exact', head: true });
  const { count: sessions } = await supabase.from('sessions').select('*', { count: 'exact', head: true }).is('ended_at', null);
  const { count: pending } = await supabase.from('withdrawals').select('*', { count: 'exact', head: true }).eq('status', 'PENDING');
  bot.sendMessage(msg.chat.id, `📊 Stats\nUsers: ${users}\nActive sessions: ${sessions}\nPending withdrawals: ${pending}`);
});

bot.onText(/\/withdrawals/, async (msg) => {
  const { data } = await supabase.from('withdrawals').select('id, user_id, amount_usd, method, address').eq('status', 'PENDING').limit(10);
  if (!data || data.length === 0) return bot.sendMessage(msg.chat.id, 'No pending withdrawals.');
  let reply = 'Pending:\n';
  data.forEach(w => reply += `#${w.id} | User ${w.user_id.slice(0,8)} | $${w.amount_usd} | ${w.method}\n`);
  bot.sendMessage(msg.chat.id, reply);
});

bot.onText(/\/approve (\d+)/, async (msg, match) => {
  const id = parseInt(match[1]);
  const { data: wd } = await supabase.from('withdrawals').select('*').eq('id', id).eq('status', 'PENDING').single();
  if (!wd) return bot.sendMessage(msg.chat.id, 'Not found or not pending.');
  await supabase.from('withdrawals').update({ status: 'APPROVED', processed_at: new Date() }).eq('id', id);
  bot.sendMessage(msg.chat.id, `✅ Withdrawal #${id} approved. Send funds manually.`);
  await notifyAdmin(`✅ Withdrawal #${id} approved. Amount: $${wd.amount_usd}, address: ${wd.address}`);
});

bot.onText(/\/reject (\d+)/, async (msg, match) => {
  const id = parseInt(match[1]);
  const { data: wd } = await supabase.from('withdrawals').select('*').eq('id', id).eq('status', 'PENDING').single();
  if (!wd) return bot.sendMessage(msg.chat.id, 'Not found or not pending.');
  await supabase.rpc('increment_balance', { user_id: wd.user_id, amount_usd: wd.amount_usd });
  await supabase.from('withdrawals').update({ status: 'REJECTED', processed_at: new Date() }).eq('id', id);
  bot.sendMessage(msg.chat.id, `❌ Withdrawal #${id} rejected. Balance refunded.`);
});

// ---------- API ENDPOINTS ----------
app.post('/api/auth/register', async (req, res) => {
  const { email, password, full_name } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  try {
    const { data: authUser, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
    if (error) throw error;
    const userId = authUser.user.id;
    const refCode = 'REF' + Math.random().toString(36).substring(2,8).toUpperCase();
    await supabase.from('profiles').insert({ id: userId, full_name, email, referral_code: refCode });
    await notifyAdmin(`📝 New user: ${full_name} (${email}) from IP ${ip}`);
    res.json({ success: true, user: { id: userId, email } });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await notifyAdmin(`🔐 Login: ${email} from ${ip}`);
    res.json({ success: true, token: data.session.access_token, user: data.user });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post('/api/session/start', async (req, res) => {
  const { user_id, cpu_limit, device_info } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'];
  try {
    const { data: session, error } = await supabase.from('sessions').insert({
      user_id,
      cpu_limit: cpu_limit || 25,
      device_info,
      ip_address: ip,
      user_agent: userAgent,
    }).select().single();
    if (error) throw error;
    await notifyAdmin(`▶️ Session started for user ${user_id.slice(0,8)}...`);
    res.json({ success: true, session });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/contribution', async (req, res) => {
  const { user_id, hashes } = req.body;
  const amount_usd = (hashes / 1000) * 0.00001;
  try {
    await supabase.from('reward_ledger').insert({
      user_id,
      amount_usd,
      type: 'mining',
      metadata: { hashes }
    });
    await supabase.rpc('increment_balance', { user_id, amount_usd });
    res.json({ success: true, credited: amount_usd });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/withdrawals', async (req, res) => {
  const { user_id, amount_usd, method, address } = req.body;
  if (amount_usd < 2.5) return res.status(400).json({ error: 'Minimum $2.50' });
  const { data: profile } = await supabase.from('profiles').select('balance_usd').eq('id', user_id).single();
  if (!profile || profile.balance_usd < amount_usd) return res.status(400).json({ error: 'Insufficient balance' });
  try {
    const { data: wd, error } = await supabase.from('withdrawals').insert({
      user_id,
      amount_usd,
      method,
      address,
      status: 'PENDING'
    }).select().single();
    if (error) throw error;
    await supabase.rpc('increment_balance', { user_id, amount_usd: -amount_usd });
    await notifyAdmin(`💰 Withdrawal #${wd.id} | $${amount_usd} | ${method} | ${address}`);
    res.json({ success: true, withdrawal: wd });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/support', async (req, res) => {
  const { user_id, subject, description } = req.body;
  await notifyAdmin(`🛟 Support: ${subject} from user ${user_id.slice(0,8)}...`);
  res.json({ success: true });
});

app.get('/api/profile/:id', async (req, res) => {
  const { id } = req.params;
  const { data } = await supabase.from('profiles').select('full_name, email, balance_usd, lifetime_earned, referral_code').eq('id', id).single();
  res.json(data);
});

app.listen(PORT, () => {
  console.log(`🔥 PHANTOM Backend running on port ${PORT}`);
  console.log(`🤖 Telegram bot active.`);
});
