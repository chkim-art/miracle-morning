// GitHub Actions에서 실행: 메시지 확인 + 인증 처리 + 리마인더/마감 처리
require('dotenv').config();
const https = require('https');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const DATA_DIR = path.join(__dirname, 'data');
const OFFSET_FILE = path.join(DATA_DIR, 'last_offset.txt');

const MEMBERS = [
  { id: 'jjpark', name: 'JJ박', codeTime: '05:20', reminderTime: '05:40', deadline: '05:50' },
  { id: 'rian', name: '리안', codeTime: '06:50', reminderTime: '07:10', deadline: '07:20' }
];

function todayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

function nowKST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
}

function timeToMinutes(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }

function getDataPath() {
  const [y, m] = todayStr().split('-');
  return path.join(DATA_DIR, `${y}-${m}.json`);
}

function loadData() {
  const p = getDataPath();
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function saveData(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(getDataPath(), JSON.stringify(data, null, 2), 'utf8');
}

function apiCall(method, body) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(body);
    const url = new URL(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`);
    const opts = { hostname: url.hostname, path: url.pathname, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } };
    const req = https.request(opts, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } }); });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function sendMessage(text) {
  return apiCall('sendMessage', { chat_id: CHAT_ID, text, parse_mode: 'Markdown' });
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const today = todayStr();
  const data = loadData();
  const now = nowKST();
  const nowMin = now.getHours() * 60 + now.getMinutes();

  // 1. 새 메시지 확인 (폴링)
  const lastOffset = fs.existsSync(OFFSET_FILE) ? parseInt(fs.readFileSync(OFFSET_FILE, 'utf8')) : 0;
  const updates = await apiCall('getUpdates', { offset: lastOffset + 1, timeout: 5 });

  if (updates.ok && updates.result.length > 0) {
    let maxOffset = lastOffset;
    for (const update of updates.result) {
      maxOffset = Math.max(maxOffset, update.update_id);
      const msg = update.message;
      if (!msg || !msg.text || String(msg.chat.id) !== String(CHAT_ID)) continue;

      const text = msg.text.trim();

      // 5글자 코드 매칭
      if (/^[A-Za-z0-9]{5}$/.test(text)) {
        for (const member of MEMBERS) {
          const record = data[today]?.[member.id];
          if (record && record.status === 'pending' && record.code === text) {
            const codeMin = timeToMinutes(member.codeTime);
            const diff = nowMin - codeMin;
            record.verifiedAt = new Date().toISOString();
            record.status = diff <= 20 ? 'success' : 'late';
            saveData(data);

            if (record.status === 'success') {
              await sendMessage(`✅ *${member.name}* 기상 성공! 좋은 아침!`);
            } else {
              await sendMessage(`⚠️ *${member.name}* 지각 인증! 그래도 일어났네요 💪`);
            }
            console.log(`${member.name}: ${record.status}`);
          }
        }
      }

      // 명령어
      if (text === '/status') {
        let statusMsg = `📊 *${today} 현황*\n`;
        for (const m of MEMBERS) {
          const r = data[today]?.[m.id];
          const icon = !r ? '⬜' : r.status === 'success' ? '✅' : r.status === 'late' ? '⚠️' : r.status === 'fail' ? '❌' : '⏳';
          statusMsg += `${icon} ${m.name} (목표 ${m.codeTime.replace(':20',':30').replace(':50',':00')})\n`;
        }
        await sendMessage(statusMsg);
      }
    }
    fs.writeFileSync(OFFSET_FILE, String(maxOffset), 'utf8');
  }

  // 2. 리마인더 체크
  for (const member of MEMBERS) {
    const record = data[today]?.[member.id];
    if (!record || record.status !== 'pending') continue;

    const reminderMin = timeToMinutes(member.reminderTime);
    const deadlineMin = timeToMinutes(member.deadline);

    // 리마인더 (±2분 윈도우)
    if (Math.abs(nowMin - reminderMin) <= 2 && !record.reminded) {
      await sendMessage(`⏰ *${member.name}* 아직 미인증! 코드를 입력해주세요!`);
      record.reminded = true;
      saveData(data);
      console.log(`${member.name}: 리마인더 발송`);
    }

    // 마감 처리 (±2분 윈도우)
    if (Math.abs(nowMin - deadlineMin) <= 2) {
      record.status = 'fail';
      record.failedAt = new Date().toISOString();
      saveData(data);
      await sendMessage(`❌ *${member.name}* 기상 실패! 마감 시간 초과`);
      console.log(`${member.name}: 실패 처리`);
    }
  }

  console.log('체크 완료:', new Date().toISOString());
}

main().catch(e => { console.error(e); process.exit(1); });
