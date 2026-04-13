// GitHub Actions에서 실행: 코드 발송 스크립트
require('dotenv').config();
const https = require('https');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const TARGET = process.argv[2]; // 'jjpark' or 'rian'
const DATA_DIR = path.join(__dirname, 'data');

const MEMBERS = {
  jjpark: { name: 'JJ박', deadline: '05:50' },
  rian: { name: '리안', deadline: '07:20' }
};

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function todayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

function getDataPath() {
  const today = todayStr();
  const [y, m] = today.split('-');
  return path.join(DATA_DIR, `${y}-${m}.json`);
}

function sendMessage(text) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'Markdown' });
    const url = new URL(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    const opts = { hostname: url.hostname, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } };
    const req = https.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  if (!TARGET || !MEMBERS[TARGET]) {
    console.error('Usage: node send-code.js <jjpark|rian>');
    process.exit(1);
  }

  const member = MEMBERS[TARGET];
  const code = generateCode();
  const today = todayStr();

  // 데이터 저장
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const dataPath = getDataPath();
  const data = fs.existsSync(dataPath) ? JSON.parse(fs.readFileSync(dataPath, 'utf8')) : {};
  if (!data[today]) data[today] = {};
  data[today][TARGET] = { status: 'pending', code, sentAt: new Date().toISOString() };
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2), 'utf8');

  // 텔레그램 발송
  const result = await sendMessage(`🌅 *${member.name}* 기상 코드: \`${code}\`\n⏰ ${member.deadline}까지 입력하세요!`);
  console.log(result.ok ? `SUCCESS: ${member.name} 코드 ${code} 발송` : `FAIL: ${result.description}`);
}

main().catch(e => { console.error(e); process.exit(1); });
