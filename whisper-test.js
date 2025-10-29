import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';

// Load environment variables from the specified .env file
dotenv.config({ path: '/var/www/chatystream/environments/.env' });

// Small check: report whether the key is present (do NOT print the key itself)
const hasKey = Boolean(process.env.OPENAI_API_KEY);
if (!hasKey) {
  console.error('Warning: OPENAI_API_KEY is not set (check /var/www/chatystream/environments/.env)');
} else {
  console.log('OPENAI_API_KEY loaded from dotenv: yes');
}

// Create OpenAI client using API key from environment
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function transcribe(filePath = 'test.mp3') {
  try {
    console.log('cwd:', process.cwd());
    const absPath = path.resolve(filePath);
    console.log('Resolved absolute file path:', absPath);

    if (!fs.existsSync(absPath)) {
      console.error(`File not found: ${absPath}`);
      process.exitCode = 2;
      return;
    }

    const fileStream = fs.createReadStream(absPath);

    // Send file to Whisper (whisper-1)
    const response = await openai.audio.transcriptions.create({
      file: fileStream,
      model: 'whisper-1'
    });

    // Always print the complete response object for debugging
    try {
      console.log('Full Whisper response:', JSON.stringify(response, null, 2));
    } catch (jsonErr) {
      console.log('Full Whisper response (non-serializable):', response);
    }

    // Confirm and print `text` field if present
    if (response && typeof response.text === 'string') {
      console.log('\n=== Transcription text (response.text) ===');
      console.log(response.text);
    } else if (response && response.data && Array.isArray(response.data) && response.data[0] && response.data[0].text) {
      // Some response shapes put text under data[0].text
      console.log('\n=== Transcription text (response.data[0].text) ===');
      console.log(response.data[0].text);
    } else {
      console.log('\nNo `text` field found in the response.');
    }
  } catch (err) {
    console.error('Transcription failed.');

    // Try to extract HTTP status / raw details from common error shapes
    const status = err && (err.status || err.statusCode || (err.response && err.response.status));
    if (status) console.error('HTTP status code:', status);

    // Raw error message / body
    if (err && err.response && err.response.data) {
      console.error('Raw error body:', JSON.stringify(err.response.data, null, 2));
    } else if (err && err.body) {
      console.error('Raw error body:', err.body);
    }

    if (err instanceof Error) console.error('Error message:', err.message);
    else console.error('Error:', String(err));

    process.exitCode = 1;
  }
}

// Allow custom filename via CLI: `node whisper-test.js myfile.mp3`
const inputFile = process.argv[2] || 'test.mp3';
transcribe(inputFile).catch((e) => {
  console.error('Unexpected error:', e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
