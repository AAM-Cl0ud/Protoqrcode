import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const htmlPath = join(root, 'index.html');
const outputDir = join(root, 'assets', 'voiceover');
const sampleRate = 24000;
const channels = 1;
const bitsPerSample = 16;

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('GEMINI_API_KEY manquant. Exemple: GEMINI_API_KEY=... node scripts/generate-voiceover.mjs');
  process.exit(1);
}

const html = await readFile(htmlPath, 'utf8');
const narrations = [...html.matchAll(/narration:\s*("(?:(?:\\.)|[^"\\])*")/g)]
  .map((match, index) => ({
    file: `step-${index + 1}.wav`,
    text: JSON.parse(match[1]),
    prompt: 'Read this French furniture assembly instruction exactly.',
  }));
const cameraAnswers = [...html.matchAll(/cameraAnswer:\s*("(?:(?:\\.)|[^"\\])*")/g)]
  .map((match, index) => ({
    file: `camera-answer-${index + 1}.wav`,
    text: JSON.parse(match[1]),
    prompt: 'Read this short French spoken answer for an AI camera assistant exactly.',
  }));
const clips = [...narrations, ...cameraAnswers];

if (!clips.length) {
  console.error('Aucun texte audio trouve dans index.html.');
  process.exit(1);
}

await mkdir(outputDir, { recursive: true });

function wavFromPcm(pcm) {
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function ttsPrompt(text, intro) {
  return [
    intro,
    '[calm, warm, close-mic, natural, premium product demo]',
    '[slightly slow, reassuring, precise, no robotic cadence]',
    '[subtle pauses after each sentence, no advertisement tone]',
    text,
  ].join('\n');
}

for (const clip of clips) {
  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent',
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: ttsPrompt(clip.text, clip.prompt) }],
        }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: 'Despina',
              },
            },
          },
        },
        model: 'gemini-3.1-flash-tts-preview',
      }),
    },
  );

  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Generation ${clip.file} echouee: ${response.status} ${details}`);
  }

  const data = await response.json();
  const base64 = data.candidates?.[0]?.content?.parts?.find((part) => part.inlineData)?.inlineData?.data;
  if (!base64) {
    throw new Error(`Generation ${clip.file} sans audio: ${JSON.stringify(data).slice(0, 500)}`);
  }

  const pcm = Buffer.from(base64, 'base64');
  const target = join(outputDir, clip.file);
  await writeFile(target, wavFromPcm(pcm));
  console.log(`OK ${target}`);
}
