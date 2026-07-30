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
  getLeaderboard: () => req('/leaderboard'),

  searchUsers: (username, q) => req(`/users/${encodeURIComponent(username)}/search?q=${encodeURIComponent(q)}`),
  getDiscover: (username) => req(`/users/${encodeURIComponent(username)}/discover`),

  getGroups: (username) => req(`/users/${encodeURIComponent(username)}/groups`),
  discoverGroups: (username, q = '') => req(`/users/${encodeURIComponent(username)}/groups/discover?q=${encodeURIComponent(q)}`),
  createGroup: (name, description) => req('/groups', { method: 'POST', body: JSON.stringify({ name, description }) }),
  getGroup: (groupId, viewerUsername) => req(`/groups/${groupId}?viewerUsername=${encodeURIComponent(viewerUsername)}`),
  joinGroup: (groupId) => req(`/groups/${groupId}/join`, { method: 'POST' }),
  leaveGroup: (groupId) => req(`/groups/${groupId}/leave`, { method: 'POST' }),
  getGroupFeed: (groupId) => req(`/groups/${groupId}/feed`),

  createPost: ({ subjectUsername, activityKey, points, caption, photo, visibility, groupId }) => {
    const form = new FormData();
    form.append('subjectUsername', subjectUsername);
    if (activityKey) form.append('activityKey', activityKey);
    form.append('points', points);
    if (caption) form.append('caption', caption);
    form.append('photo', photo);
    form.append('visibility', visibility || 'public');
    if (groupId) form.append('groupId', groupId);
    return reqForm('/posts', form);
  },
  reactToPost: (postId, emoji) => req(`/posts/${postId}/react`, { method: 'POST', body: JSON.stringify({ emoji }) }),
  savePost: (postId) => req(`/posts/${postId}/save`, { method: 'POST' }),
  creditPost: (postId, points) => req(`/posts/${postId}/credit`, { method: 'POST', body: JSON.stringify({ points }) }),
};
