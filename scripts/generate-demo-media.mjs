import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import ffmpegPath from 'ffmpeg-static';

if (!ffmpegPath) {
  console.error('ffmpeg-static did not provide a binary for this platform.');
  process.exit(1);
}

const output = resolve('samples/generated-media');
mkdirSync(output, { recursive: true });

for (let index = 1; index <= 12; index += 1) {
  const path = join(output, `demo-${String(index).padStart(2, '0')}.mp4`);
  const hue = (index * 29) % 360;
  const args = [
    '-y',
    '-hide_banner',
    '-f', 'lavfi',
    '-i', `testsrc2=size=1920x1080:rate=30:duration=12`,
    '-vf', `hue=h=${hue}:s=0.9,format=yuv420p`,
    '-an',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '22',
    '-movflags', '+faststart',
    path
  ];
  const result = spawnSync(ffmpegPath, args, { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Generated 12 demo clips in ${output}`);
