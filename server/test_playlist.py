#!/usr/bin/env python3
"""
Standalone test for SoundCloud playlist extraction
"""
import subprocess
import json

def test_playlist():
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
    test_playlist()