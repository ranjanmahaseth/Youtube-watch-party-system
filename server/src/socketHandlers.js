import {
  PLAY_STATE,
  canAssignRoles,
  canControlPlayback,
  canRemoveParticipants,
  cancelRoomCleanup,
  getRoom,
  isAssignableRole,
  isValidSeekTime,
  isValidVideoId,
  normalizeRoomId,
  normalizeUsername,
  ownsSeat,
  removeParticipant,
  scheduleRoomCleanup,
  setParticipantRole,
  setRoomPlayState,
  setRoomTime,
  setRoomVideo,
  toRoomState,
  toRoomParticipants,
  upsertParticipant,
  addChatMessage,
} from './roomStore.js';

/**
 * What each privileged event tells a refused client. Keyed by event so the
 * message always describes the action that was actually refused - a single
 * hardcoded string would tell a moderator off for "control playback" when they
 * tried to remove someone.
 */
const DENIED_MESSAGES = {
  play: 'Only the host or a moderator can control playback.',
  pause: 'Only the host or a moderator can control playback.',
  seek: 'Only the host or a moderator can seek.',
  change_video: 'Only the host or a moderator can change the video.',
  remove_participant: 'Only the host can remove participants.',
  assign_role: 'Only the host can manage roles.',
};

function reply(acknowledge, payload) {
  if (typeof acknowledge === 'function') acknowledge(payload);
}

/**
 * Refuses a privileged command on two channels.
 *
 * The ack is a convenience. `permission_denied` is the one that matters: a
 * client that bypasses our UI can simply omit the ack callback, so the server
 * needs a channel the client cannot opt out of.
 */
function denyPrivileged(socket, event, acknowledge) {
  socket.emit('permission_denied', {
    event,
    error: 'FORBIDDEN',
    message: DENIED_MESSAGES[event] ?? 'You are not allowed to do that.',
  });
  reply(acknowledge, { ok: false, error: 'FORBIDDEN' });
}

/**
 * Finds the room and participant behind a socket's current seat.
 * Returns nulls when the socket is not seated in a room any more.
 */
function actingParticipant(socket) {
  const room = getRoom(socket.data.roomId);
  if (!room) return { room: null, participant: null };

  return { room, participant: room.participants.get(socket.data.userId) ?? null };
}

/**
 * Runs the part every privileged command shares: find the caller's seat, then
 * check the role.
 *
 * `can` is the rule for this particular command. It defaults to the playback
 * rule, but commands with a stricter rule pass their own - removal, for example,
 * is host-only. Making it a parameter keeps the difference visible at the call
 * site instead of buried in a shared helper.
 *
 * Returns `{ room, participant }` when the command may proceed, or null when it
 * has already been refused (the caller should then simply stop).
 *
 * Note the ordering: authorization is checked *before* payload validation, so
 * an unauthorized client learns nothing about our payload rules.
 */
function authorizePrivileged(socket, event, acknowledge, can = canControlPlayback) {
  const { room, participant } = actingParticipant(socket);

  if (!room || !participant) {
    reply(acknowledge, { ok: false, error: 'NOT_IN_ROOM' });
    return null;
  }

  if (!can(participant)) {
    console.log(`[room] refused ${event} from participant ${participant.username} in ${room.id}`);
    denyPrivileged(socket, event, acknowledge);
    return null;
  }

  return { room, participant };
}

/**
 * Handles the privileged play/pause commands.
 *
 * `socket.to(room)` - not `io.to(room)` - is deliberate and is loop-prevention
 * guard #1: the sender is excluded from the broadcast, so the client that sent
 * the event can never receive it back and bounce it straight out again.
 *
 * Guard #2 lives on the client, which suppresses its own player changes while it
 * applies a command that came from here.
 */
function handlePlaybackCommand(socket, event, payload, acknowledge) {
  const authorized = authorizePrivileged(socket, event, acknowledge);
  if (!authorized) return;

  const { room, participant } = authorized;

  // The position is optional here - `seek` is the event whose whole point is the
  // time. When a client does send a real number it is trusted over our own
  // projection, which keeps the stored position honest instead of drifting.
  const reportedTime = isValidSeekTime(payload?.time) ? payload.time : undefined;
  setRoomPlayState(room, event === 'play' ? PLAY_STATE.PLAYING : PLAY_STATE.PAUSED, reportedTime);

  reply(acknowledge, { ok: true });

  // Only the dedicated event goes out. Deliberately NO sync_state here: the
  // participant list and the video have not changed, and every other client
  // applies play/pause locally anyway, so a full snapshot would be pure noise.
  socket.to(room.id).emit(event, {
    time: room.playback.currentTime, // informational; receivers do not seek on it
    by: participant.username,
    at: Date.now(),
  });

  console.log(
    `[room] ${participant.username} ${event} at ${room.playback.currentTime}s in ${room.id}`,
  );
}

/**
 * Handles the privileged `seek` command.
 *
 * The only difference from play/pause is that the event carries a value, and a
 * value from a client is never trusted as-is.
 */
function handleSeek(socket, payload, acknowledge) {
  const authorized = authorizePrivileged(socket, 'seek', acknowledge);
  if (!authorized) return;

  const { room, participant } = authorized;

  if (!isValidSeekTime(payload?.time)) {
    return reply(acknowledge, { ok: false, error: 'INVALID_TIME' });
  }

  // Round to milliseconds so a hostile client cannot spam absurd precision.
  const time = Math.round(payload.time * 1000) / 1000;

  // Record it so a joiner can be told where the room is. Again, no sync_state
  // broadcast: the `seek` event itself is all the other clients need.
  setRoomTime(room, time);

  reply(acknowledge, { ok: true });

  socket.to(room.id).emit('seek', { time, by: participant.username, at: Date.now() });
  console.log(`[room] ${participant.username} seek -> ${time}s in ${room.id}`);
}

/**
 * Handles the privileged `change_video` command.
 *
 * Two messages go out to the room and they do different jobs:
 *  - `sync_state` is the authoritative snapshot that every client renders from.
 *  - `change_video` is a display-only notice, so clients can say who changed what
 *    in the activity feed. Exactly the same split as user_joined / user_left.
 *
 * Note the different broadcast targets below, and why.
 */
function handleChangeVideo(socket, io, payload, acknowledge) {
  const authorized = authorizePrivileged(socket, 'change_video', acknowledge);
  if (!authorized) return;

  const { room, participant } = authorized;

  // A client-supplied value is never trusted: the id must be 11 URL-safe
  // characters, so a link, a typo or anything else is refused here.
  const videoId = typeof payload?.videoId === 'string' ? payload.videoId.trim() : '';
  if (!isValidVideoId(videoId)) {
    return reply(acknowledge, { ok: false, error: 'INVALID_VIDEO_ID' });
  }

  setRoomVideo(room, { videoId, loadedBy: participant.username });
  reply(acknowledge, { ok: true });

  console.log(`[room] ${participant.username} loaded ${videoId} in ${room.id}`);

  // socket.to: the sender initiated this and already got the ack, so it does not
  // need to be told about its own action.
  socket.to(room.id).emit('change_video', {
    videoId,
    by: participant.username,
    at: Date.now(),
  });

  // io.to, NOT socket.to. Unlike play/pause/seek, the sender never held this
  // video locally - the video is server-owned state - so it needs the
  // authoritative snapshot as much as anyone else. This single snapshot is what
  // makes every client (and every future joiner) load the same video.
  io.to(room.id).emit('sync_state', toRoomState(room));
}

/**
 * Handles the host-only `remove_participant` command.
 *
 * Identifying the target's socket: every participant record already stores the
 * `socketId` it was last seen on, so the live Socket is one lookup away. That id
 * is refreshed on every join, which is what keeps it correct across reconnects.
 *
 * The order of the steps below matters - see the comments.
 */
function handleRemoveParticipant(socket, io, payload, acknowledge) {
  const authorized = authorizePrivileged(
    socket,
    'remove_participant',
    acknowledge,
    canRemoveParticipants,
  );
  if (!authorized) return;

  const { room, participant: host } = authorized;

  const targetUserId = typeof payload?.userId === 'string' ? payload.userId.trim() : '';
  if (!targetUserId) {
    return reply(acknowledge, { ok: false, error: 'INVALID_PAYLOAD' });
  }

  if (targetUserId === host.userId) {
    return reply(acknowledge, { ok: false, error: 'CANNOT_REMOVE_SELF' });
  }

  const target = room.participants.get(targetUserId);

  // Already gone. The usual cause is that they disconnected a moment ago and
  // detachFromRoom got there first - there is nothing left to remove.
  if (!target) {
    return reply(acknowledge, { ok: false, error: 'PARTICIPANT_NOT_FOUND' });
  }

  removeParticipant(room, targetUserId);
  reply(acknowledge, { ok: true });

  console.log(`[room] ${host.username} removed ${target.username} from ${room.id}`);

  // 1. Tell the WHOLE room while the target is still attached, so the target is
  //    guaranteed to see it. Everyone gets the same payload; each client works
  //    out whether it is about itself by comparing `userId`.
  io.to(room.id).emit('participant_removed', {
    userId: target.userId,
    username: target.username,
    participants: toRoomParticipants(room),
    by: host.username,
    at: Date.now(),
  });

  // 2. Detach the target's socket. Clearing `socket.data` first matters:
  //    otherwise the disconnect below would fire detachFromRoom, which would try
  //    to remove an already-removed participant.
  const targetSocket = io.sockets.sockets.get(target.socketId);
  if (targetSocket) {
    targetSocket.data.roomId = null;
    targetSocket.data.userId = null;
    targetSocket.leave(room.id);
  }

  // 3. The remaining clients get the authoritative list. The target has already
  //    left the Socket.IO room, so it is not included.
  io.to(room.id).emit('sync_state', toRoomState(room));

  // 4. Only now close the connection. Packets written above are flushed first,
  //    so the notification has already gone out.
  targetSocket?.disconnect(true);

  // A stale socketId is tolerated on purpose: the room state is already correct
  // and the survivors have the fresh list, so a missing socket is not an error.
  if (!targetSocket) {
    console.log(`[room] ${target.username} had no live socket; removed from state only`);
  }
}

/**
 * Handles the host-only `assign_role` command - promoting a participant to
 * moderator, or demoting a moderator back.
 *
 * Unlike play/pause/seek there is no "sender already knows" shortcut: the change
 * shows up in everyone's participant list, so the snapshot goes to the whole
 * room including the host.
 */
function handleAssignRole(socket, io, payload, acknowledge) {
  const authorized = authorizePrivileged(socket, 'assign_role', acknowledge, canAssignRoles);
  if (!authorized) return;

  const { room, participant: host } = authorized;

  const targetUserId = typeof payload?.userId === 'string' ? payload.userId.trim() : '';
  const role = typeof payload?.role === 'string' ? payload.role.trim() : '';

  if (!targetUserId) {
    return reply(acknowledge, { ok: false, error: 'INVALID_PAYLOAD' });
  }

  // The host's own role is never negotiable, which is what guarantees there is
  // always exactly one host and the room can never be left ownerless.
  if (targetUserId === host.userId) {
    return reply(acknowledge, { ok: false, error: 'CANNOT_CHANGE_OWN_ROLE' });
  }

  if (!isAssignableRole(role)) {
    return reply(acknowledge, { ok: false, error: 'INVALID_ROLE' });
  }

  const target = room.participants.get(targetUserId);
  if (!target) {
    return reply(acknowledge, { ok: false, error: 'PARTICIPANT_NOT_FOUND' });
  }

  setParticipantRole(room, targetUserId, role);
  reply(acknowledge, { ok: true });

  console.log(`[room] ${host.username} made ${target.username} a ${role} in ${room.id}`);

  // A notice for the activity feed, then the authoritative list for everyone.
  io.to(room.id).emit('role_assigned', {
    userId: target.userId,
    username: target.username,
    role,
    participants: toRoomParticipants(room),
    by: host.username,
    at: Date.now(),
  });
  io.to(room.id).emit('sync_state', toRoomState(room));
}

/**
 * Handles incoming chat messages from any seated participant.
 * Anyone in the room (host, moderator, or participant) may chat.
 */
function handleSendChat(socket, io, payload, acknowledge) {
  const { room, participant } = actingParticipant(socket);

  if (!room || !participant) {
    return reply(acknowledge, { ok: false, error: 'NOT_IN_ROOM' });
  }

  const rawText = payload?.text ?? payload?.message ?? '';
  const message = addChatMessage(room, {
    userId: participant.userId,
    username: participant.username,
    role: participant.role,
    text: rawText,
  });

  if (!message) {
    return reply(acknowledge, { ok: false, error: 'EMPTY_MESSAGE' });
  }

  reply(acknowledge, { ok: true, message });

  io.to(room.id).emit('chat_message', message);
  console.log(`[room] [chat] [${room.id}] ${participant.username}: ${message.text}`);
}

/**
 * Removes the socket's current participant and tells the room about it.
 * Safe to call when the socket is not in a room.
 */
function detachFromRoom(io, socket) {
  const { roomId, userId } = socket.data;
  if (!roomId || !userId) return;

  socket.data.roomId = null;
  socket.data.userId = null;
  socket.leave(roomId);

  const room = getRoom(roomId);
  if (!room) return;

  const removed = removeParticipant(room, userId);
  if (!removed) return;

  if (room.participants.size === 0) {
    scheduleRoomCleanup(room);
    return;
  }

  io.to(room.id).emit('user_left', {
    userId: removed.userId,
    username: removed.username,
    participants: toRoomParticipants(room),
  });
  io.to(room.id).emit('sync_state', toRoomState(room));
}

export function registerSocketHandlers(io) {
  io.on('connection', (socket) => {
    socket.data.roomId = null;
    socket.data.userId = null;
    console.log(`[socket] connected ${socket.id}`);

    socket.on('join_room', (payload, acknowledge) => {
      const roomId = normalizeRoomId(payload?.roomId);
      const username = normalizeUsername(payload?.username);
      const userId = typeof payload?.userId === 'string' ? payload.userId.trim() : '';
      const hostToken = typeof payload?.hostToken === 'string' ? payload.hostToken : '';
      const seatToken = typeof payload?.seatToken === 'string' ? payload.seatToken : '';

      if (!roomId || !username || !userId) {
        return reply(acknowledge, { ok: false, error: 'INVALID_PAYLOAD' });
      }

      const room = getRoom(roomId);
      if (!room) {
        return reply(acknowledge, { ok: false, error: 'ROOM_NOT_FOUND' });
      }

      // Refuse to displace a seat that is still live and cannot prove it owns
      // it. Checked before we detach from any current room, so a refused join
      // has no side effects.
      const existingSeat = room.participants.get(userId);
      const seatOccupied =
        existingSeat !== undefined && io.sockets.sockets.has(existingSeat.socketId);

      if (seatOccupied && existingSeat.socketId !== socket.id && !ownsSeat(room, userId, seatToken)) {
        return reply(acknowledge, { ok: false, error: 'SEAT_TAKEN' });
      }

      // Re-joining or switching rooms always releases the previous seat first.
      if (socket.data.roomId) detachFromRoom(io, socket);

      cancelRoomCleanup(room);

      const { participant, isNew, conflict } = upsertParticipant(room, {
        userId,
        username,
        socketId: socket.id,
        hostToken,
        seatToken,
        seatOccupied,
      });

      if (conflict) {
        return reply(acknowledge, { ok: false, error: 'SEAT_TAKEN' });
      }

      socket.data.roomId = room.id;
      socket.data.userId = userId;
      socket.join(room.id);

      // The joiner gets the authoritative state right away (requirement: a new
      // user must receive the current room state), plus the secret it must
      // present to reclaim this seat later. Only the ack carries the seat
      // token - it is never part of the broadcast room state.
      reply(acknowledge, {
        ok: true,
        state: toRoomState(room),
        seatToken: participant.seatToken,
      });

      if (isNew) {
        socket.to(room.id).emit('user_joined', {
          userId: participant.userId,
          username: participant.username,
          role: participant.role,
          participants: toRoomParticipants(room),
        });
      }

      // socket.to, not io.to: the joiner already has this exact snapshot from
      // the ack above. Only the clients whose participant list just changed need
      // the broadcast.
      socket.to(room.id).emit('sync_state', toRoomState(room));
      console.log(`[room] ${participant.username} joined ${room.id} as ${participant.role}`);
    });

    socket.on('change_video', (payload, acknowledge) =>
      handleChangeVideo(socket, io, payload, acknowledge),
    );

    socket.on('play', (payload, acknowledge) =>
      handlePlaybackCommand(socket, 'play', payload, acknowledge),
    );
    socket.on('pause', (payload, acknowledge) =>
      handlePlaybackCommand(socket, 'pause', payload, acknowledge),
    );
    socket.on('seek', (payload, acknowledge) => handleSeek(socket, payload, acknowledge));
    socket.on('remove_participant', (payload, acknowledge) =>
      handleRemoveParticipant(socket, io, payload, acknowledge),
    );
    socket.on('assign_role', (payload, acknowledge) =>
      handleAssignRole(socket, io, payload, acknowledge),
    );
    socket.on('send_chat', (payload, acknowledge) =>
      handleSendChat(socket, io, payload, acknowledge),
    );

    socket.on('leave_room', (payload, acknowledge) => {
      detachFromRoom(io, socket);
      reply(acknowledge, { ok: true });
    });

    socket.on('disconnect', (reason) => {
      detachFromRoom(io, socket);
      console.log(`[socket] disconnected ${socket.id} (${reason})`);
    });
  });
}
