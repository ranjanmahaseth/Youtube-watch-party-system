import { useEffect, useRef, useState } from 'react';
import { socket } from './socket.js';
import { createRoom, roomExists } from './api.js';
import {
  getHostToken,
  getOrCreateUserId,
  getRememberedUsername,
  getSeatToken,
  rememberHostToken,
  rememberSeatToken,
  rememberUsername,
} from './lib/session.js';
import Home from './components/Home.jsx';
import Room from './components/Room.jsx';

const MY_USER_ID = getOrCreateUserId();
const INVITE_ROOM_ID = new URLSearchParams(window.location.search).get('room') ?? '';
const JOIN_TIMEOUT_MS = 8000;
const SERVER_UNREACHABLE = 'Could not reach the server. Is the backend running?';

const JOIN_ERRORS = {
  ROOM_NOT_FOUND: 'That room does not exist. Check the code and try again.',
  INVALID_PAYLOAD: 'Please provide both a username and a room code.',
  SEAT_TAKEN: 'That seat is already in use in this room.',
};

const VIDEO_ERRORS = {
  FORBIDDEN: 'Only the host or a moderator can change the video.',
  INVALID_VIDEO_ID: 'That video id is not valid.',
  NOT_IN_ROOM: 'You are not in this room any more.',
};

const PLAYBACK_ERRORS = {
  FORBIDDEN: 'Only the host or a moderator can control playback.',
  NOT_IN_ROOM: 'You are not in this room any more.',
};

const SEEK_ERRORS = {
  FORBIDDEN: 'Only the host or a moderator can seek.',
  INVALID_TIME: 'That seek position is not valid.',
  NOT_IN_ROOM: 'You are not in this room any more.',
};

const REMOVE_ERRORS = {
  FORBIDDEN: 'Only the host can remove participants.',
  CANNOT_REMOVE_SELF: 'You cannot remove yourself - use "Leave room" instead.',
  PARTICIPANT_NOT_FOUND: 'That participant has already left the room.',
  INVALID_PAYLOAD: 'No participant was specified.',
  NOT_IN_ROOM: 'You are not in this room any more.',
};

const ROLE_ERRORS = {
  FORBIDDEN: 'Only the host can manage roles.',
  CANNOT_CHANGE_OWN_ROLE: 'You cannot change your own role.',
  INVALID_ROLE: 'That role cannot be assigned.',
  PARTICIPANT_NOT_FOUND: 'That participant has already left the room.',
  INVALID_PAYLOAD: 'No participant was specified.',
  NOT_IN_ROOM: 'You are not in this room any more.',
};

/**
 * Owns all application state and is the only place that talks to Socket.IO.
 * Home and Room stay presentational: they receive props and call the handlers
 * passed to them.
 */
export default function App() {
  const [roomState, setRoomState] = useState(null);
  const [activity, setActivity] = useState([]);
  const [chatMessages, setChatMessages] = useState([]);
  const [error, setError] = useState('');
  // '' | 'create' | 'join' - which action is in flight (drives the loading UI)
  const [pending, setPending] = useState('');
  // 'idle' | 'connecting' | 'connected' | 'disconnected'
  const [connection, setConnection] = useState('idle');
  const [connectionError, setConnectionError] = useState('');
  const [videoError, setVideoError] = useState('');
  // Participant management: its own error channel, plus the row being changed.
  const [memberError, setMemberError] = useState('');
  const [removingUserId, setRemovingUserId] = useState('');
  const [assigningUserId, setAssigningUserId] = useState('');
  // The last command the server told us about - play, pause or seek. The nonce
  // makes sure two identical commands in a row are both delivered to the player.
  const [remoteCommand, setRemoteCommand] = useState(null);
  // The room snapshot to adopt when this client joins. Kept separate from
  // roomState on purpose: roomState changes constantly as people come and go,
  // but a join snapshot must be applied exactly once.
  const [syncTarget, setSyncTarget] = useState(null);
  const [username, setUsername] = useState(getRememberedUsername());

  // The seat we currently hold. A ref lets the socket listeners read the latest
  // value without having to re-register themselves on every change.
  const sessionRef = useRef(null);
  const playbackNonceRef = useRef(0);
  const syncNonceRef = useRef(0);

  // The server is authoritative: `sync_state` replaces the whole room snapshot,
  // while the other events only drive the activity feed.
  useEffect(() => {
    const logActivity = (text) =>
      setActivity((previous) => [
        ...previous.slice(-9),
        { id: `${Date.now()}-${Math.random()}`, text },
      ]);

    const handleSyncState = (state) => {
      setRoomState(state);
      if (Array.isArray(state?.messages)) {
        setChatMessages((previous) => {
          const ids = new Set(previous.map((m) => m.id));
          const newMessages = state.messages.filter((m) => !ids.has(m.id));
          return newMessages.length > 0 ? [...previous, ...newMessages].slice(-100) : previous;
        });
      }
    };

    const handleChatMessage = (message) => {
      setChatMessages((previous) => {
        if (previous.some((m) => m.id === message.id)) return previous;
        return [...previous.slice(-99), message];
      });
    };

    const handleUserJoined = (participant) =>
      logActivity(`${participant.username} joined as ${participant.role}`);
    const handleUserLeft = (participant) => logActivity(`${participant.username} left the party`);

    const handleConnect = () => {
      setConnection('connected');
      setConnectionError('');

      // If we were in a room, the server removed us when the socket dropped.
      // Claim the seat back so the participant list stays truthful.
      const session = sessionRef.current;
      if (!session) return;

      socket.emit('join_room', { ...session, userId: MY_USER_ID }, (response) => {
        if (response?.ok) {
          // The server may have reissued the seat secret; keep whatever it sent.
          if (response.seatToken) {
            rememberSeatToken(session.roomId, response.seatToken);
            sessionRef.current = { ...session, seatToken: response.seatToken };
          }

          if (Array.isArray(response.state?.messages)) {
            setChatMessages(response.state.messages);
          }
          setRoomState(response.state);
          return;
        }

        sessionRef.current = null;
        setRoomState(null);
        setError(JOIN_ERRORS[response?.error] ?? 'Your room is no longer available.');
      });
    };

    const handleDisconnect = (reason) => {
      // A disconnect we asked for (leaving the room) is not an error.
      setConnection(reason === 'io client disconnect' ? 'idle' : 'disconnected');
    };

    const handleConnectError = (err) => {
      setConnection('disconnected');
      setConnectionError(`Connection problem: ${err?.message ?? SERVER_UNREACHABLE}`);
    };

    // A command the server broadcast because someone else asked for it.
    const handleRemoteCommand = (type, time) => {
      playbackNonceRef.current += 1;
      setRemoteCommand({ type, time, nonce: playbackNonceRef.current });
    };
    const handlePlay = () => handleRemoteCommand('play');
    const handlePause = () => handleRemoteCommand('pause');
    const handleSeek = (payload) => handleRemoteCommand('seek', payload?.time);

    // A display-only notice that someone changed the video. The video itself is
    // never taken from here - it only ever comes from sync_state, so there is
    // exactly one path that can set what this client is watching.
    const handleVideoChanged = (payload) => {
      logActivity(payload?.by ? `${payload.by} put on a different video` : 'The video changed');
    };

    // The server refused a privileged command. This arrives on its own channel
    // so it still reaches a client that never asked for an ack.
    const handlePermissionDenied = (payload) => {
      setVideoError(payload?.message ?? 'You are not allowed to do that.');
    };

    /**
     * Someone was removed.
     *
     * The same event goes to the whole room, so the target recognises itself by
     * comparing userId rather than by listening for a different event name.
     */
    const handleParticipantRemoved = (payload) => {
      if (payload?.userId === MY_USER_ID) {
        // Clear the session FIRST. Otherwise the disconnect below would be
        // followed by an automatic re-join, and the removal would undo itself.
        sessionRef.current = null;

        setRoomState(null);
        setSyncTarget(null);
        setRemoteCommand(null);
        setActivity([]);
        setChatMessages([]);
        setMemberError('');
        setVideoError('');
        setRemovingUserId('');
        setError(
          payload?.by
            ? `You were removed from the room by ${payload.by}.`
            : 'You were removed from the room.',
        );

        // Leave deliberately, so Socket.IO does not treat this as a dropped
        // connection and try to reconnect.
        socket.disconnect();
        return;
      }

      logActivity(`${payload?.username ?? 'Someone'} was removed from the room`);
    };

    /**
     * Someone's role changed. As with participant_removed, one event covers both
     * audiences - the target recognises itself by userId.
     */
    const handleRoleAssigned = (payload) => {
      const role = payload?.role === 'moderator' ? 'Moderator' : 'Participant';

      if (payload?.userId === MY_USER_ID) {
        logActivity(`You are now a ${role}`);
        return;
      }

      logActivity(`${payload?.username ?? 'Someone'} is now a ${role}`);
    };

    const handlePopState = () => {
      if (sessionRef.current) {
        handleLeave();
      }
    };

    socket.on('sync_state', handleSyncState);
    socket.on('user_joined', handleUserJoined);
    socket.on('user_left', handleUserLeft);
    socket.on('chat_message', handleChatMessage);
    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleConnectError);
    socket.on('play', handlePlay);
    socket.on('pause', handlePause);
    socket.on('seek', handleSeek);
    socket.on('change_video', handleVideoChanged);
    socket.on('participant_removed', handleParticipantRemoved);
    socket.on('role_assigned', handleRoleAssigned);
    socket.on('permission_denied', handlePermissionDenied);
    window.addEventListener('popstate', handlePopState);

    return () => {
      window.removeEventListener('popstate', handlePopState);
      socket.off('sync_state', handleSyncState);
      socket.off('user_joined', handleUserJoined);
      socket.off('user_left', handleUserLeft);
      socket.off('chat_message', handleChatMessage);
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('connect_error', handleConnectError);
      socket.off('play', handlePlay);
      socket.off('pause', handlePause);
      socket.off('seek', handleSeek);
      socket.off('change_video', handleVideoChanged);
      socket.off('participant_removed', handleParticipantRemoved);
      socket.off('role_assigned', handleRoleAssigned);
      socket.off('permission_denied', handlePermissionDenied);
    };
  }, []);

  /** Opens the socket if needed, then asks the server for a seat in the room. */
  function joinRoom(roomId, name, hostToken) {
    if (!socket.connected) {
      setConnection('connecting');
      socket.connect();
    }

    // `timeout` guarantees the callback runs even when the server never answers,
    // so the loading state can never get stuck forever.
    socket.timeout(JOIN_TIMEOUT_MS).emit(
      'join_room',
      {
        roomId,
        username: name,
        userId: MY_USER_ID,
        hostToken,
        // Proves this browser owns the seat it is reclaiming. The server only
        // restores a seat's role when this matches; otherwise it issues a fresh
        // participant seat, so a forged userId cannot escalate.
        seatToken: getSeatToken(roomId),
      },
      (timeoutError, response) => {
        setPending('');

        if (timeoutError) {
          setError(`${SERVER_UNREACHABLE} (the request timed out)`);
          return;
        }

        if (!response?.ok) {
          setError(JOIN_ERRORS[response?.error] ?? 'Could not join the room.');
          return;
        }

        const state = response.state ?? {};
        const seatToken = response.seatToken ?? '';

        // Keep the seat secret for next time - this is what makes a refresh or
        // a reconnect land back in the same seat.
        rememberSeatToken(roomId, seatToken);

        sessionRef.current = { roomId, username: name, hostToken, seatToken };

        // Hand the player the snapshot it must adopt. This is the new-user
        // synchronisation: videoId, playState and currentTime, all in one go.
        syncNonceRef.current += 1;
        setSyncTarget({
          nonce: syncNonceRef.current,
          videoId: state.video?.videoId ?? null,
          playState: state.playback?.playState ?? 'paused',
          currentTime: state.playback?.currentTime ?? 0,
        });

        setError('');
        setConnectionError('');
        setVideoError('');
        setMemberError('');
        setRemovingUserId('');
        setAssigningUserId('');
        setRemoteCommand(null);
        setActivity([]);
        setChatMessages(Array.isArray(state?.messages) ? state.messages : []);
        setRoomState(state);

        const targetSearch = `?room=${encodeURIComponent(roomId)}`;
        if (window.location.search !== targetSearch) {
          window.history.pushState({ inRoom: true, roomId }, '', targetSearch);
        }
      },
    );
  }

  function handleUsernameChange(value) {
    setUsername(value);
    rememberUsername(value);
  }

  async function handleCreate() {
    const name = username.trim();
    if (!name) {
      setError('Please enter a username first.');
      return;
    }

    setError('');
    setPending('create');

    try {
      const { roomId, hostToken } = await createRoom();
      rememberHostToken(roomId, hostToken);
      joinRoom(roomId, name, hostToken);
    } catch {
      setPending('');
      setError(SERVER_UNREACHABLE);
    }
  }

  async function handleJoin(rawRoomId) {
    const name = username.trim();
    const code = rawRoomId.trim().toUpperCase();

    if (!name) {
      setError('Please enter a username first.');
      return;
    }
    if (!code) {
      setError('Please enter a room code.');
      return;
    }

    setError('');
    setPending('join');

    try {
      if (!(await roomExists(code))) {
        setPending('');
        setError(JOIN_ERRORS.ROOM_NOT_FOUND);
        return;
      }
    } catch {
      setPending('');
      setError(SERVER_UNREACHABLE);
      return;
    }

    // If this browser created the room, the locally stored token makes us host again.
    joinRoom(code, name, getHostToken(code));
  }

  /**
   * Asks the server to play or pause for the whole room.
   *
   * This is called from the player's own state change, so the local player has
   * already moved. The server decides whether the change is allowed.
   */
  function requestPlayback(type, time) {
    setVideoError('');

    // The position is a hint, not a requirement - the server falls back to its
    // own projection when it is missing. `seek` is the event whose whole point
    // is the time, which is why that one is validated strictly.
    socket.timeout(JOIN_TIMEOUT_MS).emit(type, { time }, (timeoutError, response) => {
      if (timeoutError) {
        setVideoError(SERVER_UNREACHABLE);
        return;
      }

      if (!response?.ok) {
        setVideoError(PLAYBACK_ERRORS[response?.error] ?? 'Could not control playback.');
      }
    });
  }

  /**
   * Reports a seek to the room.
   *
   * VideoPanel has already debounced this, so it is called once per seek rather
   * than once per pixel of a drag.
   */
  function requestSeek(time) {
    setVideoError('');

    socket.timeout(JOIN_TIMEOUT_MS).emit('seek', { time }, (timeoutError, response) => {
      if (timeoutError) {
        setVideoError(SERVER_UNREACHABLE);
        return;
      }

      if (!response?.ok) {
        setVideoError(SEEK_ERRORS[response?.error] ?? 'Could not seek.');
      }
    });
  }

  /**
   * Asks the server to change the room's video. The server decides whether this
   * user is allowed to, and re-broadcasts the room state to everyone.
   */
  function changeVideo(videoId) {
    setVideoError('');

    socket.timeout(JOIN_TIMEOUT_MS).emit('change_video', { videoId }, (timeoutError, response) => {
      if (timeoutError) {
        setVideoError(SERVER_UNREACHABLE);
        return;
      }

      if (!response?.ok) {
        setVideoError(VIDEO_ERRORS[response?.error] ?? 'Could not change the video.');
      }
    });
  }

  /**
   * Asks the server to remove someone. The server decides whether this user is
   * allowed to, and enforces it no matter what the UI happens to show.
   */
  function removeParticipant(userId) {
    setMemberError('');
    setRemovingUserId(userId);

    socket.timeout(JOIN_TIMEOUT_MS).emit(
      'remove_participant',
      { userId },
      (timeoutError, response) => {
        setRemovingUserId('');

        if (timeoutError) {
          setMemberError(SERVER_UNREACHABLE);
          return;
        }

        if (!response?.ok) {
          setMemberError(REMOVE_ERRORS[response?.error] ?? 'Could not remove that participant.');
        }
      },
    );
  }

  /**
   * Asks the server to change someone's role. Host-only, and enforced there.
   */
  function assignRole(userId, role) {
    setMemberError('');
    setAssigningUserId(userId);

    socket.timeout(JOIN_TIMEOUT_MS).emit(
      'assign_role',
      { userId, role },
      (timeoutError, response) => {
        setAssigningUserId('');

        if (timeoutError) {
          setMemberError(SERVER_UNREACHABLE);
          return;
        }

        if (!response?.ok) {
          setMemberError(ROLE_ERRORS[response?.error] ?? 'Could not change that role.');
        }
      },
    );
  }

  function handleLeave() {
    sessionRef.current = null;

    // The server also cleans up on disconnect, so leaving works either way.
    if (socket.connected) socket.emit('leave_room', () => socket.disconnect());
    else socket.disconnect();

    setRoomState(null);
    setActivity([]);
    setChatMessages([]);
    setError('');
    setPending('');
    setConnectionError('');
    setVideoError('');
    setMemberError('');
    setRemovingUserId('');
    setAssigningUserId('');
    setRemoteCommand(null);
    setSyncTarget(null);

    if (window.location.search) {
      window.history.pushState({}, '', window.location.pathname);
    }
  }

  function sendChatMessage(text) {
    return new Promise((resolve) => {
      if (!socket.connected) {
        resolve({ ok: false, error: 'NOT_CONNECTED' });
        return;
      }

      socket.timeout(5000).emit('send_chat', { text }, (error, response) => {
        if (error) {
          resolve({ ok: false, error: 'TIMEOUT' });
          return;
        }
        resolve(response ?? { ok: false });
      });
    });
  }

  if (roomState) {
    return (
      <Room
        state={roomState}
        myUserId={MY_USER_ID}
        activity={activity}
        chatMessages={chatMessages}
        onSendMessage={sendChatMessage}
        connection={connection}
        onLeave={handleLeave}
        onChangeVideo={changeVideo}
        videoError={videoError}
        remoteCommand={remoteCommand}
        onLocalPlayback={requestPlayback}
        onSeek={requestSeek}
        syncTarget={syncTarget}
        onRemoveParticipant={removeParticipant}
        removingUserId={removingUserId}
        memberError={memberError}
        onAssignRole={assignRole}
        assigningUserId={assigningUserId}
      />
    );
  }

  return (
    <Home
      initialRoomId={INVITE_ROOM_ID}
      username={username}
      pending={pending}
      error={error}
      connectionError={connectionError}
      onUsernameChange={handleUsernameChange}
      onCreate={handleCreate}
      onJoin={handleJoin}
    />
  );
}
