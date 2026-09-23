/**
 * API service for communicating with the backend.
 */

/**
 * Fetch list of songs from server
 * @returns {Promise<Array>} Array of song objects
 */
async function fetchSongs() {
  try {
    const response = await fetch('/api/songs');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data.songs || [];
  } catch (error) {
    console.error('Error fetching songs:', error);
    return [];
  }
}

/**
 * Create a new playlist
 * @param {string} name - Playlist name
 * @returns {Promise<Object>} Playlist object
 */
async function createPlaylist(name) {
  try {
    const response = await fetch('/api/playlists', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name })
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data.playlist;
  } catch (error) {
    console.error('Error creating playlist:', error);
    throw error;
  }
}

/**
 * Get playlists
 * @returns {Promise<Array>} Array of playlists
 */
async function fetchPlaylists() {
  try {
    const response = await fetch('/api/playlists');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data.playlists || [];
  } catch (error) {
    console.error('Error fetching playlists:', error);
    return [];
  }
}

/**
 * Download a Spotify track, album, or playlist using votify
 * @param {string} url - Spotify URL to download
 * @returns {Promise<Object>} Download result
 */
async function downloadFromSpotify(url) {
  try {
    const response = await fetch('/api/spotify/download', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url })
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Download failed');
    }
    const result = await response.json();
    return result;
  } catch (error) {
    console.error('Error downloading from Spotify:', error);
    throw error;
  }
}

/**
 * Search for songs on both SoundCloud and Spotify
 * @param {string} query - Search query
 * @returns {Promise<Array>} Array of search result objects
 */
async function searchSongs(query) {
  try {
    const response = await fetch(`/api/search?query=${encodeURIComponent(query)}`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data.results || [];
  } catch (error) {
    console.error('Error searching songs:', error);
    return [];
  }
}

/**
 * Download a track from Spotify or SoundCloud
 * @param {string} url - Track URL
 * @param {string} source - 'spotify' or 'soundcloud'
 * @param {Object} trackData - Optional full track metadata
 * @returns {Promise<Object>} Download result
 */
async function downloadTrack(url, source, trackData = null) {
  try {
    const body = { url, source };

    // Generate a safe filename from track metadata if available
    if (trackData && trackData.title && trackData.artist) {
      const artist = trackData.artist.replace(/[^a-zA-Z0-9\s\-]/g, '').trim();
      const title = trackData.title.replace(/[^a-zA-Z0-9\s\-]/g, '').trim();
      const filename = `${artist} - ${title}.mp3`;
      body.filename = filename;
    }

    if (trackData) {
      body.trackData = trackData;
    }

    const response = await fetch('/api/download', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Download failed');
    }
    return await response.json();
  } catch (error) {
    console.error('Error downloading track:', error);
    throw error;
  }
}

/**
 * Save the current queue state to the server
 * @param {Array} queue - Array of song objects in queue
 * @returns {Promise<Object>} Save result
 */
async function saveQueue(queue) {
  try {
    const response = await fetch('/api/queue/save', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ queue })
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    console.error('Error saving queue:', error);
    throw error;
  }
}

/**
 * Load the queue state from the server
 * @returns {Promise<Array>} Array of queued songs
 */
async function loadQueue() {
  try {
    const response = await fetch('/api/queue/load');
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data.queue || [];
  } catch (error) {
    console.error('Error loading queue:', error);
    return [];
  }
}

/**
 * Save the recently-played history to the server (most recent first, capped at 100).
 * @param {Array} history - Array of song objects
 * @returns {Promise<Object>}
 */
async function saveHistory(history) {
  try {
    const response = await fetch('/api/history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ history })
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error('Error saving history:', error);
    throw error;
  }
}

/**
 * Load the recently-played history from the server.
 * @returns {Promise<Array>} Array of songs, most recent first
 */
async function loadHistory() {
  try {
    const response = await fetch('/api/history');
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    return data.history || [];
  } catch (error) {
    console.error('Error loading history:', error);
    return [];
  }
}

/**
 * Clear the server-side recently-played history.
 * @returns {Promise<Object>}
 */
async function clearHistory() {
  try {
    const response = await fetch('/api/history', { method: 'DELETE' });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error('Error clearing history:', error);
    throw error;
  }
}

/**
 * Persist the resume point: the loaded song id (or null) and position in seconds.
 * @param {number|null} songId
 * @param {number} position - Seconds into the track
 * @returns {Promise<Object>}
 */
async function savePlaybackState(songId, position) {
  try {
    const response = await fetch('/api/playback-state', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ song_id: songId ?? null, position: position || 0 })
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    return await response.json();
  } catch (error) {
    console.error('Error saving playback state:', error);
    throw error;
  }
}

/**
 * Load the resume point from the server.
 * @returns {Promise<{song: Object|null, position: number}>}
 */
async function loadPlaybackState() {
  try {
    const response = await fetch('/api/playback-state');
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    return { song: data.song || null, position: data.position || 0 };
  } catch (error) {
    console.error('Error loading playback state:', error);
    return { song: null, position: 0 };
  }
}

/**
 * Update a song's metadata
 * @param {number} songId - Song ID
 * @param {Object} updates - Fields to update: { title?, artist?, start_time?, end_time? }
 * @returns {Promise<Object>} Updated song object
 */
async function updateSong(songId, updates) {
  try {
    const response = await fetch(`/api/songs/${songId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updates)
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to update song');
    }
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error updating song:', error);
    throw error;
  }
}

/**
 * Add a song to a playlist
 * @param {number} playlistId - Playlist ID
 * @param {number} songId - Song ID
 * @returns {Promise<Object>} Result object
 */
async function addSongToPlaylist(playlistId, songId) {
  try {
    const response = await fetch(`/api/playlists/${playlistId}/songs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ song_id: songId })
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to add song to playlist');
    }
    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error adding song to playlist:', error);
    throw error;
  }
}

/**
 * Remove a song from a playlist
 * @param {number} playlistId - Playlist ID
 * @param {number} songId - Song ID
 * @returns {Promise<Object>} Result object
 */
async function removeSongFromPlaylist(playlistId, songId) {
  try {
    const response = await fetch(`/api/playlists/${playlistId}/songs/${songId}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to remove song from playlist');
    }
    return await response.json();
  } catch (error) {
    console.error('Error removing song from playlist:', error);
    throw error;
  }
}

/**
 * Delete a song from the database
 * @param {number} songId - Song ID
 * @returns {Promise<Object>} Result object
 */
async function deleteSong(songId) {
  try {
    const response = await fetch(`/api/songs/${songId}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to delete song');
    }
    return await response.json();
  } catch (error) {
    console.error('Error deleting song:', error);
    throw error;
  }
}

/**
 * Re-download a song from its original link, replacing the attached file.
 * Used when the wrong audio file got attached to a song.
 * @param {number} songId - Song ID
 * @returns {Promise<Object>} Result object
 */
async function redownloadSong(songId) {
  try {
    const response = await fetch(`/api/songs/${songId}/redownload`, {
      method: 'POST',
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'Failed to re-download song');
    }
    return await response.json();
  } catch (error) {
    console.error('Error re-downloading song:', error);
    throw error;
  }
}

/**
 * Update a playlist's name and/or description
 * @param {number} playlistId
 * @param {Object} updates - { name?, description? }
 * @returns {Promise<Object>} Updated playlist
 */
async function updatePlaylist(playlistId, updates) {
  const response = await fetch(`/api/playlists/${playlistId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates)
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Failed to update playlist');
  }
  return response.json();
}

/**
 * Upload a custom icon for a playlist
 * @param {number} playlistId
 * @param {File} file - Image file (jpg, png, webp, gif)
 * @returns {Promise<Object>} { icon: url }
 */
async function uploadPlaylistIcon(playlistId, file) {
  const formData = new FormData();
  formData.append('file', file);
  const response = await fetch(`/api/playlists/${playlistId}/icon`, {
    method: 'POST',
    body: formData
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Failed to upload icon');
  }
  return response.json();
}

/**
 * Adopt a feeder playlist's cover image as this playlist's icon. The server
 * downloads the feeder's remote cover and stores it locally (as if uploaded),
 * so the icon no longer depends on the external host.
 * @param {number} playlistId
 * @param {number} feederId
 * @returns {Promise<Object>} { icon: url }
 */
async function usePlaylistFeederIcon(playlistId, feederId) {
  const response = await fetch(`/api/playlists/${playlistId}/icon/from-feeder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ feeder_id: feederId })
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Failed to set icon from feeder');
  }
  return response.json();
}

/**
 * Remove the custom icon from a playlist
 * @param {number} playlistId
 * @returns {Promise<Object>}
 */
async function removePlaylistIcon(playlistId) {
  const response = await fetch(`/api/playlists/${playlistId}/icon`, {
    method: 'DELETE'
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Failed to remove icon');
  }
  return response.json();
}

/**
 * Delete a playlist
 * @param {number} playlistId
 * @returns {Promise<Object>}
 */
async function deletePlaylist(playlistId) {
  const response = await fetch(`/api/playlists/${playlistId}`, { method: 'DELETE' });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Failed to delete playlist');
  }
  return response.json();
}

/**
 * Get feeder playlists for a playlist
 * @param {number} playlistId
 * @returns {Promise<Array>}
 */
async function fetchFeeders(playlistId) {
  const response = await fetch(`/api/playlists/${playlistId}/feeders`);
  if (!response.ok) throw new Error('Failed to fetch feeders');
  const data = await response.json();
  return data.feeders || [];
}

/**
 * Add a feeder playlist
 * @param {number} playlistId
 * @param {string} url - YouTube or SoundCloud playlist URL
 * @returns {Promise<Object>} Feeder object
 */
async function addFeeder(playlistId, url) {
  const response = await fetch(`/api/playlists/${playlistId}/feeders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url })
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Failed to add feeder');
  }
  const data = await response.json();
  return data.feeder;
}

/**
 * Remove a feeder playlist
 * @param {number} playlistId
 * @param {number} feederId
 * @returns {Promise<Object>}
 */
async function removeFeeder(playlistId, feederId) {
  const response = await fetch(`/api/playlists/${playlistId}/feeders/${feederId}`, {
    method: 'DELETE'
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Failed to remove feeder');
  }
  return response.json();
}

/**
 * Get the current user's Play-tab feeder playlist ids.
 * These are the playlists drawn from when the playback queue is exhausted.
 * @returns {Promise<number[]>} Array of playlist ids
 */
async function fetchPlayFeeders() {
  try {
    const response = await fetch('/api/play-feeders');
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const data = await response.json();
    return data.feeders || [];
  } catch (error) {
    console.error('Error fetching play feeders:', error);
    return [];
  }
}

/**
 * Designate one of the user's playlists as a Play-tab feeder.
 * @param {number} playlistId
 * @returns {Promise<Object>}
 */
async function addPlayFeeder(playlistId) {
  const response = await fetch('/api/play-feeders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playlist_id: playlistId })
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to add feeder');
  }
  return response.json();
}

/**
 * Remove a playlist from the user's Play-tab feeders.
 * @param {number} playlistId
 * @returns {Promise<Object>}
 */
async function removePlayFeeder(playlistId) {
  const response = await fetch(`/api/play-feeders/${playlistId}`, { method: 'DELETE' });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to remove feeder');
  }
  return response.json();
}

/**
 * Trigger a sync for a playlist
 * @param {number} playlistId
 * @returns {Promise<Object>} Sync result with items
 */
async function triggerSync(playlistId) {
  const response = await fetch(`/api/playlists/${playlistId}/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error || 'Failed to trigger sync');
  }
  return response.json();
}

/**
 * Get sync status for a playlist
 * @param {number} playlistId
 * @returns {Promise<Array>} Sync items
 */
async function fetchSyncStatus(playlistId) {
  const response = await fetch(`/api/playlists/${playlistId}/sync-status`);
  if (!response.ok) throw new Error('Failed to fetch sync status');
  const data = await response.json();
  return data.sync_items || [];
}

/**
 * Log in with username and password. Starts a persistent session cookie.
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{username: string}>}
 * @throws {Error} with the server message on invalid credentials
 */
async function login(username, password) {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ username, password })
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || 'Login failed');
  }
  return response.json();
}

/**
 * Log out, clearing the session.
 * @returns {Promise<Object>}
 */
async function logout() {
  const response = await fetch('/api/auth/logout', {
    method: 'POST',
    credentials: 'same-origin'
  });
  return response.json();
}

/**
 * Get the currently logged-in user, or null if not authenticated.
 * @returns {Promise<string|null>} username or null
 */
async function getCurrentUser() {
  const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
  if (response.status === 401) return null;
  if (!response.ok) return null;
  const data = await response.json();
  return data.username || null;
}

/**
 * Record a listen (a track played for more than 30 seconds).
 * Fire-and-forget: a failure here must never disturb playback.
 * @param {number} songId - Library song id
 * @param {number} seconds - Seconds of the track actually played
 * @returns {Promise<boolean>} True when the server counted the listen
 */
async function logListen(songId, seconds) {
  try {
    const response = await fetch('/api/listens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ song_id: songId, seconds })
    });
    if (!response.ok) return false;
    const data = await response.json();
    return !!data.logged;
  } catch (error) {
    console.warn('Could not log listen:', error);
    return false;
  }
}

/**
 * Fetch the user's evergreens: songs ranked over their last 1000 listens.
 * @param {number} [limit=100] - How many tracks to return
 * @returns {Promise<Array>} Song objects, best first, each with `score` and `listens`
 */
async function fetchEvergreens(limit = 100) {
  try {
    const response = await fetch(`/api/evergreens?limit=${limit}`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    return data.evergreens || [];
  } catch (error) {
    console.error('Error fetching evergreens:', error);
    return [];
  }
}

export {
  fetchSongs, createPlaylist, fetchPlaylists, downloadFromSpotify, searchSongs,
  downloadTrack, saveQueue, loadQueue, saveHistory, loadHistory, clearHistory,
  savePlaybackState, loadPlaybackState, addSongToPlaylist, removeSongFromPlaylist, updateSong, deleteSong,
  redownloadSong,
  updatePlaylist, deletePlaylist, uploadPlaylistIcon, usePlaylistFeederIcon, removePlaylistIcon,
  fetchFeeders, addFeeder, removeFeeder, triggerSync, fetchSyncStatus,
  fetchPlayFeeders, addPlayFeeder, removePlayFeeder,
  login, logout, getCurrentUser,
  logListen, fetchEvergreens
};
