require('dotenv').config();
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const https = require('https');

// ─── 설정 ───
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const DATA_DIR = path.join(__dirname, 'data');
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

// 참가자 설정
const MEMBERS = [
  { id: 'jjpark', name: 'JJ박', targetTime: '05:30', codeTime: '05:20', reminderTime: '05:40', deadline: '06:30' },
  { id: 'rian', name: '리안', targetTime: '07:00', codeTime: '06:50', reminderTime: '07:10', deadline: '08:00' }
];

// ─── 유틸 ───
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function todayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

function nowKST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
}

function timeToMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

function getDataPath() {
  const today = todayStr();
  const [y, m] = today.split('-');
  return path.join(DATA_DIR, `${y}-${m}.json`);
}

function loadMonthData() {
  const p = getDataPath();
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function saveMonthData(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(getDataPath(), JSON.stringify(data, null, 2), 'utf8');
}

function getTodayRecord() {
  const data = loadMonthData();
  const today = todayStr();
  if (!data[today]) data[today] = {};
  return { data, today };
}

// ─── Telegram API ───
function apiCall(method, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const url = new URL(`${API_BASE}/${method}`);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch { resolve(raw); } });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function sendMessage(text) {
  return apiCall('sendMessage', { chat_id: CHAT_ID, text, parse_mode: 'Markdown' });
}

function getUpdates(offset) {
  return apiCall('getUpdates', { offset, timeout: 30 });
}

// ─── 코어 로직 ───
const activeCodes = {}; // { memberId: { code, sentAt, deadline } }

async function sendCodeForMember(member) {
  const code = generateCode();
  const { data, today } = getTodayRecord();

  activeCodes[member.id] = {
    code,
    sentAt: Date.now(),
    deadline: member.deadline
  };

  if (!data[today][member.id]) {
    data[today][member.id] = { status: 'pending', code, sentAt: new Date().toISOString() };
    saveMonthData(data);
  }

  await sendMessage(`🌅 *${member.name}* 기상 코드: \`${code}\`\n⏰ ${member.deadline}까지 입력하세요!`);
  console.log(`[${nowKST().toLocaleTimeString()}] ${member.name} 코드 발송: ${code}`);
}

async function sendReminder(member) {
  const { data, today } = getTodayRecord();
  const record = data[today]?.[member.id];
  if (record && record.status === 'pending') {
    await sendMessage(`⏰ *${member.name}* 아직 미인증! 코드를 입력해주세요!`);
    console.log(`[${nowKST().toLocaleTimeString()}] ${member.name} 리마인더 발송`);
  }
}

async function checkDeadline(member) {
  const { data, today } = getTodayRecord();
  const record = data[today]?.[member.id];
  if (record && record.status === 'pending') {
    record.status = 'fail';
    record.failedAt = new Date().toISOString();
    saveMonthData(data);
    delete activeCodes[member.id];
    await sendMessage(`❌ *${member.name}* 기상 실패! 마감 시간 초과`);
    console.log(`[${nowKST().toLocaleTimeString()}] ${member.name} 실패 처리`);
  }
}

function verifyCode(memberId, inputCode) {
  const active = activeCodes[memberId];
  if (!active) return null;
  if (active.code !== inputCode) return null;

  const { data, today } = getTodayRecord();
  const record = data[today]?.[memberId];
  if (!record || record.status !== 'pending') return null;

  const member = MEMBERS.find(m => m.id === memberId);
  const now = nowKST();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const codeMin = timeToMinutes(member.codeTime);
  const diff = nowMin - codeMin;

  record.verifiedAt = new Date().toISOString();
  if (diff <= 20) {
    record.status = 'success';
  } else {
    record.status = 'late';
  }
  saveMonthData(data);
  delete activeCodes[memberId];

  return record.status;
}

// ─── 메시지 폴링 ───
let lastUpdateId = 0;

async function pollMessages() {
  try {
    const result = await getUpdates(lastUpdateId + 1);
    if (!result.ok || !result.result) return;

    for (const update of result.result) {
      lastUpdateId = update.update_id;
      const msg = update.message;
      if (!msg || !msg.text || String(msg.chat.id) !== String(CHAT_ID)) continue;

      const text = msg.text.trim();

      // 5글자 코드 매칭 시도
      if (/^[A-Za-z0-9]{5}$/.test(text)) {
        for (const member of MEMBERS) {
          const status = verifyCode(member.id, text);
          if (status === 'success') {
            await sendMessage(`✅ *${member.name}* 기상 성공! 좋은 아침!`);
            console.log(`[${nowKST().toLocaleTimeString()}] ${member.name} 인증 성공`);
          } else if (status === 'late') {
            await sendMessage(`⚠️ *${member.name}* 지각 인증! 그래도 일어났네요 💪`);
            console.log(`[${nowKST().toLocaleTimeString()}] ${member.name} 지각 인증`);
          }
        }
      }

      // 명령어
      if (text === '/status') {
        const { data, today } = getTodayRecord();
        let statusMsg = `📊 *${today} 현황*\n`;
        for (const member of MEMBERS) {
          const r = data[today]?.[member.id];
          const icon = !r ? '⬜' : r.status === 'success' ? '✅' : r.status === 'late' ? '⚠️' : r.status === 'fail' ? '❌' : '⏳';
          statusMsg += `${icon} ${member.name} (목표 ${member.targetTime})\n`;
        }
        await sendMessage(statusMsg);
      }

      if (text === '/streak') {
        let streakMsg = '🔥 *스트릭 현황*\n';
        for (const member of MEMBERS) {
          const streak = calculateStreak(member.id);
          streakMsg += `${member.name}: ${streak}일 연속 성공\n`;
        }
        await sendMessage(streakMsg);
      }
    }
  } catch (e) {
    console.error('Poll error:', e.message);
  }
}

function calculateStreak(memberId) {
  let streak = 0;
  const now = new Date();
  for (let i = 1; i <= 365; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
    const [y, m] = dateStr.split('-');
    const filePath = path.join(DATA_DIR, `${y}-${m}.json`);
    if (!fs.existsSync(filePath)) break;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const record = data[dateStr]?.[memberId];
    if (record && (record.status === 'success' || record.status === 'late')) {
      streak++;
    } else {
      break;
    }
  }
  return streak;
}

// ─── 스케줄러 ───
function setupSchedules() {
  for (const member of MEMBERS) {
    const [cH, cM] = member.codeTime.split(':');
    const [rH, rM] = member.reminderTime.split(':');
    const [dH, dM] = member.deadline.split(':');

    // 코드 발송
    cron.schedule(`${cM} ${cH} * * *`, () => sendCodeForMember(member), { timezone: 'Asia/Seoul' });
    // 리마인더
    cron.schedule(`${rM} ${rH} * * *`, () => sendReminder(member), { timezone: 'Asia/Seoul' });
    // 마감
    cron.schedule(`${dM} ${dH} * * *`, () => checkDeadline(member), { timezone: 'Asia/Seoul' });

    console.log(`[스케줄] ${member.name}: 코드 ${member.codeTime} / 리마인더 ${member.reminderTime} / 마감 ${member.deadline}`);
  }
}

// ─── API 서버 (대시보드용) ───
const http = require('http');

function startApiServer() {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (req.url === '/api/data') {
      // 전체 데이터 반환 (최근 3개월)
      const allData = {};
      if (fs.existsSync(DATA_DIR)) {
        const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json')).sort().slice(-3);
        for (const f of files) {
          const month = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
          Object.assign(allData, month);
        }
      }
      res.end(JSON.stringify({ members: MEMBERS, records: allData }));
    } else if (req.url === '/api/today') {
      const { data, today } = getTodayRecord();
      res.end(JSON.stringify({ date: today, records: data[today] || {} }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });

  server.listen(3737, () => console.log('📊 대시보드 API: http://localhost:3737'));
}

// ─── 시작 ───
async function main() {
  console.log('🌅 미라클모닝 봇 시작!');
  console.log(`Chat ID: ${CHAT_ID}`);

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  startApiServer();
  setupSchedules();

  // 폴링 루프
  console.log('메시지 폴링 시작...');
  while (true) {
    await pollMessages();
  }
}

main().catch(console.error);
