import mongoose from 'mongoose';

/**
 * Message Sub-schema for live in-room chat history
 */
const chatMessageSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    userId: { type: String, required: true },
    username: { type: String, required: true },
    role: { type: String, enum: ['host', 'moderator', 'participant'], default: 'participant' },
    text: { type: String, required: true, maxlength: 500 },
    timestamp: { type: Number, default: Date.now },
  },
  { _id: false },
);

/**
 * Room Schema for persistent watch party rooms and playback state
 */
const roomSchema = new mongoose.Schema(
  {
    roomId: {
      type: String,
      required: [true, 'Room code is required'],
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    // The secret token held only by the active host
    hostToken: {
      type: String,
      required: [true, 'Host token is required'],
    },
    // Current video state
    video: {
      videoId: { type: String, default: null },
      loadedBy: { type: String, default: null },
    },
    // Playback state (synced across all clients)
    playback: {
      playState: { type: String, enum: ['playing', 'paused'], default: 'paused' },
      currentTime: { type: Number, default: 0 },
      updatedAt: { type: Number, default: () => Date.now() },
    },
    // Sequential video history (used for back navigation)
    videoHistory: [{ type: String }],
    // Recent chat messages buffer
    messages: [chatMessageSchema],
    // Whether room is currently active or has been closed
    isClosed: {
      type: Boolean,
      default: false,
    },
    lastActiveAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  },
);

export const Room = mongoose.models.Room || mongoose.model('Room', roomSchema);
export default Room;
