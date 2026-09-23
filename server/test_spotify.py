"""Test script for Spotify downloader - placeholder for alternative implementation."""

import os

def test_download():
    """
    Test function for Spotify download using votify.
    """
    import subprocess

    try:
        # Ensure downloads directory exists
        os.makedirs('downloads', exist_ok=True)

        print("Testing Spotify download with votify")
        print("Current directory:", os.getcwd())
        print("Downloads directory:", os.path.join(os.getcwd(), 'downloads'))

        # Test URL (replace with a real Spotify URL for testing)
        test_url = "https://open.spotify.com/track/<track-id>"  # Example

        print(f"Testing download of: {test_url}")

        result = subprocess.run(['votify', '--cookies-path', '../cookies.txt', test_url], cwd='downloads', capture_output=True, text=True)

        if result.returncode == 0:
            print("Download successful!")
            print("Output:", result.stdout)
            # Find all downloaded files recursively
            files = []
            for root, dirs, all_files in os.walk('downloads'):
                rel_root = os.path.relpath(root, 'downloads')
                if rel_root == '.':
                    rel_root = ''
                for file in all_files:
                    if file.endswith(('.mp3', '.m4a', '.webm')):
                        files.append(os.path.join(rel_root, file) if rel_root else file)
            print(f"Downloaded files: {files}")
            # Convert M4A to MP3 if necessary
            converted_files = []
            for file_path in files:
                file = os.path.basename(file_path)
                if file.endswith('.m4a'):
                    src_path = os.path.join('downloads', file_path)
                    mp3_path = src_path.replace('.m4a', '.mp3')
                    convert_result = subprocess.run(['ffmpeg', '-i', src_path, '-acodec', 'libmp3lame', '-ab', '192k', mp3_path], capture_output=True, text=True)
                    if convert_result.returncode == 0:
                        print(f"Converted {file} to MP3")
                        os.remove(src_path)
                        converted_files.append(mp3_path)
                    else:
                        print(f"Failed to convert {file}")
                        converted_files.append(src_path)
                else:
                    converted_files.append(os.path.join('downloads', file_path))
            print(f"Final files: {converted_files}")
        else:
            print("Download failed!")
            print("Error:", result.stderr)
            print("Return code:", result.returncode)

    except Exception as e:
        print(f"Exception: {e}")
        import traceback
        traceback.print_exc()

if __name__ == '__main__':
    test_download()
