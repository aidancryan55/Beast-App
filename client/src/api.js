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
  checkUsernameAvailable: (username) => req(`/username-available?username=${encodeURIComponent(username)}`),
  signupStart: (realName, username, email) =>
    req('/signup/start', { method: 'POST', body: JSON.stringify({ realName, username, email }) }),
  signupResendCode: (email) => req('/signup/resend-code', { method: 'POST', body: JSON.stringify({ email }) }),
  signupVerifyCode: (email, code) => req('/signup/verify-code', { method: 'POST', body: JSON.stringify({ email, code }) }),
  signupFinish: (email, password) => req('/signup/finish', { method: 'POST', body: JSON.stringify({ email, password }) }),
  login: (email, password) => req('/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => req('/logout', { method: 'POST' }),

  getMe: () => req('/me'),
  updateProfile: (realName, bio) => req('/me/profile', { method: 'PATCH', body: JSON.stringify({ realName, bio }) }),
  changePassword: (currentPassword, newPassword) => req('/me/password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
  uploadAvatar: (file) => {
    const form = new FormData();
    form.append('avatar', file, file.name || 'avatar.jpg');
    return reqForm('/me/avatar', form);
  },

  createActivity: (name) => req('/activities', { method: 'POST', body: JSON.stringify({ name }) }),
  getProgress: (displayName) => req(`/users/${encodeURIComponent(displayName)}/progress`),
  getStreak: () => req('/me/streak'),
  getMemories: () => req('/me/memories'),
  getDares: () => req('/me/dares'),
  issueDare: (targetUsername, description, wager) => req('/dares', { method: 'POST', body: JSON.stringify({ targetUsername, description, wager }) }),
  getLeaderboard: () => req('/leaderboard'),

  searchUsers: (displayName, q) => req(`/users/${encodeURIComponent(displayName)}/search?q=${encodeURIComponent(q)}`),
  getDiscover: (displayName) => req(`/users/${encodeURIComponent(displayName)}/discover`),

  getGroups: (displayName) => req(`/users/${encodeURIComponent(displayName)}/groups`),
  discoverGroups: (displayName, q = '') => req(`/users/${encodeURIComponent(displayName)}/groups/discover?q=${encodeURIComponent(q)}`),
  createGroup: (name, description, visibility, password) =>
    req('/groups', { method: 'POST', body: JSON.stringify({ name, description, visibility, password }) }),
  joinGroup: (groupId, password) => req(`/groups/${groupId}/join`, { method: 'POST', body: JSON.stringify({ password }) }),
  cancelGroupRequest: (groupId) => req(`/groups/${groupId}/request`, { method: 'DELETE' }),
  getGroupRequests: (groupId) => req(`/groups/${groupId}/requests`),
  respondToGroupRequest: (groupId, userId, action) =>
    req(`/groups/${groupId}/requests/${userId}/respond`, { method: 'POST', body: JSON.stringify({ action }) }),
  leaveGroup: (groupId) => req(`/groups/${groupId}/leave`, { method: 'POST' }),
  getGroupFeed: (groupId) => req(`/groups/${groupId}/feed`),

  createPost: ({ subjectUsername, subjectDisplayName, activityKey, caption, photo, insetPhoto, extraPhotos, additionalSubjects, visibility, groupId, isAnonymous, dareId, points }) => {
    const form = new FormData();
    form.append('subjectUsername', subjectUsername || '');
    if (subjectDisplayName) form.append('subjectDisplayName', subjectDisplayName);
    form.append('points', points);
    if (activityKey) form.append('activityKey', activityKey);
    if (caption) form.append('caption', caption);
    form.append('photo', photo, photo.name || 'photo.jpg');
    if (insetPhoto) form.append('insetPhoto', insetPhoto, insetPhoto.name || 'inset.jpg');
    for (const extra of extraPhotos || []) form.append('extraPhotos', extra, extra.name || 'photo.jpg');
    for (const name of additionalSubjects || []) form.append('additionalSubjects', name);
    form.append('visibility', visibility || 'public');
    if (groupId) form.append('groupId', groupId);
    if (isAnonymous) form.append('isAnonymous', 'true');
    if (dareId) form.append('dareId', dareId);
    return reqForm('/posts', form);
  },
  reactToPost: (postId, emoji) => req(`/posts/${postId}/react`, { method: 'POST', body: JSON.stringify({ emoji }) }),
  commentOnPost: (postId, body) => req(`/posts/${postId}/comments`, { method: 'POST', body: JSON.stringify({ body }) }),
  savePost: (postId) => req(`/posts/${postId}/save`, { method: 'POST' }),
  creditPost: (postId, points, subjectUsername) => req(`/posts/${postId}/credit`, { method: 'POST', body: JSON.stringify({ points, subjectUsername }) }),
  reportPost: (postId, reason) => req(`/posts/${postId}/report`, { method: 'POST', body: JSON.stringify({ reason }) }),

  getBlockedUsers: () => req('/users/_/blocked'),
  blockUser: (targetUsername) => req('/users/_/block', { method: 'POST', body: JSON.stringify({ targetUsername }) }),
  unblockUser: (targetUsername) => req('/users/_/unblock', { method: 'POST', body: JSON.stringify({ targetUsername }) }),

  getMutedUsers: () => req('/users/_/muted'),
  muteUser: (targetUsername) => req('/users/_/mute', { method: 'POST', body: JSON.stringify({ targetUsername }) }),
  unmuteUser: (targetUsername) => req('/users/_/unmute', { method: 'POST', body: JSON.stringify({ targetUsername }) }),

  getPublicProfile: (username) => req(`/users/${encodeURIComponent(username)}/public-profile`),
  getFriends: () => req('/me/friends'),
  getFriendSuggestions: () => req('/me/friend-suggestions'),
  getFriendRequests: () => req('/me/friend-requests'),
  sendFriendRequest: (targetUsername) => req('/friends/request', { method: 'POST', body: JSON.stringify({ targetUsername }) }),
  respondToFriendRequest: (requestId, action) => req(`/friends/requests/${requestId}/respond`, { method: 'POST', body: JSON.stringify({ action }) }),
  cancelFriendRequest: (requestId) => req(`/friends/requests/${requestId}`, { method: 'DELETE' }),
  removeFriend: (username) => req(`/friends/${encodeURIComponent(username)}`, { method: 'DELETE' }),

  deleteAccount: (password) => req('/account', { method: 'DELETE', body: JSON.stringify({ password }) }),

  getAdminReports: () => req('/admin/reports'),
  resolveReport: (reportId, action) => req(`/admin/reports/${reportId}/resolve`, { method: 'POST', body: JSON.stringify({ action }) }),
};
