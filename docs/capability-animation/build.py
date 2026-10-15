"""Rebuild the narrated 60-second animation on macOS; no third-party packages.

    python3 docs/capability-animation/build.py

Requires Apple's command-line Swift tools and the built-in Samantha voice.
The renderer uses CoreGraphics and AVFoundation. Scratch files go under /private/tmp.
"""
import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent
TEMP = pathlib.Path('/private/tmp/gc-capability-animation')
TEMP.mkdir(parents=True, exist_ok=True)
spec = json.loads((ROOT / 'storyboard.json').read_text())
for i, scene in enumerate(spec['scenes']):
    script = TEMP / f'narration-{i}.txt'
    script.write_text(scene['narration'])
    subprocess.run(['say', '-v', spec['voice'], '-r', str(spec['speechRate']),
                    '-f', str(script), '-o', str(TEMP / f'scene-{i}.aiff')], check=True)

subprocess.run(['swiftc', '-O', '-suppress-warnings', '-module-cache-path',
                str(TEMP / 'swift-cache'), str(ROOT / 'render.swift'),
                '-o', str(TEMP / 'render')], check=True)
for action in ['preview', 'video', 'verify']:
    subprocess.run([str(TEMP / 'render'), str(ROOT), action], check=True)

vtt = ['WEBVTT', '']
for scene in spec['scenes']:
    start = scene['start']
    end = start + 10
    stamp = lambda t: f'{t // 60:02d}:{t % 60:02d}.000'
    vtt.extend([f'{stamp(start)} --> {stamp(end)}', scene['narration'], ''])
(ROOT / 'captions.vtt').write_text('\n'.join(vtt))
print(f'Ready: {ROOT / "capability-security-60s.mp4"}')
