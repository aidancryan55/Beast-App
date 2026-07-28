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

async function reqForm(path, formData) {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', body: formData });
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

  getFriends: (username) => req(`/users/${encodeURIComponent(username)}/friends`),
  searchUsers: (username, q) => req(`/users/${encodeURIComponent(username)}/search?q=${encodeURIComponent(q)}`),
  sendFriendRequest: (username, targetUsername) =>
    req(`/users/${encodeURIComponent(username)}/friends/request`, { method: 'POST', body: JSON.stringify({ targetUsername }) }),
  respondFriendRequest: (username, requesterUsername, accept) =>
    req(`/users/${encodeURIComponent(username)}/friends/respond`, { method: 'POST', body: JSON.stringify({ requesterUsername, accept }) }),
  removeFriend: (username, targetUsername) =>
    req(`/users/${encodeURIComponent(username)}/friends/remove`, { method: 'POST', body: JSON.stringify({ targetUsername }) }),

  getFeed: (username) => req(`/users/${encodeURIComponent(username)}/feed`),
  createPost: ({ creditedByUsername, subjectUsername, activityKey, points, caption, photo }) => {
    const form = new FormData();
    form.append('creditedByUsername', creditedByUsername);
    form.append('subjectUsername', subjectUsername);
    if (activityKey) form.append('activityKey', activityKey);
    form.append('points', points);
    if (caption) form.append('caption', caption);
    form.append('photo', photo);
    return reqForm('/posts', form);
  },
  reactToPost: (postId, username, emoji) =>
    req(`/posts/${postId}/react`, { method: 'POST', body: JSON.stringify({ username, emoji }) }),
  savePost: (postId, username) =>
    req(`/posts/${postId}/save`, { method: 'POST', body: JSON.stringify({ username }) }),
};
