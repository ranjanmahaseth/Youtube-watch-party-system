/**
 * Unit tests for the pure YouTube helpers.
 *
 * No browser and no test framework: `extractVideoId` only uses `URL`, so plain
 * Node can run it. Run with:  npm test
 */
import { buildWatchUrl, extractVideoId } from '../src/lib/youtube.js';

const ID = 'dQw4w9WgXcQ';

let checks = 0;
let failures = 0;

function check(label, actual, expected) {
  checks += 1;
  if (Object.is(actual, expected)) {
    console.log(`  PASS  ${label}`);
    return;
  }

  failures += 1;
  console.log(`  FAIL  ${label}  (expected ${String(expected)}, got ${String(actual)})`);
}

console.log('\nextractVideoId - accepted formats');

const accepted = [
  ['bare video id', ID],
  ['watch?v=', `https://www.youtube.com/watch?v=${ID}`],
  ['watch?v= with a timestamp', `https://www.youtube.com/watch?v=${ID}&t=42s`],
  ['watch?v= with a playlist', `https://www.youtube.com/watch?v=${ID}&list=PL123&index=2`],
  ['youtu.be short link', `https://youtu.be/${ID}`],
  ['youtu.be with a query', `https://youtu.be/${ID}?t=10`],
  ['youtu.be with a trailing slash', `https://youtu.be/${ID}/`],
  ['/embed/', `https://www.youtube.com/embed/${ID}`],
  ['/shorts/', `https://www.youtube.com/shorts/${ID}`],
  ['/live/', `https://www.youtube.com/live/${ID}`],
  ['legacy /v/', `https://www.youtube.com/v/${ID}`],
  ['mobile host', `https://m.youtube.com/watch?v=${ID}`],
  ['music host', `https://music.youtube.com/watch?v=${ID}`],
  ['nocookie embed', `https://www.youtube-nocookie.com/embed/${ID}`],
  ['www.youtu.be', `https://www.youtu.be/${ID}`],
  ['missing protocol', `youtube.com/watch?v=${ID}`],
  ['missing protocol, short link', `youtu.be/${ID}`],
  ['surrounding whitespace', `   https://youtu.be/${ID}   `],
];

for (const [label, input] of accepted) check(label, extractVideoId(input), ID);

console.log('\nextractVideoId - rejected input');

const rejected = [
  ['empty string', ''],
  ['whitespace only', '   '],
  ['undefined', undefined],
  ['null', null],
  ['a plain sentence', 'definitely not a link'],
  ['a different host', 'https://vimeo.com/123456789'],
  ['youtube root', 'https://www.youtube.com/'],
  ['watch without a v param', 'https://www.youtube.com/watch'],
  ['an id that is too short', `https://www.youtube.com/watch?v=${ID.slice(0, 8)}`],
  ['an id that is too long', `https://www.youtube.com/watch?v=${ID}EXTRA`],
  ['a javascript: url', 'javascript:alert(1)'],
];

for (const [label, input] of rejected) check(label, extractVideoId(input), null);

console.log('\nbuildWatchUrl');
check('builds a canonical watch link', buildWatchUrl(ID), `https://www.youtube.com/watch?v=${ID}`);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
