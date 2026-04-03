import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';

// ─── Custom Metrics ───
const loginLatency = new Trend('login_latency', true);
const chatHistoryLatency = new Trend('chat_history_latency', true);
const healthLatency = new Trend('health_latency', true);
const userListLatency = new Trend('user_list_latency', true);
const apiReadLatency = new Trend('api_read_latency', true);
const errorRate = new Rate('errors');
const rateLimitedRate = new Rate('rate_limited');
const reqCount = new Counter('total_requests');

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

// ─── K6 Options: Full staged ramp-up load test ───
export const options = {
  scenarios: {
    // Scenario 1: API read load test (500 concurrent VUs, each with own token)
    api_load: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 50 },   // Ramp up
        { duration: '20s', target: 200 },  // Build to 200
        { duration: '30s', target: 500 },  // Peak at 500 VUs
        { duration: '20s', target: 500 },  // Sustain 500
        { duration: '10s', target: 0 },    // Ramp down
      ],
      exec: 'apiLoadScenario',
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],       // Overall P95 < 500ms
    api_read_latency: ['p(95)<200'],        // API reads P95 < 200ms
    health_latency: ['p(95)<250'],          // Health P95 < 250ms
    errors: ['rate<0.05'],                  // Real errors (non-429) < 5%
  },
};

// ─── Setup: Create test users and return their tokens/IDs ───
// Creates a pool of users so VUs can each get their own rate-limit bucket
export function setup() {
  const password = 'K6TestPass123!';
  const headers = { 'Content-Type': 'application/json' };
  const userPool = [];
  const POOL_SIZE = 50; // 50 unique users → rate limit spread across them

  for (let i = 0; i < POOL_SIZE; i++) {
    const username = `k6_load_${Date.now()}_${i}`;

    // Register
    const regRes = http.post(`${BASE_URL}/api/auth/register`, JSON.stringify({
      username, password,
    }), { headers });

    const body = JSON.parse(regRes.body);
    if (body.data && body.data.token) {
      userPool.push({
        token: body.data.token,
        userId: body.data.user.id,
        username,
      });
    }

    // Small delay to avoid overwhelming setup
    sleep(0.05);
  }

  if (userPool.length === 0) {
    console.error('Setup FAILED: Could not create any test users');
    return { userPool: [], password };
  }

  console.log(`Setup complete: Created ${userPool.length} test users`);

  return {
    userPool,
    password,
  };
}

// ─── Scenario: API Read Load Test (500 VUs) ───
// Tests all authenticated read endpoints under peak concurrent load.
// Each VU picks from a pool of users to spread rate-limit buckets.
export function apiLoadScenario(data) {
  if (!data.userPool || data.userPool.length === 0) return;

  // Each VU picks a user from the pool (round-robin by VU id)
  const user = data.userPool[__VU % data.userPool.length];
  const otherUser = data.userPool[(__VU + 1) % data.userPool.length];

  const authHeaders = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${user.token}`,
  };

  // ─── 1. Health Check ───
  group('Health Check', () => {
    const res = http.get(`${BASE_URL}/api/health`);
    healthLatency.add(res.timings.duration);
    reqCount.add(1);

    if (res.status === 429) {
      rateLimitedRate.add(1);
    } else {
      rateLimitedRate.add(0);
      apiReadLatency.add(res.timings.duration);
      const ok = check(res, {
        'health status 200': (r) => r.status === 200,
        'health body HEALTHY': (r) => r.body.includes('HEALTHY'),
      });
      errorRate.add(!ok);
    }
  });

  // ─── 2. Users: GET /me ───
  group('User Endpoints', () => {
    const meRes = http.get(`${BASE_URL}/api/users/me`, { headers: authHeaders });
    reqCount.add(1);

    if (meRes.status === 429) {
      rateLimitedRate.add(1);
    } else {
      rateLimitedRate.add(0);
      apiReadLatency.add(meRes.timings.duration);
      const ok1 = check(meRes, { 'GET /me 200': (r) => r.status === 200 });
      errorRate.add(!ok1);
    }

    // GET /users
    const listRes = http.get(`${BASE_URL}/api/users?page=1&limit=10`, { headers: authHeaders });
    userListLatency.add(listRes.timings.duration);
    reqCount.add(1);

    if (listRes.status === 429) {
      rateLimitedRate.add(1);
    } else {
      rateLimitedRate.add(0);
      apiReadLatency.add(listRes.timings.duration);
      const ok2 = check(listRes, { 'GET /users 200': (r) => r.status === 200 });
      errorRate.add(!ok2);
    }

    // GET /users/online
    const onlineRes = http.get(`${BASE_URL}/api/users/online`, { headers: authHeaders });
    reqCount.add(1);

    if (onlineRes.status === 429) {
      rateLimitedRate.add(1);
    } else {
      rateLimitedRate.add(0);
      apiReadLatency.add(onlineRes.timings.duration);
      const ok3 = check(onlineRes, { 'GET /users/online 200': (r) => r.status === 200 });
      errorRate.add(!ok3);
    }

    // GET /users/:id
    const byIdRes = http.get(`${BASE_URL}/api/users/${otherUser.userId}`, { headers: authHeaders });
    reqCount.add(1);

    if (byIdRes.status === 429) {
      rateLimitedRate.add(1);
    } else {
      rateLimitedRate.add(0);
      apiReadLatency.add(byIdRes.timings.duration);
      const ok4 = check(byIdRes, { 'GET /users/:id 200': (r) => r.status === 200 });
      errorRate.add(!ok4);
    }
  });

  // ─── 3. Chat: History, Conversations, Unread ───
  group('Chat Endpoints', () => {
    const histRes = http.get(`${BASE_URL}/api/chat/history/${otherUser.userId}?limit=20`, { headers: authHeaders });
    chatHistoryLatency.add(histRes.timings.duration);
    reqCount.add(1);

    if (histRes.status === 429) {
      rateLimitedRate.add(1);
    } else {
      rateLimitedRate.add(0);
      apiReadLatency.add(histRes.timings.duration);
      const ok1 = check(histRes, { 'GET /chat/history 200': (r) => r.status === 200 });
      errorRate.add(!ok1);
    }

    const convRes = http.get(`${BASE_URL}/api/chat/conversations`, { headers: authHeaders });
    reqCount.add(1);

    if (convRes.status === 429) {
      rateLimitedRate.add(1);
    } else {
      rateLimitedRate.add(0);
      apiReadLatency.add(convRes.timings.duration);
      const ok2 = check(convRes, { 'GET /conversations 200': (r) => r.status === 200 });
      errorRate.add(!ok2);
    }

    const unreadRes = http.get(`${BASE_URL}/api/chat/unread`, { headers: authHeaders });
    reqCount.add(1);

    if (unreadRes.status === 429) {
      rateLimitedRate.add(1);
    } else {
      rateLimitedRate.add(0);
      apiReadLatency.add(unreadRes.timings.duration);
      const ok3 = check(unreadRes, { 'GET /unread 200': (r) => r.status === 200 });
      errorRate.add(!ok3);
    }
  });

  // ─── 4. Error Boundaries (verify proper error codes under load) ───
  group('Error Handling', () => {
    const badAuthRes = http.get(`${BASE_URL}/api/users/me`, {
      headers: { 'Authorization': 'Bearer invalid.token.here' },
    });
    reqCount.add(1);
    // 401 or 429 are both acceptable responses
    if (badAuthRes.status === 429) {
      rateLimitedRate.add(1);
    } else {
      rateLimitedRate.add(0);
      const ok = check(badAuthRes, { 'bad JWT → 401': (r) => r.status === 401 });
      errorRate.add(!ok);
    }

    const notFoundRes = http.get(`${BASE_URL}/api/users/00000000-0000-0000-0000-000000000000`, {
      headers: authHeaders,
    });
    reqCount.add(1);
    // 404 for missing user, 429 if rate-limited — both are acceptable
    if (notFoundRes.status === 429) {
      rateLimitedRate.add(1);
    } else {
      rateLimitedRate.add(0);
      const ok = check(notFoundRes, { 'missing user → 404': (r) => r.status === 404 });
      errorRate.add(!ok);
    }
  });

  sleep(0.3); // Simulate real user think time
}
