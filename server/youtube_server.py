"""
YouTube search server.
Serves YouTube video searches and playlist extraction.
"""

from flask import Flask, jsonify, request
from flask_cors import CORS
import subprocess
import json
import sys
import os

app = Flask(__name__)
CORS(app)

@app.route('/api/youtube/search')
def search_youtube():
    """
    Search YouTube for videos.

    Query parameters:
        query: Search string

    Returns:
        JSON response with search results
    """
    query = request.args.get('query')
    if not query:
        return jsonify({'error': 'Missing query parameter'}), 400

    try:
        # Use yt-dlp to search YouTube
        cmd = [
            'yt-dlp',
            '--dump-json',
            '--flat-playlist',
            f'ytsearch20:{query}'  # Search for 20 results
        ]

        result = subprocess.run(cmd, capture_output=True, text=True)

        if result.returncode != 0:
            return jsonify({'error': f'Search failed: {result.stderr}'}), 500

        # Parse the JSON output (multiple JSON objects, one per line)
        videos = []
        for line in result.stdout.strip().split('\n'):
            if line.strip():
                try:
                    video_data = json.loads(line.strip())
                    videos.append(video_data)
                except json.JSONDecodeError:
                    continue

        songs = []
        for i, video in enumerate(videos):
            if i >= 20:
                break

            # Extract video information
            video_id = video.get('id', '')
            title = video.get('title', 'Unknown')
            uploader = video.get('uploader', 'Unknown')
            duration = video.get('duration', 0) * 1000 if video.get('duration') else 0  # Convert to ms
            webpage_url = video.get('webpage_url', f'https://www.youtube.com/watch?v={video_id}')

            songs.append({
                'id': f"{video_id}_youtube",
                'title': title,
                'artist': uploader,
                'duration': duration,
                'url': webpage_url,
                'source': 'youtube'
            })

        return jsonify({'songs': songs})

    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/youtube/playlist')
def get_playlist_songs():
    """
    Get all songs from a YouTube playlist.

    Query parameters:
        url: Playlist sharing link

    Returns:
        JSON response with list of songs ready for download enqueuing
    """
    playlist_url = request.args.get('url')
    if not playlist_url:
        return jsonify({'error': 'Missing url parameter'}), 400

    try:
        # Use yt-dlp to extract playlist info
        cmd = [
            'yt-dlp',
            '--dump-single-json',
            '--no-download',
            playlist_url
        ]

        result = subprocess.run(cmd, capture_output=True, text=True)

        if result.returncode != 0:
            return jsonify({'error': f'Failed to extract playlist: {result.stderr}'}), 500

        # Parse the single JSON output
        try:
            playlist_data = json.loads(result.stdout.strip())
            tracks = playlist_data.get('entries', [])

            songs = []
            for track in tracks:
                if not track:
                    continue

                # Try multiple possible field names for title and artist
                title = track.get('title') or track.get('fulltitle') or track.get('alt_title') or 'Unknown'
                artist = (track.get('uploader') or track.get('artist') or track.get('creator') or
                         track.get('channel') or 'Unknown')

                songs.append({
                    'source': 'youtube',
                    'download_link': track.get('webpage_url', track.get('url', '')),
                    'title': title,
                    'artist': artist,
                    'duration': track.get('duration', 0) * 1000 if track.get('duration') else 0,  # Convert to ms
                    'id': str(track.get('id', 'unknown')) + '_youtube'
                })
        except json.JSONDecodeError as e:
            return jsonify({'error': f'Failed to parse playlist JSON: {str(e)}'}), 500

        return jsonify({'songs': songs})

    except Exception as e:
        return jsonify({'error': str(e)}), 500

def test_playlist_feature():
    """
    Test function for the playlist feature using a sample YouTube playlist.
    """
    import subprocess
    import json

    test_url = "https://www.youtube.com/playlist?list=<playlist-id>"

    print(f"Testing playlist feature with URL: {test_url}")

    try:
        # Use yt-dlp to extract playlist info
        cmd = [
            'yt-dlp',
            '--dump-single-json',
            '--no-download',
            test_url
        ]

        result = subprocess.run(cmd, capture_output=True, text=True)

        if result.returncode != 0:
            print(f"ERROR: Failed to extract playlist: {result.stderr}")
            return False

        # Parse the single JSON output
        try:
            playlist_data = json.loads(result.stdout.strip())
            tracks = playlist_data.get('entries', [])

            songs = []
            for track in tracks:
                if not track:
                    continue

                # Try multiple possible field names for title and artist
                title = track.get('title') or track.get('fulltitle') or track.get('alt_title') or 'Unknown'
                artist = (track.get('uploader') or track.get('artist') or track.get('creator') or
                         track.get('channel') or 'Unknown')

                song = {
                    'source': 'youtube',
                    'download_link': track.get('webpage_url', track.get('url', '')),
                    'title': title,
                    'artist': artist,
                    'duration': track.get('duration', 0) * 1000 if track.get('duration') else 0,  # Convert to ms
                    'id': str(track.get('id', 'unknown')) + '_youtube'
                }
                songs.append(song)
                print(f"Found song: {song['title']} by {song['artist']}")
        except json.JSONDecodeError as e:
            print(f"Failed to parse playlist JSON: {e}")
            return False

        print(f"\nSuccessfully extracted {len(songs)} songs from playlist")
        return True

    except Exception as e:
        print(f"Test failed with error: {str(e)}")
        return False

if __name__ == '__main__':
    # Run test if called with --test argument
    import sys
    if len(sys.argv) > 1 and sys.argv[1] == '--test':
        success = test_playlist_feature()
        sys.exit(0 if success else 1)
    else:
        app.run(debug=True, host='0.0.0.0', port=5002)