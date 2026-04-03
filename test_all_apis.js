const { io } = require('socket.io-client');
const http = require('http');
const crypto = require('crypto');

let TOKEN_A = '';
let TOKEN_B = '';
let USER_A_ID = '';
let USER_B_ID = '';

let passed = 0;
let failed = 0;

function log(test, status, code, body) {
  const icon = status === 'PASS' ? '✅' : '❌';
  console.log(`${icon} ${test} — HTTP ${code}`);
  if (status === 'PASS') passed++;
  else { failed++; console.log('   Response:', JSON.stringify(body)); }
}

function request(method, path, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const req = http.request({
      hostname: 'localhost', port: 3000, path, method, headers
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch (e) { resolve({ status: res.statusCode, body: d }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  console.log('\n🔬 ═══════════════════════════════════════');
  console.log('   NexChat API — Full Integration Test');
  console.log('═══════════════════════════════════════════\n');

  // --- AUTH ---
  console.log('📦 AUTH CONTROLLER');
  console.log('─────────────────────────────────');
  
  const userA = `test_a_${crypto.randomUUID()}`;
  const userB = `test_b_${crypto.randomUUID()}`;

  const r1 = await request('POST', '/api/auth/register', null, { username: userA, password: 'password123' });
  const rB = await request('POST', '/api/auth/register', null, { username: userB, password: 'password123' });
  log('POST /api/auth/register', r1.status === 201 ? 'PASS' : 'FAIL', r1.status, r1.body);

  const r2 = await request('POST', '/api/auth/login', null, { username: userA, password: 'password123' });
  const r2B = await request('POST', '/api/auth/login', null, { username: userB, password: 'password123' });
  log('POST /api/auth/login', r2.status === 200 ? 'PASS' : 'FAIL', r2.status, r2.body);

  if (r2.status === 200 && r2B.status === 200) {
    TOKEN_A = r2.body.data.token;
    USER_A_ID = r2.body.data.user.id;
    TOKEN_B = r2B.body.data.token;
    USER_B_ID = r2B.body.data.user.id;
  } else {
    console.error('FATAL: Could not login to get dynamic tokens. Exiting.');
    process.exit(1);
  }

  // --- USERS ---
  console.log('\n📦 USERS CONTROLLER');
  console.log('─────────────────────────────────');

  const r3 = await request('GET', '/api/users/me', TOKEN_A);
  log('GET  /api/users/me', r3.status === 200 ? 'PASS' : 'FAIL', r3.status, r3.body);

  const r4 = await request('GET', '/api/users', TOKEN_A);
  log('GET  /api/users (list)', r4.status === 200 ? 'PASS' : 'FAIL', r4.status, r4.body);

  const r5 = await request('GET', '/api/users/online', TOKEN_A);
  log('GET  /api/users/online', r5.status === 200 ? 'PASS' : 'FAIL', r5.status, r5.body);

  const r6 = await request('GET', '/api/users/' + USER_B_ID, TOKEN_A);
  log('GET  /api/users/:id', r6.status === 200 ? 'PASS' : 'FAIL', r6.status, r6.body);

  const r7 = await request('PUT', '/api/users/me', TOKEN_A, { username: userA + '_new' });
  log('PUT  /api/users/me', r7.status === 200 ? 'PASS' : 'FAIL', r7.status, r7.body);

  // --- SOCKET.IO REAL-TIME ---
  console.log('\n📦 SOCKET.IO REAL-TIME ENGINE');
  console.log('─────────────────────────────────');

  const sockA = io('http://localhost:3000', { auth: { token: TOKEN_A } });
  const sockB = io('http://localhost:3000', { auth: { token: TOKEN_B } });

  await new Promise(r => sockA.on('connect', r));
  await new Promise(r => sockB.on('connect', r));
  console.log('✅ Socket A connected: ' + sockA.id);
  console.log('✅ Socket B connected: ' + sockB.id);
  passed += 2;

  // Both users join the DM room
  sockA.emit('join_dm', { targetUserId: USER_B_ID });
  sockB.emit('join_dm', { targetUserId: USER_A_ID });
  
  // Wait for rooms to be joined
  await new Promise(r => setTimeout(r, 500));

  // Listen for message on receiver side
  const msgId = crypto.randomUUID();
  const msgPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout waiting for message')), 5000);
    sockB.on('message_received', msg => {
      clearTimeout(timeout);
      resolve(msg);
    });
  });

  sockA.emit('send_message', {
    messageId: msgId,
    receiverId: USER_B_ID,
    content: 'Test message from API test!'
  });

  try {
    const receivedMsg = await msgPromise;
    const msgPass = receivedMsg && receivedMsg.content === 'Test message from API test!';
    log('EMIT send_message → message_received', msgPass ? 'PASS' : 'FAIL', 'WS', receivedMsg);
  } catch (e) {
    log('EMIT send_message → message_received', 'FAIL', 'WS', e.message);
  }

  // --- CHAT ---
  console.log('\n📦 CHAT CONTROLLER');
  console.log('─────────────────────────────────');

  const r8 = await request('GET', '/api/chat/history/' + USER_B_ID, TOKEN_A);
  log('GET  /api/chat/history/:userId', r8.status === 200 ? 'PASS' : 'FAIL', r8.status, r8.body);

  const r9 = await request('GET', '/api/chat/conversations', TOKEN_A);
  log('GET  /api/chat/conversations', r9.status === 200 ? 'PASS' : 'FAIL', r9.status, r9.body);

  const r10 = await request('GET', '/api/chat/unread', TOKEN_B);
  log('GET  /api/chat/unread', r10.status === 200 ? 'PASS' : 'FAIL', r10.status, r10.body);

  const r11 = await request('PUT', '/api/chat/read/' + USER_A_ID, TOKEN_B, {});
  log('PUT  /api/chat/read/:senderId', r11.status === 200 ? 'PASS' : 'FAIL', r11.status, r11.body);

  // Verify unread is now 0
  const r12 = await request('GET', '/api/chat/unread', TOKEN_B);
  const unreadZero = r12.status === 200 && r12.body.data.unreadCount === 0;
  log('GET  /api/chat/unread (verified 0)', unreadZero ? 'PASS' : 'FAIL', r12.status, r12.body);

  // Delete message
  const messageId = r8.body.data?.messages?.[0]?.id;
  if (messageId) {
    const r13 = await request('DELETE', '/api/chat/messages/' + messageId, TOKEN_A);
    log('DEL  /api/chat/messages/:id', r13.status === 200 ? 'PASS' : 'FAIL', r13.status, r13.body);
  } else {
    console.log('⚠️  No message to delete (skipped)');
  }

  // --- MONITORING ---
  console.log('\n📦 MONITORING CONTROLLER');
  console.log('─────────────────────────────────');

  const r14 = await request('GET', '/api/health', TOKEN_A);
  log('GET  /api/health', r14.status === 200 ? 'PASS' : 'FAIL', r14.status, r14.body);

  const r15 = await request('GET', '/api/metrics', TOKEN_A);
  log('GET  /api/metrics', r15.status === 200 ? 'PASS' : 'FAIL', r15.status, r15.body);

  // --- EDGE CASES ---
  console.log('\n📦 ERROR HANDLING (Edge Cases)');
  console.log('─────────────────────────────────');

  const r16 = await request('GET', '/api/users/me', 'invalid_token');
  log('GET  with bad JWT → 401', r16.status === 401 ? 'PASS' : 'FAIL', r16.status, r16.body);

  const r17 = await request('GET', '/api/users/00000000-0000-0000-0000-000000000000', TOKEN_A);
  log('GET  non-existent user → 404', r17.status === 404 ? 'PASS' : 'FAIL', r17.status, r17.body);

  const r18 = await request('DELETE', '/api/chat/messages/00000000-0000-0000-0000-000000000000', TOKEN_A);
  log('DEL  non-existent msg → 404', r18.status === 404 ? 'PASS' : 'FAIL', r18.status, r18.body);

  // --- SUMMARY ---
  sockA.disconnect();
  sockB.disconnect();

  console.log('\n═══════════════════════════════════════════');
  console.log(`   RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
