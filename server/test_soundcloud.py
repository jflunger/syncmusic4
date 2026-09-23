from soundcloud import SoundCloud

client = SoundCloud()
results = client.search_tracks('nirvana')
tracks = []
for i, track in enumerate(results):
    if i >= 5:
        break
    tracks.append(track)

print(f"Retrieved {len(tracks)} tracks")

for track in tracks:
    print(f"Title: {track.title}")
    print(f"Artist: {getattr(track.user, 'username', 'Unknown')}")
    print(f"Duration: {track.duration}")
    print(f"URL: {track.permalink_url}")
    print("---")