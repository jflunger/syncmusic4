"""
Spotify search module using spotipy library.
Uses Client Credentials flow for authentication.
"""

import spotipy
from spotipy.oauth2 import SpotifyClientCredentials

# Hardcoded Spotify App credentials (replace with your actual values)
CLIENT_ID = "***REMOVED***"
CLIENT_SECRET = "***REMOVED***"

# Global spotipy client instance
_spotify_client = None

def get_spotify_client():
    """
    Get or create Spotify client using Client Credentials.

    Returns:
        spotipy.Spotify: Configured Spotify client
    """
    global _spotify_client

    if _spotify_client is None:
        # Create auth manager
        client_credentials_manager = SpotifyClientCredentials(
            client_id=CLIENT_ID,
            client_secret=CLIENT_SECRET
        )

        # Create Spotify client
        _spotify_client = spotipy.Spotify(
            client_credentials_manager=client_credentials_manager
        )

    return _spotify_client

def search_tracks(query, limit=10):
    """
    Search for tracks on Spotify using spotipy.

    Args:
        query (str): Search query
        limit (int): Maximum number of results

    Returns:
        list: List of track dictionaries
    """
    try:
        # Get Spotify client
        sp = get_spotify_client()

        # Search for tracks
        results = sp.search(q=query, type='track', limit=limit)

        tracks = []
        for item in results['tracks']['items']:
            # Extract artist names
            artists = [artist['name'] for artist in item['artists']]
            artist_name = ', '.join(artists) if artists else 'Unknown'

            track = {
                'spotify_url': item['external_urls']['spotify'],
                'name': item['name'],
                'artist': artist_name,
                'duration_ms': item['duration_ms'],
                'album': {
                    'images': item['album']['images']
                }
            }
            tracks.append(track)

        return tracks

    except Exception as e:
        print(f"Error searching Spotify tracks: {e}")
        return []

if __name__ == '__main__':
    # Test the search functionality
    print("Testing Spotify search...")

    # Test search query (using the format from the curl example)
    # query = "never gonna give you up"
    query = "remaster track:Doxy artist:Miles Davis"
    results = search_tracks(query, limit=3)

    if results:
        print(f"Found {len(results)} results for '{query}':")
        for i, track in enumerate(results, 1):
            print(f"{i}. {track['name']} by {track['artist']}")
    else:
        print("No results found. Check your CLIENT_ID and CLIENT_SECRET are properly set.")
