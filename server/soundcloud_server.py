"""
SoundCloud search server.
Serves SoundCloud track searches.
"""

from flask import Flask, jsonify, request
from flask_cors import CORS
from soundcloud import SoundCloud

app = Flask(__name__)
CORS(app)

@app.route('/api/soundcloud/search')
def search_soundcloud():
    """
    Search SoundCloud for tracks.

    Query parameters:
        query: Search string

    Returns:
        JSON response with search results
    """
    query = request.args.get('query')
    if not query:
        return jsonify({'error': 'Missing query parameter'}), 400

    try:
        client = SoundCloud()
        results = client.search_tracks(query)

        songs = []
        for i, track in enumerate(results):
            if i >= 20:
                break
            songs.append({
                'id': str(track.id) + '_soundcloud',  # Make unique
                'title': track.title,
                'artist': getattr(track.user, 'username', 'Unknown') if hasattr(track, 'user') and track.user else 'Unknown',
                'duration': track.duration,  # in ms
                'url': track.permalink_url,  # Or stream_url if available
                'source': 'soundcloud'
            })

        return jsonify({'songs': songs})

    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/soundcloud/playlist')
def get_playlist_songs():
    """
    Get all songs from a SoundCloud playlist.

    Query parameters:
        url: Playlist sharing link

    Returns:
        JSON response with list of songs ready for download enqueuing
    """
    import subprocess
    import json

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
                    'source': 'soundcloud',
                    'download_link': track.get('webpage_url', track.get('url', '')),
                    'title': title,
                    'artist': artist,
                    'duration': track.get('duration', 0) * 1000 if track.get('duration') else 0,  # Convert to ms
                    'id': str(track.get('id', 'unknown')) + '_soundcloud'
                })
        except json.JSONDecodeError as e:
            return jsonify({'error': f'Failed to parse playlist JSON: {str(e)}'}), 500

        return jsonify({'songs': songs})

    except Exception as e:
        return jsonify({'error': str(e)}), 500

def test_playlist_feature():
    """
    Test function for the playlist feature using the provided test URL.
    """
    import subprocess
    import json

    test_url = "https://soundcloud.com/<user>/sets/<playlist>"

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
                    'source': 'soundcloud',
                    'download_link': track.get('webpage_url', track.get('url', '')),
                    'title': title,
                    'artist': artist,
                    'duration': track.get('duration', 0) * 1000 if track.get('duration') else 0,  # Convert to ms
                    'id': str(track.get('id', 'unknown')) + '_soundcloud'
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
        app.run(debug=True, host='0.0.0.0', port=5001)