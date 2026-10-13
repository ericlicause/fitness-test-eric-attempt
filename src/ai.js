// Optional Claude features: transcribe a notepad photo, and draft a training
// plan from the coaching summary. Both need ANTHROPIC_API_KEY (or another
// credential the Anthropic SDK can find); the rest of the app works without.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.LIFTLOG_MODEL || 'claude-opus-5-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

let client = null;
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

export function aiEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export class AiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const SCAN_PROMPT = `This is a photo of a handwritten workout log from a notepad. Transcribe it into this plain-text shorthand, one exercise per line:

Exercise name: weight x reps, weight x reps, ...

Rules:
- If a date is written, put it alone on the first line as YYYY-MM-DD (or M/D if no year), followed by any workout title on the same line.
- Keep every set in the order written. Repeat the weight for each set (e.g. "135x8, 135x8, 135x7").
- "Sets x reps" at one weight can be written as "3x10 @ 50".
- Bodyweight sets: "bw x 12". Weighted bodyweight: "bw+25 x 8". Timed sets: "60s".
- Keep units if written (kg/lb). Keep RPE as "@8" right after the set it belongs to.
- Put any comments in parentheses after that exercise's sets, and general notes on a final line starting with "Notes:".
- If something is illegible, make your best guess and add "(?)" after it.

Output only the transcription — no preamble, no code fences.`;

export async function transcribeImage(base64, mediaType) {
  const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
  if (!allowed.includes(mediaType)) throw new AiError(`Unsupported image type ${mediaType}`, 400);

  const response = await call(() => getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 8000,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: SCAN_PROMPT },
      ],
    }],
  }));
  return textOf(response).replace(/^```\w*\n?|```$/g, '').trim();
}

const COACH_SYSTEM = `You are an experienced strength and conditioning coach. You will receive a lifter's training summary computed from their own workout log (sessions, lifts with estimated 1RMs and trends, weekly sets per muscle, rep-range mix, PRs and automated flags).

Write a practical plan for their next 4 weeks:
1. A short read of where they are: what's working, what's holding them back (cite their numbers).
2. A weekly split that fits their current frequency (or one more day if they're under 3/week).
3. For each day: exercises with sets x reps and a starting load or RPE based on their logged numbers, plus the progression rule.
4. How to handle stalled lifts and any muscle-group imbalances in the flags.
5. One or two recovery notes if the data suggests it.

Use plain Markdown with headings and short bullet lists. Be specific with numbers. Don't give medical advice; suggest seeing a professional only if something in the data suggests pain or injury.`;

export async function generatePlan(summary, goals) {
  const userText = goals ? `${summary}\n\nWhat I want from the next block: ${goals}` : summary;
  const message = await call(() => getClient().beta.messages
    .stream({
      model: MODEL,
      max_tokens: 32000,
      betas: [FALLBACK_BETA],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: COACH_SYSTEM,
      messages: [{ role: 'user', content: userText }],
    })
    .finalMessage());
  return textOf(message);
}

async function call(fn) {
  if (!aiEnabled()) {
    throw new AiError('AI features are off. Set ANTHROPIC_API_KEY and restart the server.', 503);
  }
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new AiError('The Anthropic API key was rejected.', 502);
    if (err instanceof Anthropic.RateLimitError) throw new AiError('Rate limited by the Anthropic API — try again in a minute.', 429);
    if (err instanceof Anthropic.BadRequestError) throw new AiError(`Anthropic API rejected the request: ${err.message}`, 400);
    if (err instanceof Anthropic.APIError) throw new AiError(`Anthropic API error: ${err.message}`, 502);
    throw err;
  }
}

function textOf(message) {
  if (message.stop_reason === 'refusal') {
    throw new AiError('The model declined this request.', 422);
  }
  return message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}
