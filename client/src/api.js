const BASE = '/api';
let authToken = null;

function setToken(token) {
  authToken = token;
}

function authHeaders(extra = {}) {
  const headers = { ...extra };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  return headers;
}

async function req(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: authHeaders({ 'Content-Type': 'application/json', ...(options.headers || {}) }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

async function reqForm(path, formData) {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', body: formData, headers: authHeaders() });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export const api = {
  setToken,
  signup: (username, password) => req('/signup', { method: 'POST', body: JSON.stringify({ username, password }) }),
  login: (username, password) => req('/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => req('/logout', { method: 'POST' }),

  getActivities: () => req('/activities'),
  getProgress: (username) => req(`/users/${encodeURIComponent(username)}/progress`),
  toggleActivity: (username, activityKey) =>
    req(`/users/${encodeURIComponent(username)}/toggle`, { method: 'POST', body: JSON.stringify({ activityKey }) }),
  getLeaderboard: () => req('/leaderboard'),

  getFriends: (username) => req(`/users/${encodeURIComponent(username)}/friends`),
  searchUsers: (username, q) => req(`/users/${encodeURIComponent(username)}/search?q=${encodeURIComponent(q)}`),
  sendFriendRequest: (username, targetUsername) =>
    req(`/users/${encodeURIComponent(username)}/friends/request`, { method: 'POST', body: JSON.stringify({ targetUsername }) }),
  respondFriendRequest: (username, requesterUsername, accept) =>
    req(`/users/${encodeURIComponent(username)}/friends/respond`, { method: 'POST', body: JSON.stringify({ requesterUsername, accept }) }),
  removeFriend: (username, targetUsername) =>
    req(`/users/${encodeURIComponent(username)}/friends/remove`, { method: 'POST', body: JSON.stringify({ targetUsername }) }),

  getFeed: (username) => req(`/users/${encodeURIComponent(username)}/feed`),
  createPost: ({ subjectUsername, activityKey, points, caption, photo }) => {
    const form = new FormData();
    form.append('subjectUsername', subjectUsername);
    if (activityKey) form.append('activityKey', activityKey);
    form.append('points', points);
    if (caption) form.append('caption', caption);
    form.append('photo', photo);
    return reqForm('/posts', form);
  },
  reactToPost: (postId, emoji) => req(`/posts/${postId}/react`, { method: 'POST', body: JSON.stringify({ emoji }) }),
  savePost: (postId) => req(`/posts/${postId}/save`, { method: 'POST' }),
};
