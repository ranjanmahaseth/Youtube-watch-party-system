/**
 * Integration smoke test for the room lifecycle (step 1).
 *
 * It boots its own server instance on an isolated port, exercises the REST room
 * endpoints and the join / leave Socket.IO flow, and asserts the important
 * security property: a client cannot become the host without the secret token.
 *
 * Run with:  npm run test:smoke
 */
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { io } from 'socket.io-client';

const PORT = 5055;
const BASE_URL = `http://localhost:${PORT}`;
const ROOM_TTL_MS = 700;
const SAMPLE_VIDEO_ID = 'dQw4w9WgXcQ';
const SECOND_VIDEO_ID = '9bZkp7q19f0';

let checks = 0;
let failures = 0;

function check(label, condition, extra = '') {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${extra ? ` -> ${extra}` : ''}`);
  }
}

async function startServer() {
  const child = spawn(process.execPath, ['src/index.js'], {
    env: { ...process.env, PORT: String(PORT), ROOM_TTL_MS: String(ROOM_TTL_MS) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverLog = '';
  child.stdout.on('data', (chunk) => { serverLog += chunk.toString(); });
  child.stderr.on('data', (chunk) => { serverLog += chunk.toString(); });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}/api/health`);
      if (response.ok) return { child, serverLog: () => serverLog };
    } catch {
      // Server is not up yet.
    }
    await delay(200);
  }

  child.kill();
  throw new Error(`Server did not start in time.\n${serverLog}`);
}

function connectClient() {
  return new Promise((resolve, reject) => {
    const socket = io(BASE_URL, { forceNew: true, reconnection: false });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function join(socket, payload) {
  return new Promise((resolve) => socket.emit('join_room', payload, resolve));
}

function nextEvent(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

/**
 * Waits for the first `sync_state` that satisfies `predicate`, so an unrelated
 * snapshot arriving from an earlier step cannot resolve the wrong assertion.
 */
function waitForSyncMatching(socket, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('sync_state', handler);
    };

    const handler = (state) => {
      if (!predicate(state)) return;
      cleanup();
      resolve(state);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for a matching sync_state'));
    }, timeoutMs);

    socket.on('sync_state', handler);
  });
}

/**
 * Resolves with the payload of the first `event`, or null if it never arrives.
 * Used to prove that something was NOT sent.
 */
function waitForEvent(socket, event, timeoutMs = 400) {
  return new Promise((resolve) => {
    const handler = (payload) => {
      clearTimeout(timer);
      resolve(payload ?? {});
    };

    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve(null);
    }, timeoutMs);

    socket.once(event, handler);
  });
}

async function main() {
  const server = await startServer();
  const sockets = [];

  try {
    console.log('\n1. Create a room over REST');
    const createResponse = await fetch(`${BASE_URL}/api/rooms`, { method: 'POST' });
    const { roomId, hostToken } = await createResponse.json();
    check('responds 201', createResponse.status === 201, String(createResponse.status));
    check('returns a 6 character code', /^[A-Z0-9]{6}$/.test(roomId ?? ''), roomId);
    check('returns a host token', typeof hostToken === 'string' && hostToken.length > 10);

    const lookup = await fetch(`${BASE_URL}/api/rooms/${roomId}`).then((r) => r.json());
    check('room exists with 0 participants', lookup.exists === true && lookup.participantCount === 0);

    console.log('\n2. Creator joins with the secret token and becomes host');
    const host = await connectClient();
    sockets.push(host);
    const hostJoin = await join(host, { roomId, username: 'HostUser', userId: 'user-host', hostToken });
    check('join succeeds', hostJoin.ok === true);
    check('creator role is host', hostJoin.state?.participants?.[0]?.role === 'host');
    check('state never leaks the host token', !JSON.stringify(hostJoin.state).includes(hostToken));

    console.log('\n3. A second user joins and defaults to participant');
    const guest = await connectClient();
    sockets.push(guest);
    const hostSawJoin = nextEvent(host, 'user_joined');
    const guestJoin = await join(guest, { roomId, username: 'GuestUser', userId: 'user-guest' });
    const joinEvent = await hostSawJoin;
    check('join succeeds', guestJoin.ok === true);
    check(
      'guest role is participant',
      guestJoin.state.participants.find((p) => p.userId === 'user-guest')?.role === 'participant',
    );
    check('host is notified of the new user', joinEvent.userId === 'user-guest');

    console.log('\n4. Claiming the host role without the token must fail');
    const impostor = await connectClient();
    sockets.push(impostor);
    // Same length as the real uuid so the comparison itself is exercised.
    const impostorJoin = await join(impostor, {
      roomId,
      username: 'Impostor',
      userId: 'user-impostor',
      hostToken: 'x'.repeat(36),
    });
    check(
      'impostor stays a participant',
      impostorJoin.state.participants.find((p) => p.userId === 'user-impostor')?.role === 'participant',
    );
    check(
      'only one host in the room',
      impostorJoin.state.participants.filter((p) => p.role === 'host').length === 1,
    );

    const countAfterThree = await fetch(`${BASE_URL}/api/rooms/${roomId}`).then((r) => r.json());
    check('participant count is 3', countAfterThree.participantCount === 3, String(countAfterThree.participantCount));

    console.log('\n5. Invalid payload and unknown rooms are rejected');
    const stray = await connectClient();
    sockets.push(stray);
    const unknownRoom = await join(stray, { roomId: 'ZZZZZZ', username: 'Nobody', userId: 'user-stray' });
    check('unknown room -> ROOM_NOT_FOUND', unknownRoom.ok === false && unknownRoom.error === 'ROOM_NOT_FOUND');

    const invalidPayload = await join(stray, { roomId, username: '', userId: '' });
    check('empty payload -> INVALID_PAYLOAD', invalidPayload.ok === false && invalidPayload.error === 'INVALID_PAYLOAD');

    console.log('\n6. Re-joining with the same userId does not duplicate the user');
    const rejoin = await join(guest, { roomId, username: 'GuestUser', userId: 'user-guest' });
    check('still 3 participants', rejoin.state.participants.length === 3, String(rejoin.state.participants.length));

    console.log('\n7. Leaving notifies the room');
    const hostSawLeave = nextEvent(host, 'user_left');
    guest.emit('leave_room');
    const leaveEvent = await hostSawLeave;
    check('host is notified of the leave', leaveEvent.userId === 'user-guest');

    const countAfterLeave = await fetch(`${BASE_URL}/api/rooms/${roomId}`).then((r) => r.json());
    check('participant count drops to 2', countAfterLeave.participantCount === 2, String(countAfterLeave.participantCount));

    console.log('\n8. The room video is shared, but only privileged roles may set it');
    const participantSawVideo = waitForSyncMatching(
      impostor,
      (state) => state.video?.videoId === SAMPLE_VIDEO_ID,
    );
    const hostChange = await emitAck(host, 'change_video', { videoId: SAMPLE_VIDEO_ID });
    check('the host may change the video', hostChange.ok === true, hostChange.error);

    const broadcast = await participantSawVideo;
    check('everyone receives the new video', broadcast.video.videoId === SAMPLE_VIDEO_ID);
    check('the loader is recorded', broadcast.video.loadedBy === 'HostUser', broadcast.video.loadedBy);

    const participantChange = await emitAck(impostor, 'change_video', { videoId: 'aaaaaaaaaaa' });
    check(
      'a participant is refused',
      participantChange.ok === false && participantChange.error === 'FORBIDDEN',
      participantChange.error,
    );

    const invalidChange = await emitAck(host, 'change_video', { videoId: 'too-short' });
    check(
      'an invalid video id is refused',
      invalidChange.ok === false && invalidChange.error === 'INVALID_VIDEO_ID',
      invalidChange.error,
    );

    console.log('\n9. A late joiner receives the current video');
    const latecomer = await connectClient();
    sockets.push(latecomer);
    const lateJoin = await join(latecomer, { roomId, username: 'Latecomer', userId: 'user-late' });
    check(
      'the join ack carries the video',
      lateJoin.state.video?.videoId === SAMPLE_VIDEO_ID,
      JSON.stringify(lateJoin.state.video),
    );

    console.log('\n10. An empty room is cleaned up after the grace period');
    const hostSawLatecomerLeave = nextEvent(host, 'user_left');
    latecomer.disconnect();
    await hostSawLatecomerLeave;

    const hostSawImpostorLeave = nextEvent(host, 'user_left');
    impostor.disconnect();
    await hostSawImpostorLeave;

    host.disconnect();
    await delay(ROOM_TTL_MS + 800);
    const goneResponse = await fetch(`${BASE_URL}/api/rooms/${roomId}`);
    check('room is deleted once empty', goneResponse.status === 404, String(goneResponse.status));

    console.log('\n11. The ack contract the frontend relies on (socket.timeout)');
    const frontend = await connectClient();
    sockets.push(frontend);
    check('socket.io-client exposes .timeout()', typeof frontend.timeout === 'function');

    const freshRoom = await fetch(`${BASE_URL}/api/rooms`, { method: 'POST' }).then((r) => r.json());
    const timeoutAck = await new Promise((resolve) => {
      frontend.timeout(3000).emit(
        'join_room',
        {
          roomId: freshRoom.roomId,
          username: 'FrontendUser',
          userId: 'user-frontend',
          hostToken: freshRoom.hostToken,
        },
        (err, response) => resolve({ err, response }),
      );
    });
    // socket.io-client unshifts `null` as the error slot on a successful ack,
    // which is what lets the client write `(err, response) => ...`.
    check('successful ack passes null as the first argument', timeoutAck.err === null, String(timeoutAck.err));
    check(
      'second argument carries ok + state',
      timeoutAck.response?.ok === true && Array.isArray(timeoutAck.response.state?.participants),
    );

    console.log('\n12. Play/pause is allowed for the host and never echoes to the sender');
    const playRoom = await fetch(`${BASE_URL}/api/rooms`, { method: 'POST' }).then((r) => r.json());
    const playHost = await connectClient();
    const playGuest = await connectClient();
    sockets.push(playHost, playGuest);
    await join(playHost, {
      roomId: playRoom.roomId,
      username: 'PlayHost',
      userId: 'u-play-host',
      hostToken: playRoom.hostToken,
    });
    await join(playGuest, { roomId: playRoom.roomId, username: 'PlayGuest', userId: 'u-play-guest' });

    // Loop guard #1: the client that sends the event must not receive it back,
    // otherwise it would re-apply and re-broadcast forever.
    const hostHeardItsOwnPlay = waitForEvent(playHost, 'play');
    const guestHeardPlay = nextEvent(playGuest, 'play');
    const hostPlayAck = await emitAck(playHost, 'play', {});
    check('the host may play', hostPlayAck.ok === true, hostPlayAck.error);
    check('another client receives play', (await guestHeardPlay).by === 'PlayHost');
    check('the sender does not get its own event back', (await hostHeardItsOwnPlay) === null);

    const guestHeardPause = nextEvent(playGuest, 'pause');
    const hostPauseAck = await emitAck(playHost, 'pause', {});
    check('the host may pause', hostPauseAck.ok === true, hostPauseAck.error);
    check('another client receives pause', (await guestHeardPause).by === 'PlayHost');

    console.log('\n13. A participant is refused, on a channel it cannot opt out of');
    const guestDenied = nextEvent(playGuest, 'permission_denied');
    const guestPlayAck = await emitAck(playGuest, 'play', {});
    check(
      'a participant play is refused',
      guestPlayAck.ok === false && guestPlayAck.error === 'FORBIDDEN',
      guestPlayAck.error,
    );
    const denied = await guestDenied;
    check('permission_denied names the event', denied.event === 'play', JSON.stringify(denied));

    // The same attack without an ack callback at all: the dedicated event is
    // the channel the server controls, not the one the client opts into.
    const leakedToHost = waitForEvent(playHost, 'play');
    const deniedWithoutAck = nextEvent(playGuest, 'permission_denied');
    playGuest.emit('pause');
    const deniedPause = await deniedWithoutAck;
    check('the denial arrives even with no ack callback', deniedPause.event === 'pause', JSON.stringify(deniedPause));
    check('a refused event is never broadcast', (await leakedToHost) === null);

    console.log('\n14. Seek carries a validated time, and is privileged too');
    const guestHeardSeek = nextEvent(playGuest, 'seek');
    const hostHeardItsOwnSeek = waitForEvent(playHost, 'seek');
    const hostSeekAck = await emitAck(playHost, 'seek', { time: 42.5 });
    check('the host may seek', hostSeekAck.ok === true, hostSeekAck.error);
    const seekEvent = await guestHeardSeek;
    check('another client receives the time', seekEvent.time === 42.5, String(seekEvent.time));
    check('the seek records who sent it', seekEvent.by === 'PlayHost', seekEvent.by);
    check('the sender does not get its own seek back', (await hostHeardItsOwnSeek) === null);

    const badTimes = [
      ['missing', {}],
      ['null', { time: null }],
      ['a string', { time: '30' }],
      ['negative', { time: -5 }],
      ['an object', { time: { seconds: 1 } }],
    ];
    for (const [label, payload] of badTimes) {
      const result = await emitAck(playHost, 'seek', payload);
      check(
        `an invalid time is refused (${label})`,
        result.ok === false && result.error === 'INVALID_TIME',
        result.error,
      );
    }

    const guestSeekDenied = nextEvent(playGuest, 'permission_denied');
    const leakedSeek = waitForEvent(playHost, 'seek');
    const guestSeekAck = await emitAck(playGuest, 'seek', { time: 10 });
    check(
      'a participant seek is refused',
      guestSeekAck.ok === false && guestSeekAck.error === 'FORBIDDEN',
      guestSeekAck.error,
    );
    check('permission_denied names seek', (await guestSeekDenied).event === 'seek');
    check('a refused seek is never broadcast', (await leakedSeek) === null);

    console.log('\n15. change_video updates shared state and notifies the room');
    const guestHeardVideoChange = nextEvent(playGuest, 'change_video');
    const hostHeardItsOwnVideoChange = waitForEvent(playHost, 'change_video');
    const hostVideoAck = await emitAck(playHost, 'change_video', { videoId: SECOND_VIDEO_ID });
    check('the host may change the video', hostVideoAck.ok === true, hostVideoAck.error);

    const videoNotice = await guestHeardVideoChange;
    check('the room is notified of the new id', videoNotice.videoId === SECOND_VIDEO_ID, videoNotice.videoId);
    check('the notice names who changed it', videoNotice.by === 'PlayHost', videoNotice.by);
    check('the sender does not get its own notice', (await hostHeardItsOwnVideoChange) === null);

    // The authoritative copy rides in sync_state, which is what actually drives
    // every player - the notice above is display only.
    const videoLatecomer = await connectClient();
    sockets.push(videoLatecomer);
    const lateVideoState = await join(videoLatecomer, {
      roomId: playRoom.roomId,
      username: 'VideoLatecomer',
      userId: 'u-video-late',
    });
    check(
      'a brand new joiner is handed the current video',
      lateVideoState.state.video?.videoId === SECOND_VIDEO_ID,
      JSON.stringify(lateVideoState.state.video),
    );

    const guestVideoDenied = nextEvent(playGuest, 'permission_denied');
    const leakedVideoNotice = waitForEvent(playHost, 'change_video');
    const guestVideoAck = await emitAck(playGuest, 'change_video', { videoId: 'aaaaaaaaaaa' });
    check(
      'a participant cannot change the video',
      guestVideoAck.ok === false && guestVideoAck.error === 'FORBIDDEN',
      guestVideoAck.error,
    );
    check('permission_denied names change_video', (await guestVideoDenied).event === 'change_video');
    check('a refused change is never broadcast', (await leakedVideoNotice) === null);

    console.log('\n16. A joiner is handed the room position and play state');
    const syncRoom = await fetch(`${BASE_URL}/api/rooms`, { method: 'POST' }).then((r) => r.json());
    const syncHost = await connectClient();
    sockets.push(syncHost);
    const syncHostJoin = await join(syncHost, {
      roomId: syncRoom.roomId,
      username: 'SyncHost',
      userId: 'u-sync-host',
      hostToken: syncRoom.hostToken,
    });
    check(
      'a room with no video reports paused at 0',
      syncHostJoin.state.playback.playState === 'paused' && syncHostJoin.state.playback.currentTime === 0,
      JSON.stringify(syncHostJoin.state.playback),
    );

    // Load a video, jump to 100s, and start playing.
    await emitAck(syncHost, 'change_video', { videoId: SAMPLE_VIDEO_ID });
    await emitAck(syncHost, 'seek', { time: 100 });
    await emitAck(syncHost, 'play', { time: 100 });

    const PLAYING_FOR_MS = 1200;
    await delay(PLAYING_FOR_MS);

    const syncGuest = await connectClient();
    sockets.push(syncGuest);
    const syncGuestJoin = await join(syncGuest, {
      roomId: syncRoom.roomId,
      username: 'SyncGuest',
      userId: 'u-sync-guest',
    });
    const guestPlayback = syncGuestJoin.state.playback;
    check('the joiner is told the room is playing', guestPlayback.playState === 'playing', guestPlayback.playState);
    check(
      'the joiner is told the projected position, not the stale one',
      guestPlayback.currentTime > 100.9 && guestPlayback.currentTime < 105,
      String(guestPlayback.currentTime),
    );
    check('the joiner is told the video as well', syncGuestJoin.state.video.videoId === SAMPLE_VIDEO_ID);

    // The brief asks not to broadcast sync_state unnecessarily. A playback change
    // touches neither the participant list nor the video, so only the dedicated
    // event should go out.
    const straySync = waitForEvent(syncGuest, 'sync_state', 500);
    await emitAck(syncHost, 'pause', { time: 222 });
    check('a playback change does not broadcast sync_state', (await straySync) === null);

    const frozenGuest = await connectClient();
    sockets.push(frozenGuest);
    const frozenJoin = await join(frozenGuest, {
      roomId: syncRoom.roomId,
      username: 'FrozenGuest',
      userId: 'u-frozen-guest',
    });
    check(
      'a paused room reports the frozen position',
      frozenJoin.state.playback.playState === 'paused' && frozenJoin.state.playback.currentTime === 222,
      JSON.stringify(frozenJoin.state.playback),
    );

    console.log('\n17. remove_participant is host-only and disconnects the target');
    const kickRoom = await fetch(`${BASE_URL}/api/rooms`, { method: 'POST' }).then((r) => r.json());
    const kickHost = await connectClient();
    const kickGuest = await connectClient();
    const kickOther = await connectClient();
    sockets.push(kickHost, kickGuest, kickOther);

    await join(kickHost, {
      roomId: kickRoom.roomId,
      username: 'KickHost',
      userId: 'u-kick-host',
      hostToken: kickRoom.hostToken,
    });
    await join(kickGuest, { roomId: kickRoom.roomId, username: 'KickGuest', userId: 'u-kick-guest' });
    await join(kickOther, { roomId: kickRoom.roomId, username: 'KickOther', userId: 'u-kick-other' });

    // A participant may not remove anyone - not even another participant.
    const guestDeniedKick = nextEvent(kickGuest, 'permission_denied');
    const nobodyWasKicked = waitForEvent(kickOther, 'participant_removed');
    const guestKickAck = await emitAck(kickGuest, 'remove_participant', { userId: 'u-kick-other' });
    check(
      'a participant cannot remove anyone',
      guestKickAck.ok === false && guestKickAck.error === 'FORBIDDEN',
      guestKickAck.error,
    );
    check(
      'permission_denied names remove_participant',
      (await guestDeniedKick).event === 'remove_participant',
    );
    check('a refused removal changes nothing', (await nobodyWasKicked) === null);

    const selfKick = await emitAck(kickHost, 'remove_participant', { userId: 'u-kick-host' });
    check(
      'the host cannot remove themselves',
      selfKick.ok === false && selfKick.error === 'CANNOT_REMOVE_SELF',
      selfKick.error,
    );

    const ghostKick = await emitAck(kickHost, 'remove_participant', { userId: 'u-does-not-exist' });
    check(
      'an unknown user is refused',
      ghostKick.ok === false && ghostKick.error === 'PARTICIPANT_NOT_FOUND',
      ghostKick.error,
    );

    // The real removal.
    const targetSawRemoval = nextEvent(kickGuest, 'participant_removed');
    const targetWasDisconnected = waitForEvent(kickGuest, 'disconnect', 2000);
    const roomListWithoutTarget = waitForSyncMatching(
      kickHost,
      (state) => !state.participants.some((p) => p.userId === 'u-kick-guest'),
    );

    const hostKickAck = await emitAck(kickHost, 'remove_participant', { userId: 'u-kick-guest' });
    check('the host may remove a participant', hostKickAck.ok === true, hostKickAck.error);

    const removalNotice = await targetSawRemoval;
    check(
      'the target is told it was removed',
      removalNotice.userId === 'u-kick-guest',
      JSON.stringify(removalNotice),
    );
    check('the notice names the host', removalNotice.by === 'KickHost', removalNotice.by);
    check('the target socket is disconnected', (await targetWasDisconnected) !== null);

    const survivors = await roomListWithoutTarget;
    check(
      'the removed user is gone from the room',
      !survivors.participants.some((p) => p.userId === 'u-kick-guest'),
    );
    check(
      'the remaining participants are untouched',
      survivors.participants.some((p) => p.userId === 'u-kick-host') &&
        survivors.participants.some((p) => p.userId === 'u-kick-other'),
    );

    const alreadyGone = await emitAck(kickHost, 'remove_participant', { userId: 'u-kick-guest' });
    check(
      'removing someone already gone is refused, not an error',
      alreadyGone.ok === false && alreadyGone.error === 'PARTICIPANT_NOT_FOUND',
      alreadyGone.error,
    );

    console.log('\n18. assign_role is host-only, and really does grant moderator powers');
    const roleRoom = await fetch(`${BASE_URL}/api/rooms`, { method: 'POST' }).then((r) => r.json());
    const roleHost = await connectClient();
    const roleGuest = await connectClient();
    sockets.push(roleHost, roleGuest);

    await join(roleHost, {
      roomId: roleRoom.roomId,
      username: 'RoleHost',
      userId: 'u-role-host',
      hostToken: roleRoom.hostToken,
    });
    await join(roleGuest, {
      roomId: roleRoom.roomId,
      username: 'RoleGuest',
      userId: 'u-role-guest',
    });

    const beforePromotion = await emitAck(roleGuest, 'play', {});
    check('a participant cannot play', beforePromotion.ok === false, beforePromotion.error);

    const selfPromote = await emitAck(roleGuest, 'assign_role', {
      userId: 'u-role-guest',
      role: 'moderator',
    });
    check(
      'a participant cannot assign roles',
      selfPromote.ok === false && selfPromote.error === 'FORBIDDEN',
      selfPromote.error,
    );

    const selfRole = await emitAck(roleHost, 'assign_role', {
      userId: 'u-role-host',
      role: 'moderator',
    });
    check(
      'the host cannot change their own role',
      selfRole.ok === false && selfRole.error === 'CANNOT_CHANGE_OWN_ROLE',
      selfRole.error,
    );

    const hostRole = await emitAck(roleHost, 'assign_role', {
      userId: 'u-role-guest',
      role: 'host',
    });
    check(
      'a host role cannot be handed out',
      hostRole.ok === false && hostRole.error === 'INVALID_ROLE',
      hostRole.error,
    );

    const ghostRole = await emitAck(roleHost, 'assign_role', {
      userId: 'u-nobody',
      role: 'moderator',
    });
    check(
      'an unknown user is refused',
      ghostRole.ok === false && ghostRole.error === 'PARTICIPANT_NOT_FOUND',
      ghostRole.error,
    );

    const guestHeardRoleChange = nextEvent(roleGuest, 'role_assigned');
    const promotedState = waitForSyncMatching(roleGuest, (state) =>
      state.participants.some((p) => p.userId === 'u-role-guest' && p.role === 'moderator'),
    );
    const promoteAck = await emitAck(roleHost, 'assign_role', {
      userId: 'u-role-guest',
      role: 'moderator',
    });
    check('the host may promote a participant', promoteAck.ok === true, promoteAck.error);

    const roleNotice = await guestHeardRoleChange;
    check('the room is told about the new role', roleNotice.role === 'moderator', JSON.stringify(roleNotice));

    const afterPromotion = await promotedState;
    check(
      'the participant list shows the new role',
      afterPromotion.participants.find((p) => p.userId === 'u-role-guest')?.role === 'moderator',
    );

    // The point of the promotion: these branches were unreachable before.
    const moderatorPlays = await emitAck(roleGuest, 'play', { time: 5 });
    check('a promoted moderator can play', moderatorPlays.ok === true, moderatorPlays.error);

    const moderatorSeeks = await emitAck(roleGuest, 'seek', { time: 12 });
    check('a promoted moderator can seek', moderatorSeeks.ok === true, moderatorSeeks.error);

    const moderatorChangesVideo = await emitAck(roleGuest, 'change_video', {
      videoId: SAMPLE_VIDEO_ID,
    });
    check(
      'a promoted moderator can change the video',
      moderatorChangesVideo.ok === true,
      moderatorChangesVideo.error,
    );

    // ...but the two host-only powers are still out of reach.
    const moderatorRemoves = await emitAck(roleGuest, 'remove_participant', {
      userId: 'u-role-host',
    });
    check(
      'a moderator still cannot remove anyone',
      moderatorRemoves.ok === false && moderatorRemoves.error === 'FORBIDDEN',
      moderatorRemoves.error,
    );

    const moderatorAssigns = await emitAck(roleGuest, 'assign_role', {
      userId: 'u-role-host',
      role: 'participant',
    });
    check(
      'a moderator still cannot assign roles',
      moderatorAssigns.ok === false && moderatorAssigns.error === 'FORBIDDEN',
      moderatorAssigns.error,
    );

    const demoteAck = await emitAck(roleHost, 'assign_role', {
      userId: 'u-role-guest',
      role: 'participant',
    });
    check('the host may demote again', demoteAck.ok === true, demoteAck.error);

    const afterDemotion = await emitAck(roleGuest, 'pause', {});
    check(
      'a demoted user loses playback control again',
      afterDemotion.ok === false && afterDemotion.error === 'FORBIDDEN',
      afterDemotion.error,
    );

    console.log("\n19. A userId alone cannot be used to claim someone else's seat");
    const seatRoom = await fetch(`${BASE_URL}/api/rooms`, { method: 'POST' }).then((r) => r.json());
    const seatHost = await connectClient();
    const seatGuest = await connectClient();
    sockets.push(seatHost, seatGuest);

    const hostSeat = await join(seatHost, {
      roomId: seatRoom.roomId,
      username: 'SeatHost',
      userId: 'u-seat-host',
      hostToken: seatRoom.hostToken,
    });
    const guestSeat = await join(seatGuest, {
      roomId: seatRoom.roomId,
      username: 'SeatGuest',
      userId: 'u-seat-guest',
    });

    check(
      'the ack hands the joiner a seat secret',
      typeof guestSeat.seatToken === 'string' && guestSeat.seatToken.length > 10,
    );
    check('each seat gets its own secret', guestSeat.seatToken !== hostSeat.seatToken);
    check(
      'the seat secret never reaches the room state',
      !JSON.stringify(guestSeat.state).includes(guestSeat.seatToken),
    );

    // Make the seat worth stealing.
    await emitAck(seatHost, 'assign_role', { userId: 'u-seat-guest', role: 'moderator' });

    const seatThief = await connectClient();
    sockets.push(seatThief);
    const thiefJoin = await join(seatThief, {
      roomId: seatRoom.roomId,
      username: 'Thief',
      userId: 'u-seat-guest',
    });
    check(
      'a live moderator seat cannot be claimed with a userId alone',
      thiefJoin.ok === false && thiefJoin.error === 'SEAT_TAKEN',
      JSON.stringify(thiefJoin),
    );

    const hostThief = await connectClient();
    sockets.push(hostThief);
    const hostThiefJoin = await join(hostThief, {
      roomId: seatRoom.roomId,
      username: 'Thief',
      userId: 'u-seat-host',
    });
    check(
      'a live host seat cannot be claimed with a userId alone',
      hostThiefJoin.ok === false && hostThiefJoin.error === 'SEAT_TAKEN',
      JSON.stringify(hostThiefJoin),
    );

    const holderUnaffected = await emitAck(seatGuest, 'play', {});
    check('the real seat holder is untouched by the attempts', holderUnaffected.ok === true, holderUnaffected.error);

    // The legitimate way to take over your own seat: present the secret. This is
    // what keeps a second tab (which shares localStorage) working.
    const seatGuestTab = await connectClient();
    sockets.push(seatGuestTab);
    const reclaimed = await join(seatGuestTab, {
      roomId: seatRoom.roomId,
      username: 'SeatGuest',
      userId: 'u-seat-guest',
      seatToken: guestSeat.seatToken,
    });
    check(
      'the seat secret reclaims the same seat and role',
      reclaimed.ok === true &&
        reclaimed.state.participants.find((p) => p.userId === 'u-seat-guest')?.role === 'moderator',
      JSON.stringify(reclaimed),
    );

    console.log('\n20. Live chat messages between host and participants');
    const unseatedSocket = await connectClient();
    sockets.push(unseatedSocket);
    const unseatedChat = await emitAck(unseatedSocket, 'send_chat', { text: 'Hello outside' });
    check(
      'unseated socket cannot send chat',
      unseatedChat.ok === false && unseatedChat.error === 'NOT_IN_ROOM',
      JSON.stringify(unseatedChat),
    );

    const emptyChat = await emitAck(seatGuest, 'send_chat', { text: '   ' });
    check(
      'empty chat message is rejected',
      emptyChat.ok === false && emptyChat.error === 'EMPTY_MESSAGE',
      JSON.stringify(emptyChat),
    );

    const hostReceivesOwnChatPromise = nextEvent(seatHost, 'chat_message');
    const guestReceivesChatPromise = nextEvent(seatGuest, 'chat_message');
    const hostSend = await emitAck(seatHost, 'send_chat', { text: 'Welcome to the party!' });
    check('host can send a chat message', hostSend.ok === true && hostSend.message.text === 'Welcome to the party!');

    const receivedByHostFirst = await hostReceivesOwnChatPromise;
    check('host receives own broadcasted chat message', receivedByHostFirst.text === 'Welcome to the party!');

    const receivedByGuest = await guestReceivesChatPromise;
    check(
      'guest receives host chat message with role',
      receivedByGuest.text === 'Welcome to the party!' &&
        receivedByGuest.username === 'SeatHost' &&
        receivedByGuest.role === 'host',
      JSON.stringify(receivedByGuest),
    );

    const hostReceivesChatPromise = nextEvent(seatHost, 'chat_message');
    const guestSend = await emitAck(seatGuest, 'send_chat', { text: 'Thanks, glad to be here!' });
    check('guest can send a chat message', guestSend.ok === true);

    const receivedByHost = await hostReceivesChatPromise;
    check(
      'host receives guest chat message',
      receivedByHost.text === 'Thanks, glad to be here!' && receivedByHost.username === 'SeatGuest',
      JSON.stringify(receivedByHost),
    );

    const lateChatJoiner = await connectClient();
    sockets.push(lateChatJoiner);
    const lateJoinChatResult = await join(lateChatJoiner, {
      roomId: seatRoom.roomId,
      username: 'LateChatter',
      userId: 'u-late-chatter',
    });
    check(
      'a late joiner receives existing chat messages in room state',
      Array.isArray(lateJoinChatResult.state.messages) &&
        lateJoinChatResult.state.messages.some((m) => m.text === 'Welcome to the party!') &&
        lateJoinChatResult.state.messages.some((m) => m.text === 'Thanks, glad to be here!'),
      JSON.stringify(lateJoinChatResult.state?.messages),
    );

    console.log('\n21. YouTube search endpoint');
    const emptySearchRes = await fetch(`${BASE_URL}/api/youtube/search?q=`);
    const emptySearchData = await emptySearchRes.json();
    check('empty query returns empty array', Array.isArray(emptySearchData.results) && emptySearchData.results.length === 0);

    const directSearchRes = await fetch(`${BASE_URL}/api/youtube/search?q=${SAMPLE_VIDEO_ID}`);
    const directSearchData = await directSearchRes.json();
    check(
      'direct video ID returns video item',
      directSearchData.results?.length > 0 && directSearchData.results[0].id === SAMPLE_VIDEO_ID,
      JSON.stringify(directSearchData),
    );

    console.log('\n22. Transfer Host – Host hands the room ownership to another participant');
    const xferRoomRes = await fetch(`${BASE_URL}/api/rooms`, { method: 'POST' });
    const xferRoom = await xferRoomRes.json();
    const xferHost = await connectClient();
    sockets.push(xferHost);
    const xferGuest = await connectClient();
    sockets.push(xferGuest);

    await join(xferHost, {
      roomId: xferRoom.roomId,
      username: 'OriginalHost',
      userId: 'u-xfer-host',
      hostToken: xferRoom.hostToken,
    });

    await join(xferGuest, {
      roomId: xferRoom.roomId,
      username: 'CandidateGuest',
      userId: 'u-xfer-guest',
    });

    const guestTransferAttempt = await emitAck(xferGuest, 'transfer_host', {
      userId: 'u-xfer-host',
    });
    check(
      'a participant cannot transfer host',
      guestTransferAttempt.ok === false && guestTransferAttempt.error === 'FORBIDDEN',
      guestTransferAttempt.error,
    );

    const selfTransferAttempt = await emitAck(xferHost, 'transfer_host', {
      userId: 'u-xfer-host',
    });
    check(
      'host cannot transfer host to themselves',
      selfTransferAttempt.ok === false && selfTransferAttempt.error === 'ALREADY_HOST',
      selfTransferAttempt.error,
    );

    const guestReceivedHostToken = nextEvent(xferGuest, 'host_token_granted');
    const roomHeardHostTransfer = nextEvent(xferHost, 'host_transferred');

    const validTransferAck = await emitAck(xferHost, 'transfer_host', {
      userId: 'u-xfer-guest',
    });
    check('host can transfer host role to another participant', validTransferAck.ok === true, validTransferAck.error);

    const hostTokenPayload = await guestReceivedHostToken;
    check(
      'new host receives new secret hostToken',
      typeof hostTokenPayload.hostToken === 'string' && hostTokenPayload.hostToken.length > 0,
      JSON.stringify(hostTokenPayload),
    );

    const transferNotice = await roomHeardHostTransfer;
    check(
      'room is notified of host transfer',
      transferNotice.previousHost?.userId === 'u-xfer-host' && transferNotice.newHost?.userId === 'u-xfer-guest',
      JSON.stringify(transferNotice),
    );

    const newHostRemoves = await emitAck(xferGuest, 'remove_participant', {
      userId: 'u-xfer-host',
    });
    check('new host can now remove participants', newHostRemoves.ok === true, newHostRemoves.error);

    console.log('\n23. Authentication endpoints (Register, Login, Me)');
    const testUsername = `user_${Date.now()}`;
    const testPassword = 'SecretPassword123!';

    const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: testUsername, password: testPassword }),
    });
    const regData = await regRes.json();
    check('register returns 201 and token', regRes.status === 201 && regData.ok === true && typeof regData.token === 'string', JSON.stringify(regData));
    check('registered user matches requested username', regData.user?.username === testUsername);

    const dupRes = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: testUsername, password: testPassword }),
    });
    check('duplicate registration returns 409', dupRes.status === 409);

    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: testUsername, password: testPassword }),
    });
    const loginData = await loginRes.json();
    check('login succeeds with correct password', loginRes.status === 200 && loginData.ok === true && typeof loginData.token === 'string');

    const wrongLoginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: testUsername, password: 'WrongPassword!' }),
    });
    check('login fails with wrong password', wrongLoginRes.status === 401);

    const meRes = await fetch(`${BASE_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${loginData.token}` },
    });
    const meData = await meRes.json();
    check('me endpoint verifies valid JWT token', meRes.status === 200 && meData.ok === true && meData.user?.username === testUsername);
  } finally {
    for (const socket of sockets) socket.disconnect();
    server.child.kill();
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.log('\n--- server log ---');
    console.log(server.serverLog());
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
