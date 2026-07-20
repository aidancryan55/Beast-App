const BASE = '/api';

async function req(path, options) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const api = {
  createOrGetUser: (username) => req('/users', { method: 'POST', body: JSON.stringify({ username }) }),
  getActivities: () => req('/activities'),
  getProgress: (username) => req(`/users/${encodeURIComponent(username)}/progress`),
  toggleActivity: (username, activityKey) =>
    req(`/users/${encodeURIComponent(username)}/toggle`, { method: 'POST', body: JSON.stringify({ activityKey }) }),
  getLeaderboard: () => req('/leaderboard'),
};
