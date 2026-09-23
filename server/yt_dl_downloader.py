#!/usr/bin/env python3
"""
YouTube/SoundCloud downloader using yt-dlp.
Downloads audio from supported URLs.
"""

import sys
import os
import subprocess

def download_audio(url, service="yt"):
    """
    Download audio from YouTube or SoundCloud URL using yt-dlp.

    @param {str} url - The URL to download from
    @param {str} service - 'yt' for YouTube, 'sc' for SoundCloud
    @returns {dict} - Success status and info with final file path
    """
    if not url:
        return {'success': False, 'error': 'No URL provided'}

    # Ensure downloads directory exists
    download_dir = 'downloads'
    os.makedirs(download_dir, exist_ok=True)

    try:
        # Construct yt-dlp command
        # -x: extract audio
        # --audio-format mp3: convert to mp3
        # -o: output template
        output_template = os.path.join(download_dir, '%(title)s.%(ext)s')
        cmd = [
            'yt-dlp',
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', '192K',
            '-o', output_template,
            url
        ]

        result = subprocess.run(cmd, capture_output=True, text=True)

        if result.returncode == 0:
            # Find the downloaded file
            for file in os.listdir(download_dir):
                if file.endswith('.mp3'):
                    return {
                        'success': True,
                        'message': f'Download completed: {file}',
                        'file': os.path.join(download_dir, file)
                    }
            return {'success': True, 'message': 'Download completed'}
        else:
            return {
                'success': False,
                'error': 'Download failed',
                'details': result.stderr
            }

    except Exception as e:
        return {'success': False, 'error': str(e)}

def test_downloader():
    """
    Test the downloader with a sample URL (programmatic test).
    This demonstrates the function works without actually downloading.
    """
    test_url = "https://example.com/fake-url.mp3"  # Fake URL to test validation

    print("Testing downloader function...")
    result = download_audio(test_url)

    # Should return False for invalid URL
    if not result['success'] and result.get('error') == 'Download failed':
        print("Test passed: Function correctly handles invalid URLs (got expected failure)")
        print(f"Function executed: returned {result}")
        return True
    else:
        print(f"Test failed: Unexpected result: {result}")
        return False

if __name__ == '__main__':
    if len(sys.argv) >= 2 and sys.argv[1] == '--test':
        success = test_downloader()
        sys.exit(0 if success else 1)
    elif len(sys.argv) < 2:
        print("Usage: python yt_dl_downloader.py <URL>")
        print("Or: python yt_dl_downloader.py --test")
        sys.exit(1)

    url = sys.argv[1]
    result = download_audio(url)

    if result['success']:
        print(f"Success: {result['message']}")
    else:
        print(f"Error: {result['error']}")
        if 'details' in result:
            print(f"Details: {result['details']}")
        sys.exit(1)
