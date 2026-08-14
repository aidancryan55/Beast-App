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

async function throwForResponse(res) {
  const body = await res.json().catch(() => ({}));
  const err = new Error(body.error || `Request failed: ${res.status}`);
  err.code = body.code;
  err.status = res.status;
  throw err;
}

async function req(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: authHeaders({ 'Content-Type': 'application/json', ...(options.headers || {}) }),
  });
  if (!res.ok) return throwForResponse(res);
  return res.json();
}

async function reqForm(path, formData) {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', body: formData, headers: authHeaders() });
  if (!res.ok) return throwForResponse(res);
  return res.json();
}

export const api = {
  setToken,
  signupStart: (realName, username, email) =>
    req('/signup/start', { method: 'POST', body: JSON.stringify({ realName, username, email }) }),
  signupResendCode: (email) => req('/signup/resend-code', { method: 'POST', body: JSON.stringify({ email }) }),
  signupVerifyCode: (email, code) => req('/signup/verify-code', { method: 'POST', body: JSON.stringify({ email, code }) }),
  signupFinish: (email, password) => req('/signup/finish', { method: 'POST', body: JSON.stringify({ email, password }) }),
  login: (email, password) => req('/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => req('/logout', { method: 'POST' }),

  createActivity: (name) => req('/activities', { method: 'POST', body: JSON.stringify({ name }) }),
  getProgress: (displayName) => req(`/users/${encodeURIComponent(displayName)}/progress`),
  getStreak: () => req('/me/streak'),
  getMemories: () => req('/me/memories'),
  getDares: () => req('/me/dares'),
  issueDare: (targetUsername, description, wager) => req('/dares', { method: 'POST', body: JSON.stringify({ targetUsername, description, wager }) }),
  getLeaderboard: () => req('/leaderboard'),

  searchUsers: (displayName, q) => req(`/users/${encodeURIComponent(displayName)}/search?q=${encodeURIComponent(q)}`),
  getRandomBeast: () => req('/me/random-beast'),
  getDiscover: (displayName) => req(`/users/${encodeURIComponent(displayName)}/discover`),

  getGroups: (displayName) => req(`/users/${encodeURIComponent(displayName)}/groups`),
  discoverGroups: (displayName, q = '') => req(`/users/${encodeURIComponent(displayName)}/groups/discover?q=${encodeURIComponent(q)}`),
  createGroup: (name, description) => req('/groups', { method: 'POST', body: JSON.stringify({ name, description }) }),
  getGroup: (groupId, viewerDisplayName) => req(`/groups/${groupId}?viewerUsername=${encodeURIComponent(viewerDisplayName)}`),
  joinGroup: (groupId) => req(`/groups/${groupId}/join`, { method: 'POST' }),
  leaveGroup: (groupId) => req(`/groups/${groupId}/leave`, { method: 'POST' }),
  getGroupFeed: (groupId) => req(`/groups/${groupId}/feed`),

  createPost: ({ subjectUsername, subjectDisplayName, activityKey, caption, photo, insetPhoto, visibility, groupId, isAnonymous, dareId, points }) => {
    const form = new FormData();
    form.append('subjectUsername', subjectUsername || '');
    if (subjectDisplayName) form.append('subjectDisplayName', subjectDisplayName);
    form.append('points', points);
    if (activityKey) form.append('activityKey', activityKey);
    if (caption) form.append('caption', caption);
    form.append('photo', photo, photo.name || 'photo.jpg');
    if (insetPhoto) form.append('insetPhoto', insetPhoto, insetPhoto.name || 'inset.jpg');
    form.append('visibility', visibility || 'public');
    if (groupId) form.append('groupId', groupId);
    if (isAnonymous) form.append('isAnonymous', 'true');
    if (dareId) form.append('dareId', dareId);
    return reqForm('/posts', form);
  },
  reactToPost: (postId, emoji) => req(`/posts/${postId}/react`, { method: 'POST', body: JSON.stringify({ emoji }) }),
  commentOnPost: (postId, body) => req(`/posts/${postId}/comments`, { method: 'POST', body: JSON.stringify({ body }) }),
  savePost: (postId) => req(`/posts/${postId}/save`, { method: 'POST' }),
  creditPost: (postId, points) => req(`/posts/${postId}/credit`, { method: 'POST', body: JSON.stringify({ points }) }),
  reportPost: (postId, reason) => req(`/posts/${postId}/report`, { method: 'POST', body: JSON.stringify({ reason }) }),

  getBlockedUsers: () => req('/users/_/blocked'),
  blockUser: (targetUsername) => req('/users/_/block', { method: 'POST', body: JSON.stringify({ targetUsername }) }),
  unblockUser: (targetUsername) => req('/users/_/unblock', { method: 'POST', body: JSON.stringify({ targetUsername }) }),

  deleteAccount: (password) => req('/account', { method: 'DELETE', body: JSON.stringify({ password }) }),

  getAdminReports: () => req('/admin/reports'),
  resolveReport: (reportId, action) => req(`/admin/reports/${reportId}/resolve`, { method: 'POST', body: JSON.stringify({ action }) }),
};
