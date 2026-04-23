'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import SimplePeer from 'simple-peer';
import {
  Mic, MicOff, Video, VideoOff, Phone,
  MessageSquare, ScreenShare, StopCircle,
  Hand, Users, Circle,
  Pin, PinOff, Maximize2, Minimize2, X, CameraOff,
  WifiOff, ChevronDown, ChevronUp,
  Sun, Moon, Smile
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { getSocket, joinRoom, leaveRoom } from '@/lib/socket';
import api from '@/lib/axios';
import toast from 'react-hot-toast';

let _audioContext = null;
function getAudioContext() {
  if (!_audioContext || _audioContext.state === 'closed') {
    _audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (_audioContext.state === 'suspended') _audioContext.resume().catch(() => { });
  return _audioContext;
}
function unlockAudioContext() {
  const unlock = () => { getAudioContext(); document.removeEventListener('touchstart', unlock); document.removeEventListener('click', unlock); };
  document.addEventListener('touchstart', unlock, { once: true, passive: true });
  document.addEventListener('click', unlock, { once: true });
}

function useAudioLevel(stream, enabled, onLevel) {
  const rafRef = useRef(null), analyserRef = useRef(null), sourceRef = useRef(null), onLevelRef = useRef(onLevel);
  onLevelRef.current = onLevel;
  useEffect(() => {
    if (!stream || !enabled) { onLevelRef.current?.(0); return; }
    if (!stream.getAudioTracks().length) return;
    let cancelled = false;
    try {
      const ctx = getAudioContext(), analyser = ctx.createAnalyser();
      analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.6;
      const source = ctx.createMediaStreamSource(stream);
      source.connect(analyser); analyserRef.current = analyser; sourceRef.current = source;
      const data = new Uint8Array(analyser.frequencyBinCount); let lastReport = 0;
      const tick = (ts) => {
        if (cancelled) return;
        if (ts - lastReport >= 33) { analyser.getByteFrequencyData(data); const rms = Math.sqrt(data.reduce((s, v) => s + v * v, 0) / data.length); onLevelRef.current?.(Math.min(rms / 80, 1)); lastReport = ts; }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (e) { console.warn('AudioContext setup failed:', e.message); }
    return () => { cancelled = true; if (rafRef.current) cancelAnimationFrame(rafRef.current); try { sourceRef.current?.disconnect(); } catch (_) { } try { analyserRef.current?.disconnect(); } catch (_) { } sourceRef.current = null; analyserRef.current = null; };
  }, [stream, enabled]);
}

const SPEAKING_THRESHOLD = 0.12, SPEAKING_DEBOUNCE = 2000, SILENCE_GRACE = 3000;

function useActiveSpeaker(levelsRef) {
  const [activeSpeakerId, setActiveSpeakerId] = useState(null);
  const debounceRef = useRef({}), lastActiveRef = useRef(null), silenceTimer = useRef(null);
  useEffect(() => {
    const interval = setInterval(() => {
      const levels = levelsRef.current; let loudestId = null, loudestLevel = SPEAKING_THRESHOLD;
      Object.entries(levels).forEach(([id, lvl]) => { if (lvl > loudestLevel) { loudestLevel = lvl; loudestId = id; } });
      if (loudestId && loudestId !== lastActiveRef.current) {
        if (silenceTimer.current) { clearTimeout(silenceTimer.current); silenceTimer.current = null; }
        if (!debounceRef.current[loudestId]) { debounceRef.current[loudestId] = setTimeout(() => { lastActiveRef.current = loudestId; setActiveSpeakerId(loudestId); delete debounceRef.current[loudestId]; }, SPEAKING_DEBOUNCE); }
      } else if (!loudestId && lastActiveRef.current && !silenceTimer.current) {
        silenceTimer.current = setTimeout(() => { lastActiveRef.current = null; setActiveSpeakerId(null); silenceTimer.current = null; }, SILENCE_GRACE);
      }
    }, 100);
    return () => { clearInterval(interval); Object.values(debounceRef.current).forEach(clearTimeout); if (silenceTimer.current) clearTimeout(silenceTimer.current); };
  }, [levelsRef]);
  return activeSpeakerId;
}

function SpeakerRing({ isActive, level = 0, thumbnail = false }) {
  if (!isActive) return null;
  const mid = Math.round(4 + level * 14), outer = Math.round(level * 22), opacity = (0.45 + level * 0.55).toFixed(2);
  return (
    <div aria-hidden="true" style={{ position: 'absolute', inset: 0, borderRadius: thumbnail ? '0.5rem' : '0.75rem', boxShadow: [`inset 0 0 0 2.5px rgba(34,197,94,${opacity})`, `0 0 ${mid}px rgba(34,197,94,0.65)`, outer > 5 ? `0 0 ${outer}px rgba(34,197,94,0.28)` : null].filter(Boolean).join(', '), transition: 'box-shadow 70ms ease-out', pointerEvents: 'none', zIndex: 10 }} />
  );
}

function NetworkWarningBanner({ onDismiss }) {
  const [expanded, setExpanded] = useState(false);

  const openNetworkSettings = () => {
    try { window.open('ms-settings:network-wifi', '_blank'); } catch (_) { }
  };

  return (
    <div className="bg-amber-900/40 border-b border-amber-700/50 px-4 py-3 shrink-0">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 flex-1">
          <WifiOff className="h-4 w-4 text-amber-400 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="text-amber-200 text-sm font-medium">
              Your connection appears to be unstable. Other participants may not be able to see or hear you clearly.
            </p>
            <button
              onClick={() => setExpanded(p => !p)}
              className="flex items-center gap-1 text-amber-400 text-xs mt-1 hover:text-amber-300 transition-colors"
            >
              {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
              How to fix this
            </button>
            {expanded && (
              <div className="mt-3 space-y-1.5 text-xs text-amber-300/80">
                <p className="font-medium text-amber-300 mb-2">Troubleshooting checklist:</p>
                <p>① Move closer to your Wi-Fi router or switch to a wired connection.</p>
                <p>② Disable VPN or proxy if active — these add latency to video calls.</p>
                <p>③ Close bandwidth-heavy applications (downloads, streaming, backups).</p>
                <p>④ Restart your router if other devices on the same network are also slow.</p>
                <p>⑤ If on mobile data, move to a location with a stronger signal.</p>
                <button
                  onClick={openNetworkSettings}
                  className="mt-2 px-3 py-1.5 bg-amber-700/50 hover:bg-amber-700/80 border border-amber-600/50 rounded-lg text-amber-200 transition-colors"
                >
                  Open Network Settings
                </button>
              </div>
            )}
          </div>
        </div>
        <button onClick={onDismiss} className="text-amber-500 hover:text-amber-700 transition-colors shrink-0 mt-0.5">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function ControlsBar({ isAudioEnabled, isVideoEnabled, isScreenSharing, isMobile, isHandRaised, isRecording, isHost, isEndingMeeting, toggleAudio, toggleVideo, toggleScreenShare, toggleHand, startRecording, stopRecording, handleEndMeeting, leaveMeeting, triggerReaction }) {
  const [showReactions, setShowReactions] = useState(false);

  return (
    <div className="bg-background/95 backdrop-blur border-t border-border px-4 py-3 shrink-0 relative z-50">
      <div className="flex items-center justify-center gap-2 flex-wrap relative">
        <CtrlBtn onClick={toggleAudio} label={isAudioEnabled ? 'Mute' : 'Unmute'} danger={!isAudioEnabled}>{isAudioEnabled ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}</CtrlBtn>
        <CtrlBtn onClick={toggleVideo} label={isVideoEnabled ? 'Stop Video' : 'Start Video'} danger={!isVideoEnabled}>{isVideoEnabled ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}</CtrlBtn>
        {!isMobile && (<CtrlBtn onClick={toggleScreenShare} label={isScreenSharing ? 'Stop Share' : 'Share'} highlight={isScreenSharing}>{isScreenSharing ? <StopCircle className="h-5 w-5" /> : <ScreenShare className="h-5 w-5" />}</CtrlBtn>)}
        <CtrlBtn onClick={toggleHand} label={isHandRaised ? 'Lower Hand' : 'Raise Hand'} warn={isHandRaised}><Hand className="h-5 w-5" /></CtrlBtn>

        <div className="relative">
          <CtrlBtn onClick={() => setShowReactions(p => !p)} label="React"><Smile className="h-5 w-5" /></CtrlBtn>
          {showReactions && (
            <div className="absolute bottom-[110%] left-1/2 -translate-x-1/2 flex gap-2 bg-popover border border-border p-2 rounded-xl shadow-lg mb-2">
              {['👍', '❤️', '😂', '🎉', '👏'].map(emoji => (
                <button
                  key={emoji}
                  onClick={() => { triggerReaction(emoji); setShowReactions(false); }}
                  className="text-2xl hover:scale-125 transition-transform"
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>

        {isHost && (<CtrlBtn onClick={isRecording ? stopRecording : startRecording} label={isRecording ? 'Stop Rec' : 'Record'} danger={isRecording}><Circle className={cn('h-5 w-5', isRecording && 'fill-current')} /></CtrlBtn>)}
        {isHost && (<div className="flex flex-col items-center gap-1"><button onClick={handleEndMeeting} disabled={isEndingMeeting} className="h-12 w-12 rounded-full bg-red-700 hover:bg-red-800 disabled:opacity-50 flex items-center justify-center transition-colors"><StopCircle className="h-5 w-5 text-white" /></button><span className="text-xs text-muted-foreground font-medium">End</span></div>)}
        <div className="flex flex-col items-center gap-1"><button onClick={leaveMeeting} className="h-12 w-12 rounded-full bg-red-600 hover:bg-red-700 flex items-center justify-center transition-colors"><Phone className="h-5 w-5 text-white rotate-[135deg]" /></button><span className="text-xs text-muted-foreground font-medium">Leave</span></div>
      </div>
    </div>
  );
}

export default function MeetingRoom({ meetingId, user }) {
  const router = useRouter();
  const socketRef = useRef(null), localVideoRef = useRef(null), localStreamRef = useRef(null), peersRef = useRef({});
  const mediaRecorderRef = useRef(null), myRecorderRef = useRef(null), recordingChunksRef = useRef([]);
  const myChunksRef = useRef([]), chunkIntervalRef = useRef(null), chatBottomRef = useRef(null), fullscreenContainerRef = useRef(null);
  const myRecordingStartTimeRef = useRef(null), audioLevelsRef = useRef({});
  const initSegmentRef = useRef(null);

  const [networkWarning, setNetworkWarning] = useState(false);
  const networkWarningTimerRef = useRef(null);
  const lastPeerActivityRef = useRef(Date.now());

  const [ringLevels, setRingLevels] = useState({});
  const activeSpeakerId = useActiveSpeaker(audioLevelsRef);
  const [participantNames, setParticipantNames] = useState({});
  const [remoteStreams, setRemoteStreams] = useState({});
  const [isAudioEnabled, setIsAudioEnabled] = useState(true);
  const [isVideoEnabled, setIsVideoEnabled] = useState(true);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isHandRaised, setIsHandRaised] = useState(false);
  const [raisedHands, setRaisedHands] = useState(new Set());
  const [chatOpen, setChatOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [unreadCount, setUnreadCount] = useState(0);
  const [isConnecting, setIsConnecting] = useState(true);
  const [isHost, setIsHost] = useState(false);
  const [isEndingMeeting, setIsEndingMeeting] = useState(false);
  const [pinnedUserId, setPinnedUserId] = useState(null);
  const [fullscreenUserId, setFullscreenUserId] = useState(null);
  const [meetingCancelled, setMeetingCancelled] = useState(false);
  const [isNativeFullscreen, setIsNativeFullscreen] = useState(false);
  const [isMyRecording, setIsMyRecording] = useState(false);
  const [participantMediaState, setParticipantMediaState] = useState({});
  const [theme, setTheme] = useState('dark');
  const [reactions, setReactions] = useState([]);

  const isMobile = typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const myId = (user?._id || user?.id)?.toString();
  const myName = user?.firstName ? `${user.firstName} ${user.lastName}` : 'You';

  useEffect(() => {
    if (typeof document !== 'undefined') {
      setTheme(document.documentElement.classList.contains('dark') ? 'dark' : 'light');
    }
  }, []);

  const toggleTheme = () => {
    const newTheme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.classList.toggle('dark');
    localStorage.setItem('theme', newTheme);
    setTheme(newTheme);
  };

  const triggerReactionEvent = (emoji) => {
    if (!socketRef.current) return;
    const reactionId = Date.now() + Math.random();
    setReactions(prev => [...prev, { id: reactionId, emoji, left: Math.random() * 80 + 10 }]);
    setTimeout(() => setReactions(prev => prev.filter(r => r.id !== reactionId)), 3000);
    socketRef.current.emit('chat-message', { meetingId, message: `EMOJI_REACTION:${emoji}` });
  };

  const handleAudioLevel = useCallback((id, level) => {
    audioLevelsRef.current[id] = level;
    if (id !== myId && level > 0.02) lastPeerActivityRef.current = Date.now();
    setRingLevels(prev => { if (Math.abs((prev[id] || 0) - level) < 0.015) return prev; return { ...prev, [id]: level }; });
  }, [myId]);

  useEffect(() => {
    const interval = setInterval(() => {
      const hasPeers = Object.keys(peersRef.current).length > 0;
      if (!hasPeers) return;
      if (Date.now() - lastPeerActivityRef.current > 15000) {
        setNetworkWarning(true);
      }
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const fetchParticipantNames = useCallback(async () => {
    try {
      const res = await api.get(`/meetings/${meetingId}`);
      const nameMap = {};
      (res.data.meeting?.attendees || []).forEach(a => { const u = a.user; if (u?._id) nameMap[u._id.toString()] = { fullName: `${u.firstName} ${u.lastName}`, role: u.role }; });
      setParticipantNames(nameMap);
    } catch (e) { console.warn('Could not fetch participant names'); }
  }, [meetingId]);

  const getParticipantName = useCallback((userId) => {
    if (!userId) return 'Participant';
    const id = userId.toString();
    if (id === myId) return myName;
    return participantNames[id]?.fullName || 'Participant';
  }, [participantNames, myId, myName]);

  const setLocalVideoRef = useCallback((el) => { localVideoRef.current = el; if (el && localStreamRef.current) el.srcObject = localStreamRef.current; }, []);

  const broadcastMediaState = useCallback((audio, video) => {
    socketRef.current?.emit('media-state', { meetingId, audio, video });
  }, [meetingId]);

  useEffect(() => {
    const onChange = () => setIsNativeFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const handleFullscreen = useCallback((userId) => {
    if (fullscreenUserId === userId && isNativeFullscreen) { document.exitFullscreen().catch(() => { }); setFullscreenUserId(null); }
    else { setFullscreenUserId(userId); setTimeout(() => { fullscreenContainerRef.current?.requestFullscreen().catch(e => console.warn('Fullscreen failed:', e.message)); }, 50); }
  }, [fullscreenUserId, isNativeFullscreen]);

  const exitFullscreen = useCallback(() => { if (document.fullscreenElement) document.exitFullscreen().catch(() => { }); setFullscreenUserId(null); }, []);

  const startMyRecording = useCallback((stream) => {
    if (!stream) return;
    if (myRecorderRef.current) {
      try { if (myRecorderRef.current.state !== 'inactive') myRecorderRef.current.stop(); } catch (_) { }
      myRecorderRef.current = null;
    }
    if (chunkIntervalRef.current) { clearInterval(chunkIntervalRef.current); chunkIntervalRef.current = null; }
    try {
      const audioOnly = new MediaStream(stream.getAudioTracks());
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      const recorder = new MediaRecorder(audioOnly, { mimeType });
      myChunksRef.current = [];
      myRecordingStartTimeRef.current = Date.now();
      initSegmentRef.current = null;
      recorder.ondataavailable = e => {
        if (e.data.size > 0) {
          if (!initSegmentRef.current) {
            initSegmentRef.current = e.data;
          }
          myChunksRef.current.push(e.data);
        }
      };
      chunkIntervalRef.current = setInterval(() => {
        if (!myChunksRef.current.length) return;
        const chunks = [...myChunksRef.current];
        myChunksRef.current = [];
        const blobChunks = (initSegmentRef.current && chunks[0] !== initSegmentRef.current)
          ? [initSegmentRef.current, ...chunks]
          : chunks;
        const blob = new Blob(blobChunks, { type: mimeType });
        blob.arrayBuffer().then(buf => {
          socketRef.current?.emit('audio-chunk', {
            meetingId,
            audioChunk: buf,
            timestamp: Date.now(),
            recordingStartTime: myRecordingStartTimeRef.current
          });
        }).catch(e => console.warn('Chunk send failed:', e));
      }, 10000);
      recorder.start(1000);
      myRecorderRef.current = recorder;
      setIsMyRecording(true);
    } catch (e) { console.warn('Per-device recording failed:', e.message); }
  }, [meetingId]);

  const stopMyRecording = useCallback(async () => {
    if (chunkIntervalRef.current) { clearInterval(chunkIntervalRef.current); chunkIntervalRef.current = null; }
    if (myChunksRef.current.length > 0 && myRecorderRef.current) {
      const mimeType = myRecorderRef.current.mimeType || 'audio/webm';
      const blob = new Blob(
        (initSegmentRef.current && myChunksRef.current[0] !== initSegmentRef.current)
          ? [initSegmentRef.current, ...myChunksRef.current]
          : myChunksRef.current,
        { type: mimeType }
      );
      myChunksRef.current = [];
      try {
        const buf = await blob.arrayBuffer();
        if (socketRef.current?.connected) {
          socketRef.current.emit('audio-chunk', {
            meetingId,
            audioChunk: buf,
            timestamp: Date.now(),
            recordingStartTime: myRecordingStartTimeRef.current
          });
          await new Promise(r => setTimeout(r, 500));
        }
      } catch (_) { }
    }
    if (myRecorderRef.current?.state !== 'inactive') myRecorderRef.current?.stop();
    myRecorderRef.current = null; myRecordingStartTimeRef.current = null; initSegmentRef.current = null; setIsMyRecording(false);
  }, [meetingId]);

  useEffect(() => {
    let mounted = true;
    const init = async () => {
      try {
        unlockAudioContext(); await fetchParticipantNames();
        const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, facingMode: 'user' }, audio: true });
        if (!mounted) { stream.getTracks().forEach(t => t.stop()); return; }
        localStreamRef.current = stream;
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
        socketRef.current = getSocket();
        try {
          const joinRes = await api.post(`/meetings/${meetingId}/join`);
          const mtg = joinRes.data.meeting;
          const hostId = (mtg?.host?._id || mtg?.host)?.toString();
          if (mounted) setIsHost(hostId === myId);
        } catch (e) { console.warn('Join API:', e.message); }

        broadcastMediaState(true, true);

        socketRef.current.on('participant-names', nameMap => {
          if (!mounted) return;
          setParticipantNames(prev => { const merged = { ...prev }; Object.entries(nameMap).forEach(([uid, name]) => { merged[uid] = { ...merged[uid], fullName: name }; }); return merged; });
        });

        socketRef.current.on('participant-joined', ({ userId, displayName }) => {
          if (!mounted) return;
          setParticipantNames(prev => ({ ...prev, [userId]: { ...prev[userId], fullName: displayName } }));
          broadcastMediaState(isAudioEnabled, isVideoEnabled);
        });

        socketRef.current.on('existing-users', users => {
          if (!mounted) return;
          users.forEach(({ userId }) => { if (!userId || userId?.toString() === myId) return; createPeer(userId, true, stream); });
        });

        socketRef.current.on('user-connected', userId => {
          if (!mounted || !userId || userId?.toString() === myId) return;
          toast.success(`${getParticipantName(userId)} joined`); fetchParticipantNames();
          if (!peersRef.current[userId]) createPeer(userId, false, stream);
          lastPeerActivityRef.current = Date.now();
          setNetworkWarning(false);
        });

        socketRef.current.on('user-disconnected', userId => {
          if (!mounted) return;
          destroyPeer(userId); toast(`${getParticipantName(userId)} left`, { icon: '👋' });
          setParticipantMediaState(prev => { const n = { ...prev }; delete n[userId?.toString()]; return n; });
        });

        socketRef.current.on('offer', ({ offer, userId }) => { if (!mounted) return; if (peersRef.current[userId]) peersRef.current[userId].signal(offer); else createPeer(userId, false, stream, offer); });
        socketRef.current.on('answer', ({ answer, userId }) => { peersRef.current[userId]?.signal(answer); });
        socketRef.current.on('ice-candidate', ({ candidate, userId }) => { peersRef.current[userId]?.signal(candidate); });
        socketRef.current.on('peer-restart', ({ userId: uid }) => { if (!mounted) return; destroyPeer(uid); });

        socketRef.current.on('media-state-update', ({ userId, audio, video }) => {
          if (!mounted || userId?.toString() === myId) return;
          setParticipantMediaState(prev => ({ ...prev, [userId.toString()]: { audio, video } }));
        });

        socketRef.current.on('chat-message', ({ userId, message, timestamp, userName }) => {
          if (!mounted || userId?.toString() === myId) return;

          if (message.startsWith('EMOJI_REACTION:')) {
            const emoji = message.split(':')[1];
            const reactionId = Date.now() + Math.random();
            setReactions(prev => [...prev, { id: reactionId, emoji, left: Math.random() * 80 + 10 }]);
            setTimeout(() => setReactions(prev => prev.filter(r => r.id !== reactionId)), 3000);
            return;
          }

          const senderName = userName || getParticipantName(userId);
          setMessages(prev => [...prev, { id: Date.now() + Math.random(), userId: userId?.toString(), userName: senderName, message, timestamp, isOwn: false }]);
          setChatOpen(prev => { if (!prev) { setUnreadCount(c => c + 1); toast(`💬 ${senderName}: ${message.substring(0, 40)}`, { duration: 3000 }); } return prev; });
        });

        socketRef.current.on('hand-raised', ({ userId }) => {
          if (!mounted) return;
          setRaisedHands(prev => new Set([...prev, userId?.toString()]));
          if (userId?.toString() !== myId) {
            toast(`✋ ${getParticipantName(userId)} raised their hand`, { duration: 5000 });
          }
        });
        socketRef.current.on('hand-lowered', ({ userId }) => { if (!mounted) return; setRaisedHands(prev => { const n = new Set(prev); n.delete(userId?.toString()); return n; }); });

        socketRef.current.on('recording-started', () => {
          setIsRecording(true); if (mounted && localStreamRef.current) startMyRecording(localStreamRef.current);
        });

        socketRef.current.on('recording-status', (isCurrentlyRecording) => {
          if (!mounted) return;
          setIsRecording(isCurrentlyRecording);
          if (isCurrentlyRecording && localStreamRef.current) {
            startMyRecording(localStreamRef.current);
          }
        });

        socketRef.current.on('recording-stopped', () => { setIsRecording(false); stopMyRecording(); });
        socketRef.current.on('meeting-ended', async () => {
          toast.success('Meeting ended by host');
          await stopMyRecording();
          if (socketRef.current?.connected) {
            socketRef.current.emit('flush-my-chunks', { meetingId });
            await new Promise(r => setTimeout(r, 2000));
          }
          cleanup();
          router.push(`/meetings/${meetingId}`);
        });
        socketRef.current.on('meeting-cancelled', ({ message }) => { setMeetingCancelled(true); toast.error(message || 'Meeting has been cancelled by the host'); stopMyRecording(); cleanup(); setTimeout(() => router.push('/meetings/history'), 2000); });

        joinRoom(meetingId, myId);
        if (mounted) setIsConnecting(false);
      } catch (error) {
        console.error('Init error:', error);
        if (mounted) { toast.error(error.name === 'NotAllowedError' ? 'Camera/microphone access denied.' : 'Failed to initialize meeting room.'); setIsConnecting(false); }
      }
    };
    init();
    return () => { mounted = false; stopMyRecording(); cleanup(); };
  }, [meetingId, myId]);

  useEffect(() => { chatBottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  useEffect(() => { if (chatOpen) setUnreadCount(0); }, [chatOpen]);

  const createPeer = (userId, initiator, stream, incomingOffer = null) => {
    if (peersRef.current[userId]) { try { peersRef.current[userId].destroy(); } catch (_) { } delete peersRef.current[userId]; }
    const peer = new SimplePeer({ initiator, trickle: true, stream, config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }, { urls: 'turn:mainline.proxy.rlwy.net:10424', username: 'catalyst', credential: 'catalyst123' }, { urls: 'turn:mainline.proxy.rlwy.net:10424?transport=tcp', username: 'catalyst', credential: 'catalyst123' }, { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }] } });
    peer.on('signal', data => { if (!socketRef.current) return; if (data.type === 'offer') socketRef.current.emit('offer', { meetingId, offer: data, targetUserId: userId }); else if (data.type === 'answer') socketRef.current.emit('answer', { meetingId, answer: data, targetUserId: userId }); else if (data.candidate) socketRef.current.emit('ice-candidate', { meetingId, candidate: data, targetUserId: userId }); });
    peer.on('stream', remoteStream => {
      setRemoteStreams(prev => ({ ...prev, [userId]: remoteStream }));
      lastPeerActivityRef.current = Date.now();
      setNetworkWarning(false);
    });
    peer.on('close', () => destroyPeer(userId));
    peer.on('error', err => { console.warn(`Peer error ${userId}:`, err.message); if (err.message.includes('Connection failed') && localStreamRef.current) { setTimeout(() => { socketRef.current?.emit('peer-restart', { meetingId, targetUserId: userId }); destroyPeer(userId); createPeer(userId, true, localStreamRef.current); }, 3000); } setRemoteStreams(prev => { const n = { ...prev }; delete n[userId]; return n; }); });

    if (peer._pc) {
      peer._pc.onconnectionstatechange = () => {
        const state = peer._pc?.connectionState;
        if (state === 'disconnected' || state === 'failed') {
          setNetworkWarning(true);
        } else if (state === 'connected') {
          lastPeerActivityRef.current = Date.now();
          setNetworkWarning(false);
        }
      };
    }

    if (incomingOffer) peer.signal(incomingOffer);
    peersRef.current[userId] = peer;
  };

  const destroyPeer = (userId) => {
    try { peersRef.current[userId]?.destroy(); } catch (_) { }
    delete peersRef.current[userId];
    setRemoteStreams(prev => { const n = { ...prev }; delete n[userId]; return n; });
    setPinnedUserId(prev => prev === userId ? null : prev);
    delete audioLevelsRef.current[userId];
    setRingLevels(prev => { const n = { ...prev }; delete n[userId]; return n; });
  };

  const cleanup = () => {
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    localStreamRef.current = null;
    Object.keys(peersRef.current).forEach(destroyPeer);
    if (networkWarningTimerRef.current) clearTimeout(networkWarningTimerRef.current);
    try { leaveRoom(meetingId, myId); api.post(`/meetings/${meetingId}/leave`).catch(() => { }); } catch (_) { }
  };

  const toggleAudio = useCallback(() => {
    const newEnabled = !isAudioEnabled;
    localStreamRef.current?.getAudioTracks().forEach(t => { t.enabled = newEnabled; });
    setIsAudioEnabled(newEnabled);
    broadcastMediaState(newEnabled, isVideoEnabled);
  }, [isAudioEnabled, isVideoEnabled, broadcastMediaState]);

  const toggleVideo = useCallback(() => {
    const newEnabled = !isVideoEnabled;
    localStreamRef.current?.getVideoTracks().forEach(t => { t.enabled = newEnabled; });
    setIsVideoEnabled(newEnabled);
    broadcastMediaState(isAudioEnabled, newEnabled);
  }, [isAudioEnabled, isVideoEnabled, broadcastMediaState]);

  const stopScreenShare = useCallback(() => {
    const cameraTrack = localStreamRef.current?.getVideoTracks()[0];
    if (cameraTrack) { Object.values(peersRef.current).forEach(peer => { try { const sender = peer._pc?.getSenders().find(s => s.track?.kind === 'video'); sender?.replaceTrack(cameraTrack); } catch (_) { } }); }
    if (localVideoRef.current && localStreamRef.current) localVideoRef.current.srcObject = localStreamRef.current;
    setIsScreenSharing(false);
  }, []);

  const toggleScreenShare = useCallback(async () => {
    try {
      if (!isScreenSharing) {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always' }, audio: false });
        const screenTrack = screenStream.getVideoTracks()[0];
        Object.values(peersRef.current).forEach(peer => { try { const sender = peer._pc?.getSenders().find(s => s.track?.kind === 'video'); sender?.replaceTrack(screenTrack); } catch (_) { } });
        if (localVideoRef.current) localVideoRef.current.srcObject = screenStream;
        screenTrack.onended = stopScreenShare; setIsScreenSharing(true);
      } else { stopScreenShare(); }
    } catch (e) { if (e.name !== 'NotAllowedError') toast.error('Screen sharing failed'); setIsScreenSharing(false); }
  }, [isScreenSharing, stopScreenShare]);

  const toggleHand = useCallback(() => {
    if (!socketRef.current) return;
    if (isHandRaised) { socketRef.current.emit('lower-hand', { meetingId }); setRaisedHands(prev => { const n = new Set(prev); n.delete(myId); return n; }); }
    else { socketRef.current.emit('raise-hand', { meetingId }); setRaisedHands(prev => new Set([...prev, myId])); }
    setIsHandRaised(p => !p);
  }, [isHandRaised, meetingId, myId]);

  const startRecording = useCallback(() => {
    if (!localStreamRef.current) return;
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)(), destination = audioContext.createMediaStreamDestination();
      audioContext.createMediaStreamSource(localStreamRef.current).connect(destination);
      Object.entries(remoteStreams).forEach(([uid, rs]) => { if (rs?.getAudioTracks().length) { try { audioContext.createMediaStreamSource(rs).connect(destination); } catch (e) { console.warn('Remote audio mix failed for', uid, e.message); } } });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
      const recorder = new MediaRecorder(destination.stream, { mimeType });
      recordingChunksRef.current = [];
      recorder.ondataavailable = e => { if (e.data.size > 0) recordingChunksRef.current.push(e.data); };
      recorder.onstop = async () => {
        const chunks = [...recordingChunksRef.current];
        recordingChunksRef.current = [];
        const blob = new Blob(chunks, { type: 'audio/webm' });

        try {
          toast.loading('Syncing per-device audio logs...', { id: 'upload' });

          await stopMyRecording();

          await new Promise(r => setTimeout(r, 2500));

          const perDeviceAudio = await new Promise(resolve => {
            const timeout = setTimeout(() => {
              console.warn('Per-device audio sync timed out');
              resolve([]);
            }, 15000);

            socketRef.current?.once('transcript-queue', ({ perDeviceAudio: pda }) => {
              clearTimeout(timeout);
              resolve(pda || []);
            });

            const expectedParticipants = Object.keys(peersRef.current).length;
            socketRef.current?.emit('get-transcript-queue', { meetingId, expectedParticipants });
          });

          // ── FIX: Strip server-internal fields (_vadComplete, audioBuffer) before
          // sending to the controller. Without this, JSON.stringify serializes raw
          // Buffer objects as {"type":"Buffer","data":[...]} making the payload
          // enormous and causing perDeviceAudio to be silently dropped on the server.
          const cleanedPerDeviceAudio = perDeviceAudio.map(({ _vadComplete, ...device }) => ({
            userId: device.userId,
            userName: device.userName,
            recordingStartTime: device.recordingStartTime,
            audioKey: device.audioKey,
            chunks: (device.chunks || []).map(({ audioKey, timestamp, chunkIndex, voiceRatio, hasVoice }) => ({
              audioKey,
              timestamp,
              chunkIndex,
              voiceRatio,
              hasVoice,
            })),
          }));

          const fd = new FormData();
          fd.append('recording', blob, 'meeting-recording.webm');
          if (cleanedPerDeviceAudio.length > 0) {
            fd.append('perDeviceAudio', JSON.stringify(cleanedPerDeviceAudio));
          }

          toast.loading('Uploading recording...', { id: 'upload' });
          await api.post(`/meetings/${meetingId}/upload-recording`, fd, {
            headers: { 'Content-Type': 'multipart/form-data' }
          });

          toast.success(
            'Recording saved! Go to the meeting page and click "Analyze Meeting" when ready.',
            { id: 'upload', duration: 6000 }
          );
        } catch (e) {
          console.error('Upload failed:', e);
          toast.error('Failed to upload recording. Please try manual upload in history.', { id: 'upload' });
        }
      };
      recorder.start(1000); mediaRecorderRef.current = recorder;
      socketRef.current?.emit('start-recording', { meetingId }); setIsRecording(true); toast.success('Recording started');
    } catch (e) { toast.error('Could not start recording: ' + e.message); }
  }, [meetingId, remoteStreams, stopMyRecording]);

  const stopRecording = useCallback(() => { if (mediaRecorderRef.current?.state !== 'inactive') mediaRecorderRef.current?.stop(); socketRef.current?.emit('stop-recording', { meetingId }); setIsRecording(false); toast.success('Recording stopped — uploading...'); }, [meetingId]);
  const leaveMeeting = useCallback(() => { stopMyRecording(); cleanup(); router.push('/meetings/history'); }, [stopMyRecording]);

  const handleEndMeeting = useCallback(async () => {
    if (!isHost) return;
    setIsEndingMeeting(true);
    try {
      await api.post(`/meetings/${meetingId}/end`);
      if (isRecording && mediaRecorderRef.current?.state !== 'inactive') {
        toast.loading('Saving recording...', { id: 'end-meeting' });
        await new Promise((resolve) => {
          const originalOnStop = mediaRecorderRef.current.onstop;
          mediaRecorderRef.current.onstop = async (e) => {
            try { if (originalOnStop) await originalOnStop.call(mediaRecorderRef.current, e); } catch (_) { }
            finally { resolve(); }
          };
          mediaRecorderRef.current.stop();
          socketRef.current?.emit('stop-recording', { meetingId });
          setIsRecording(false);
        });
        toast.dismiss('end-meeting');
      } else { stopMyRecording(); }
      toast.success('Meeting ended'); cleanup(); router.push(`/meetings/${meetingId}`);
    } catch (e) { toast.error(e?.response?.data?.message || 'Failed to end meeting'); setIsEndingMeeting(false); }
  }, [isHost, isRecording, meetingId, stopMyRecording]);

  if (meetingCancelled) return (
    <div className="h-screen flex items-center justify-center bg-background text-foreground">
      <div className="text-center space-y-4">
        <div className="w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center mx-auto"><X className="h-8 w-8 text-red-500" /></div>
        <h2 className="text-xl font-semibold">Meeting Cancelled</h2>
        <p className="text-muted-foreground">This meeting has been cancelled by the host.</p>
        <p className="text-muted-foreground text-sm">Redirecting to meetings...</p>
      </div>
    </div>
  );

  if (isConnecting) return (
    <div className="h-screen flex items-center justify-center bg-background text-foreground">
      <div className="text-center space-y-4">
        <div className="animate-spin h-14 w-14 border-2 border-primary border-t-transparent rounded-full mx-auto" />
        <p className="font-medium">Setting up your camera and microphone...</p>
        <p className="text-muted-foreground text-sm">Please allow camera and microphone access when prompted</p>
      </div>
    </div>
  );

  const remoteEntries = Object.entries(remoteStreams);
  const totalParticipants = remoteEntries.length + 1;
  const shouldZoom = !pinnedUserId && totalParticipants > 1 && activeSpeakerId !== null;
  const zoomedId = shouldZoom ? activeSpeakerId : null;

  const controlsProps = { isAudioEnabled, isVideoEnabled, isScreenSharing, isMobile, isHandRaised, isRecording, isHost, isEndingMeeting, toggleAudio, toggleVideo, toggleScreenShare, toggleHand, startRecording, stopRecording, handleEndMeeting, leaveMeeting, triggerReaction: triggerReactionEvent };
  const remoteProps = (uid) => ({ isMuted: participantMediaState[uid]?.audio === false, isCameraOff: participantMediaState[uid]?.video === false });

  const getGridClasses = (count) => {
    if (count === 1) return 'w-full max-w-6xl';
    if (count === 2) return 'w-full md:w-[48%] max-w-4xl';
    if (count <= 4) return 'w-[48%] max-w-2xl';
    if (count <= 6) return 'w-[32%] max-w-xl';
    if (count <= 9) return 'w-[32%] max-w-lg';
    return 'w-[24%] max-w-md';
  };
  const tileWidthClass = getGridClasses(totalParticipants);

  return (
    <div className="h-screen bg-background text-foreground flex flex-col overflow-hidden relative">
      <style>{`
        @keyframes float-up {
          0% { transform: translateY(0) scale(0.8); opacity: 1; }
          100% { transform: translateY(-300px) scale(1.5); opacity: 0; }
        }
        .emoji-float {
          position: fixed;
          bottom: 100px;
          font-size: 2.5rem;
          animation: float-up 3s ease-out forwards;
          pointer-events: none;
          z-index: 9999;
        }
      `}</style>

      {reactions.map(r => (
        <div key={r.id} className="emoji-float" style={{ left: `${r.left}%` }}>{r.emoji}</div>
      ))}

      {fullscreenUserId && (
        <div ref={fullscreenContainerRef} className="fixed inset-0 z-[110] bg-black flex flex-col">
          <div className="flex-1 min-h-0 relative">
            {fullscreenUserId === 'local' ? (
              <LocalTile videoRef={setLocalVideoRef} name={myName} isHost={isHost} isAudioEnabled={isAudioEnabled} isVideoEnabled={isVideoEnabled} isScreenSharing={isScreenSharing} isHandRaised={raisedHands.has(myId)} isPinned={false} onPin={() => { }} onFullscreen={exitFullscreen} isFullscreen large stream={localStreamRef.current} audioEnabled={isAudioEnabled} isActiveSpeaker={activeSpeakerId === myId} audioLevel={ringLevels[myId] || 0} onAudioLevel={lvl => handleAudioLevel(myId, lvl)} />
            ) : (
              <RemoteTile userId={fullscreenUserId} stream={remoteStreams[fullscreenUserId]} name={getParticipantName(fullscreenUserId)} isHandRaised={raisedHands.has(fullscreenUserId)} isPinned={false} onPin={() => { }} onFullscreen={exitFullscreen} isFullscreen large isActiveSpeaker={activeSpeakerId === fullscreenUserId} audioLevel={ringLevels[fullscreenUserId] || 0} onAudioLevel={lvl => handleAudioLevel(fullscreenUserId, lvl)} {...remoteProps(fullscreenUserId)} />
            )}
            <ControlsBar {...controlsProps} />
          </div>
        </div>
      )}

      <header className="bg-background border-b border-border px-4 py-3 flex items-center justify-between shrink-0 z-40 relative">
        <div className="flex items-center gap-3">
          <h1 className="font-semibold text-foreground">Meeting Room</h1>
          {isRecording && (<Badge className="bg-red-500/20 text-red-500 flex items-center gap-1.5 animate-pulse"><Circle className="h-2 w-2 fill-red-500" /> Recording</Badge>)}
          {raisedHands.size > 0 && (<Badge className="bg-yellow-500/20 text-yellow-500">✋ {raisedHands.size}</Badge>)}
          {networkWarning && (<Badge className="bg-amber-500/20 text-amber-500 flex items-center gap-1.5"><WifiOff className="h-3 w-3" /> Unstable</Badge>)}
        </div>
        <div className="flex items-center gap-3">
          <button onClick={toggleTheme} className="p-2 rounded-lg text-muted-foreground hover:bg-muted transition-colors">
            {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </button>
          <div className="flex items-center gap-1.5 text-muted-foreground text-sm"><Users className="h-4 w-4" /><span>{totalParticipants}</span></div>
          <button onClick={() => setChatOpen(p => !p)} className={cn('relative p-2 rounded-lg transition-colors', chatOpen ? 'bg-primary/20 text-primary' : 'text-muted-foreground hover:bg-muted')}>
            <MessageSquare className="h-5 w-5" />
            {unreadCount > 0 && (<span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs w-4 h-4 rounded-full flex items-center justify-center font-bold">{unreadCount > 9 ? '9+' : unreadCount}</span>)}
          </button>
        </div>
      </header>

      {isRecording && !isHost && (<div className="bg-red-900/30 border-b border-red-800/50 px-4 py-2 text-center text-sm text-red-400 shrink-0 relative z-30">🔴 This meeting is being recorded</div>)}

      {networkWarning && (
        <div className="relative z-30">
          <NetworkWarningBanner onDismiss={() => setNetworkWarning(false)} />
        </div>
      )}

      <div className="flex-1 min-h-0 flex overflow-hidden relative">
        <div className={cn('flex-1 min-w-0 overflow-hidden transition-all duration-200 h-full flex flex-col', chatOpen && 'md:mr-80')}>
          {pinnedUserId ? (
            <div className="flex flex-col gap-2 h-full p-2">
              <div className="flex-1 min-h-0 flex items-center justify-center">
                <div className="w-full h-full max-w-6xl flex items-center justify-center">
                  {pinnedUserId === 'local' ? (
                    <LocalTile videoRef={setLocalVideoRef} name={myName} isHost={isHost} isAudioEnabled={isAudioEnabled} isVideoEnabled={isVideoEnabled} isScreenSharing={isScreenSharing} isHandRaised={raisedHands.has(myId)} isPinned onPin={() => setPinnedUserId(null)} onFullscreen={() => handleFullscreen('local')} large stream={localStreamRef.current} audioEnabled={isAudioEnabled} isActiveSpeaker={activeSpeakerId === myId} audioLevel={ringLevels[myId] || 0} onAudioLevel={lvl => handleAudioLevel(myId, lvl)} />
                  ) : (
                    <RemoteTile userId={pinnedUserId} stream={remoteStreams[pinnedUserId]} name={getParticipantName(pinnedUserId)} isHandRaised={raisedHands.has(pinnedUserId)} isPinned onPin={() => setPinnedUserId(null)} onFullscreen={() => handleFullscreen(pinnedUserId)} large isActiveSpeaker={activeSpeakerId === pinnedUserId} audioLevel={ringLevels[pinnedUserId] || 0} onAudioLevel={lvl => handleAudioLevel(pinnedUserId, lvl)} {...remoteProps(pinnedUserId)} />
                  )}
                </div>
              </div>
              <div className="h-32 shrink-0 flex gap-2 overflow-x-auto overflow-y-hidden pb-2 justify-center">
                {pinnedUserId !== 'local' && (<LocalTile videoRef={setLocalVideoRef} name="You" isHost={isHost} isAudioEnabled={isAudioEnabled} isVideoEnabled={isVideoEnabled} isScreenSharing={isScreenSharing} isHandRaised={raisedHands.has(myId)} isPinned={false} onPin={() => setPinnedUserId('local')} onFullscreen={() => handleFullscreen('local')} thumbnail stream={localStreamRef.current} audioEnabled={isAudioEnabled} isActiveSpeaker={activeSpeakerId === myId} audioLevel={ringLevels[myId] || 0} onAudioLevel={lvl => handleAudioLevel(myId, lvl)} />)}
                {remoteEntries.filter(([uid]) => uid !== pinnedUserId).map(([uid, st]) => (<RemoteTile key={uid} userId={uid} stream={st} name={getParticipantName(uid)} isHandRaised={raisedHands.has(uid)} isPinned={false} onPin={() => setPinnedUserId(uid)} onFullscreen={() => handleFullscreen(uid)} thumbnail isActiveSpeaker={activeSpeakerId === uid} audioLevel={ringLevels[uid] || 0} onAudioLevel={lvl => handleAudioLevel(uid, lvl)} {...remoteProps(uid)} />))}
              </div>
            </div>

          ) : zoomedId ? (
            <div className="flex flex-col gap-2 h-full p-2">
              <div className="flex-1 min-h-0 flex items-center justify-center">
                <div className="w-full h-full max-w-6xl flex items-center justify-center">
                  {zoomedId === myId ? (
                    <LocalTile videoRef={setLocalVideoRef} name={myName} isHost={isHost} isAudioEnabled={isAudioEnabled} isVideoEnabled={isVideoEnabled} isScreenSharing={isScreenSharing} isHandRaised={raisedHands.has(myId)} isPinned={false} onPin={() => setPinnedUserId('local')} onFullscreen={() => handleFullscreen('local')} large stream={localStreamRef.current} audioEnabled={isAudioEnabled} isActiveSpeaker audioLevel={ringLevels[myId] || 0} onAudioLevel={lvl => handleAudioLevel(myId, lvl)} />
                  ) : (
                    <RemoteTile userId={zoomedId} stream={remoteStreams[zoomedId]} name={getParticipantName(zoomedId)} isHandRaised={raisedHands.has(zoomedId)} isPinned={false} onPin={() => setPinnedUserId(zoomedId)} onFullscreen={() => handleFullscreen(zoomedId)} large isActiveSpeaker audioLevel={ringLevels[zoomedId] || 0} onAudioLevel={lvl => handleAudioLevel(zoomedId, lvl)} {...remoteProps(zoomedId)} />
                  )}
                </div>
              </div>
              <div className="h-32 shrink-0 flex gap-2 overflow-x-auto overflow-y-hidden pb-2 justify-center">
                {zoomedId !== myId && (<LocalTile videoRef={setLocalVideoRef} name="You" isHost={isHost} isAudioEnabled={isAudioEnabled} isVideoEnabled={isVideoEnabled} isScreenSharing={isScreenSharing} isHandRaised={raisedHands.has(myId)} isPinned={false} onPin={() => setPinnedUserId('local')} onFullscreen={() => handleFullscreen('local')} thumbnail stream={localStreamRef.current} audioEnabled={isAudioEnabled} isActiveSpeaker={activeSpeakerId === myId} audioLevel={ringLevels[myId] || 0} onAudioLevel={lvl => handleAudioLevel(myId, lvl)} />)}
                {remoteEntries.filter(([uid]) => uid !== zoomedId).map(([uid, st]) => (<RemoteTile key={uid} userId={uid} stream={st} name={getParticipantName(uid)} isHandRaised={raisedHands.has(uid)} isPinned={false} onPin={() => setPinnedUserId(uid)} onFullscreen={() => handleFullscreen(uid)} thumbnail isActiveSpeaker={activeSpeakerId === uid} audioLevel={ringLevels[uid] || 0} onAudioLevel={lvl => handleAudioLevel(uid, lvl)} {...remoteProps(uid)} />))}
              </div>
            </div>

          ) : (
            <div className="flex-1 overflow-y-auto p-2">
              <div className="flex flex-wrap items-center justify-center content-center gap-3 h-full w-full">
                <div className={cn("transition-all duration-300", tileWidthClass)}>
                  <LocalTile videoRef={setLocalVideoRef} name={myName} isHost={isHost} isAudioEnabled={isAudioEnabled} isVideoEnabled={isVideoEnabled} isScreenSharing={isScreenSharing} isHandRaised={raisedHands.has(myId)} isPinned={pinnedUserId === 'local'} onPin={() => setPinnedUserId('local')} onFullscreen={() => handleFullscreen('local')} gallery stream={localStreamRef.current} audioEnabled={isAudioEnabled} isActiveSpeaker={activeSpeakerId === myId} audioLevel={ringLevels[myId] || 0} onAudioLevel={lvl => handleAudioLevel(myId, lvl)} />
                </div>
                {remoteEntries.map(([uid, st]) => (
                  <div key={uid} className={cn("transition-all duration-300", tileWidthClass)}>
                    <RemoteTile userId={uid} stream={st} name={getParticipantName(uid)} isHandRaised={raisedHands.has(uid)} isPinned={pinnedUserId === uid} onPin={() => setPinnedUserId(p => p === uid ? null : uid)} onFullscreen={() => handleFullscreen(uid)} gallery isActiveSpeaker={activeSpeakerId === uid} audioLevel={ringLevels[uid] || 0} onAudioLevel={lvl => handleAudioLevel(uid, lvl)} {...remoteProps(uid)} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {chatOpen && (
          <div className="w-80 bg-background border-l border-border flex flex-col shrink-0 absolute md:static right-0 top-0 bottom-0 z-40 shadow-xl md:shadow-none">
            <div className="p-4 border-b border-border flex items-center justify-between shrink-0"><span className="font-semibold text-foreground">Chat</span><button onClick={() => setChatOpen(false)} className="text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button></div>
            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
              {messages.length === 0 ? (<p className="text-muted-foreground text-center text-sm mt-12">No messages yet 👋</p>) : messages.map(msg => (
                <div key={msg.id} className={cn('flex flex-col gap-0.5', msg.isOwn ? 'items-end' : 'items-start')}>
                  <span className="text-xs text-muted-foreground px-1">{msg.userName}</span>
                  <span className={cn('inline-block px-3 py-2 rounded-2xl text-sm max-w-[220px] break-words shadow-sm', msg.isOwn ? 'bg-primary text-primary-foreground rounded-br-sm' : 'bg-muted text-foreground rounded-bl-sm')}>{msg.message}</span>
                  <span className="text-xs text-muted-foreground/70 px-1">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              ))}
              <div ref={chatBottomRef} />
            </div>
            <form onSubmit={e => { e.preventDefault(); const message = chatInput.trim(); if (!message || !socketRef.current) return; setMessages(prev => [...prev, { id: Date.now(), userId: myId, userName: myName, message, timestamp: new Date().toISOString(), isOwn: true }]); socketRef.current.emit('chat-message', { meetingId, message }); setChatInput(''); }} className="p-3 border-t border-border flex gap-2 shrink-0 bg-background pt-4">
              <input type="text" value={chatInput} onChange={e => setChatInput(e.target.value)} placeholder="Type a message..." className="flex-1 bg-muted border border-border rounded-xl px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-primary" />
              <button type="submit" disabled={!chatInput.trim()} className="bg-primary hover:bg-primary/90 disabled:opacity-40 text-primary-foreground px-3 py-2 rounded-xl text-sm transition-colors font-medium cursor-pointer disabled:cursor-not-allowed">Send</button>
            </form>
          </div>
        )}
      </div>

      {!fullscreenUserId && <ControlsBar {...controlsProps} />}
    </div>
  );
}

function LocalTile({ videoRef, name, isHost, isAudioEnabled, isVideoEnabled, isScreenSharing, isHandRaised, isPinned, onPin, onFullscreen, large, thumbnail, isFullscreen, gallery, stream, isActiveSpeaker, onAudioLevel, audioEnabled, audioLevel }) {
  useAudioLevel(stream, audioEnabled !== false, onAudioLevel);
  return (
    <div className={cn('relative bg-slate-900 border border-border/50 rounded-xl overflow-hidden shadow-lg group', large ? 'w-full aspect-video' : thumbnail ? 'w-40 aspect-video shrink-0' : gallery ? 'w-full aspect-video' : 'w-full aspect-video')}>
      <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-cover" />
      {!isVideoEnabled && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-muted/80 gap-2">
          <div className="w-14 h-14 rounded-full bg-slate-800 flex items-center justify-center"><CameraOff className="h-7 w-7 text-muted-foreground" /></div>
          {!thumbnail && <span className="text-muted-foreground font-medium text-sm">Camera off</span>}
        </div>
      )}
      <SpeakerRing isActive={isActiveSpeaker} level={audioLevel} thumbnail={thumbnail} />
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-start justify-end p-2 gap-1">
        <TileBtn onClick={onPin} title={isPinned ? 'Unpin' : 'Pin'}>{isPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}</TileBtn>
        <TileBtn onClick={onFullscreen} title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}>{isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}</TileBtn>
      </div>
      <div className="absolute bottom-0 left-0 right-0 px-2 py-1.5 bg-gradient-to-t from-black/70 to-transparent flex items-center gap-1.5">
        <span className="text-white text-xs font-medium truncate">{name}{isHost ? ' · Host' : ''}{isScreenSharing ? ' · Screen' : ''}</span>
        {isHandRaised && <span>✋</span>}
        {!isAudioEnabled && <MicOff className="h-3 w-3 text-red-400 ml-auto shrink-0" />}
      </div>
    </div>
  );
}

function RemoteTile({ userId, stream, name, isMuted, isCameraOff, isHandRaised, isPinned, onPin, onFullscreen, large, thumbnail, isFullscreen, gallery, isActiveSpeaker, onAudioLevel, audioLevel }) {
  const videoRef = useRef(null);
  const [hasVideo, setHasVideo] = useState(true);

  useEffect(() => {
    if (videoRef.current && stream) { videoRef.current.srcObject = stream; const videoTrack = stream.getVideoTracks()[0]; setHasVideo(!!videoTrack && videoTrack.enabled); }
  }, [stream]);

  useAudioLevel(stream, !isMuted, onAudioLevel);

  const initials = name.split(' ').map(n => n[0] || '').join('').slice(0, 2).toUpperCase() || '??';
  const showCameraOff = isCameraOff || !hasVideo;
  return (
    <div className={cn('relative bg-slate-900 border border-border/50 rounded-xl overflow-hidden shadow-lg group', large ? 'w-full aspect-video' : thumbnail ? 'w-40 aspect-video shrink-0' : gallery ? 'w-full aspect-video' : 'w-full aspect-video')}>
      <video ref={videoRef} autoPlay playsInline className={cn('w-full h-full object-cover', showCameraOff && 'hidden')} />
      {showCameraOff && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-muted/80 gap-2">
          <div className="w-14 h-14 rounded-full bg-slate-800 flex items-center justify-center shadow-lg border border-border/30">
            {isCameraOff ? <CameraOff className="h-7 w-7 text-muted-foreground" /> : <span className="text-xl font-bold text-slate-200">{initials}</span>}
          </div>
          {!thumbnail && <span className="text-muted-foreground font-medium text-sm">{isCameraOff ? `${name} · Camera off` : name}</span>}
        </div>
      )}
      <SpeakerRing isActive={isActiveSpeaker} level={audioLevel} thumbnail={thumbnail} />
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity flex items-start justify-end p-2 gap-1">
        <TileBtn onClick={onPin} title={isPinned ? 'Unpin' : 'Pin'}>{isPinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}</TileBtn>
        <TileBtn onClick={onFullscreen} title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}>{isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}</TileBtn>
      </div>
      <div className="absolute bottom-0 left-0 right-0 px-2 py-1.5 bg-gradient-to-t from-black/70 to-transparent flex items-center gap-1.5">
        <span className="text-white text-xs font-medium truncate">{name}</span>
        {isHandRaised && <span>✋</span>}
        {isMuted && <MicOff className="h-3 w-3 text-red-400 ml-auto shrink-0" />}
      </div>
    </div>
  );
}

function TileBtn({ onClick, title, children }) {
  return (<button onClick={onClick} title={title} className="bg-black/60 backdrop-blur hover:bg-black/80 text-white p-1.5 rounded-md transition-colors">{children}</button>);
}

function CtrlBtn({ onClick, children, label, danger, highlight, warn }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <button onClick={onClick} className={cn('h-12 w-12 rounded-full border flex items-center justify-center transition-all duration-200 hover:scale-105', danger ? 'bg-red-500/10 border-red-500 text-red-500 hover:bg-red-500/20' : highlight ? 'bg-primary/10 border-primary text-primary hover:bg-primary/20' : warn ? 'bg-yellow-500/10 border-yellow-500 text-yellow-500 hover:bg-yellow-500/20' : 'bg-muted border-border text-foreground hover:bg-muted/80')}>{children}</button>
      <span className="text-[11px] font-medium text-muted-foreground">{label}</span>
    </div>
  );
}