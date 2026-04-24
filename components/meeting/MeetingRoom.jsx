'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import SimplePeer from 'simple-peer';
import {
  Mic, MicOff, Video, VideoOff, Phone,
  MessageSquare, ScreenShare, StopCircle,
  Hand, Users, Circle, LayoutGrid, Layout,
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

function useInactivity(timeoutMs = 10000) {
  const [isIdle, setIsIdle] = useState(false);

  useEffect(() => {
    let timeout;
    const resetTimer = () => {
      setIsIdle(false);
      clearTimeout(timeout);
      timeout = setTimeout(() => setIsIdle(true), timeoutMs);
    };

    resetTimer();

    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];
    events.forEach(e => document.addEventListener(e, resetTimer, { passive: true }));

    return () => {
      clearTimeout(timeout);
      events.forEach(e => document.removeEventListener(e, resetTimer));
    };
  }, [timeoutMs]);

  return isIdle;
}

function ControlsBar({ isAudioEnabled, isVideoEnabled, isScreenSharing, isMobile, isHandRaised, isRecording, isHost, isEndingMeeting, toggleAudio, toggleVideo, toggleScreenShare, toggleHand, startRecording, stopRecording, handleEndMeeting, leaveMeeting, triggerReaction, isIdle, layoutMode, toggleLayout }) {
  const [showReactions, setShowReactions] = useState(false);
  const isVisible = !isIdle || showReactions;

  return (
    <div className={cn("fixed bottom-0 left-0 right-0 z-50 pointer-events-auto transition-transform duration-300", isIdle ? "translate-y-full" : "translate-y-0")}>
      <div className="flex items-center justify-center gap-4 px-6 py-4 bg-[var(--jitsi-toolbar-bg)] shadow-2xl border-t border-white/5">
        
        {/* Audio / Video Group */}
        <div className="flex items-center gap-2">
          <CtrlBtn onClick={toggleAudio} label={isAudioEnabled ? 'Mute' : 'Unmute'} danger={!isAudioEnabled}>
            {isAudioEnabled ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
          </CtrlBtn>
          <CtrlBtn onClick={toggleVideo} label={isVideoEnabled ? 'Stop Video' : 'Start Video'} danger={!isVideoEnabled}>
            {isVideoEnabled ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
          </CtrlBtn>
        </div>

        <div className="jitsi-toolbar-separator" />

        {/* Center Actions */}
        <div className="flex items-center gap-2">
          {!isMobile && (
            <CtrlBtn onClick={toggleScreenShare} label={isScreenSharing ? 'Stop sharing' : 'Share screen'} highlight={isScreenSharing}>
              {isScreenSharing ? <StopCircle className="h-5 w-5" /> : <ScreenShare className="h-5 w-5" />}
            </CtrlBtn>
          )}
          <CtrlBtn onClick={toggleHand} label={isHandRaised ? 'Lower hand' : 'Raise hand'} warn={isHandRaised}>
            <Hand className="h-5 w-5" />
          </CtrlBtn>
          
          <div className="relative">
            <CtrlBtn onClick={() => setShowReactions(p => !p)} label="Reactions">
              <Smile className="h-5 w-5" />
            </CtrlBtn>
            {showReactions && (
              <div className="absolute bottom-[120%] left-1/2 -translate-x-1/2 flex gap-2 bg-[var(--jitsi-thumbnail-bg)] border border-white/10 p-2 rounded-lg shadow-xl mb-1">
                {['👍', '❤️', '😂', '🎉', '👏'].map(emoji => (
                  <button key={emoji} onClick={() => { triggerReaction(emoji); setShowReactions(false); }} className="text-2xl hover:scale-125 transition-transform">{emoji}</button>
                ))}
              </div>
            )}
          </div>

          <CtrlBtn onClick={toggleLayout} label={layoutMode === 'stage' ? 'Toggle tile view' : 'Toggle stage view'}>
            {layoutMode === 'stage' ? <LayoutGrid className="h-5 w-5" /> : <Layout className="h-5 w-5" />}
          </CtrlBtn>

          {isHost && (
            <CtrlBtn onClick={isRecording ? stopRecording : startRecording} label={isRecording ? 'Stop recording' : 'Record'} danger={isRecording}>
              <Circle className={cn('h-5 w-5', isRecording && 'fill-current animate-pulse')} />
            </CtrlBtn>
          )}
        </div>

        <div className="jitsi-toolbar-separator" />

        {/* Leave Actions */}
        <div className="flex items-center gap-2">
          {isHost && (
            <CtrlBtn onClick={handleEndMeeting} disabled={isEndingMeeting} label="End for All" danger>
              <StopCircle className="h-5 w-5" />
            </CtrlBtn>
          )}
          <button onClick={leaveMeeting} className="h-10 px-4 rounded-lg bg-[var(--jitsi-hangup)] hover:bg-[var(--jitsi-hangup-hover)] flex items-center justify-center transition-colors text-white text-sm font-medium shadow-sm" title="Leave Meeting">
            <Phone className="h-5 w-5 rotate-[135deg]" />
          </button>
        </div>

      </div>
    </div>
  );
}

export default function MeetingRoom({ meetingId, user, meetingName }) {
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
  const [layoutMode, setLayoutMode] = useState('stage');
  const [meetingStartTime] = useState(Date.now());
  const [elapsedTime, setElapsedTime] = useState('00:00');

  useEffect(() => {
    const timer = setInterval(() => {
      const diff = Math.floor((Date.now() - meetingStartTime) / 1000);
      const m = Math.floor(diff / 60).toString().padStart(2, '0');
      const s = (diff % 60).toString().padStart(2, '0');
      setElapsedTime(`${m}:${s}`);
    }, 1000);
    return () => clearInterval(timer);
  }, [meetingStartTime]);

  const isIdle = useInactivity(10000);

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
          // Flush the final per-device audio chunk to the socket queue.
          // flush-my-chunks (called by handleEndMeeting after this resolves)
          // will upload everything to S3. The worker reads VAD scores from
          // S3 sidecar files — perDeviceAudio is no longer sent in the form.
          await stopMyRecording();
          await new Promise(r => setTimeout(r, 2500));

          const fd = new FormData();
          fd.append('recording', blob, 'meeting-recording.webm');

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
      } else {
        await stopMyRecording();
      }
      // FIX: Host must also flush per-device audio to S3. Non-hosts do this
      // automatically via the 'meeting-ended' socket event, but the host calls
      // handleEndMeeting directly and would skip flush-my-chunks entirely,
      // making the host invisible to scanPerDeviceAudio() in the worker.
      if (socketRef.current?.connected) {
        socketRef.current.emit('flush-my-chunks', { meetingId });
        await new Promise(r => setTimeout(r, 2000)); // wait for S3 upload
      }
      toast.success('Meeting ended'); cleanup(); router.push(`/meetings/${meetingId}`);
    } catch (e) { toast.error(e?.response?.data?.message || 'Failed to end meeting'); setIsEndingMeeting(false); }
  }, [isHost, isRecording, meetingId, stopMyRecording]);

  const remoteEntries = Object.entries(remoteStreams);
  const totalParticipants = remoteEntries.length + 1;

  // Auto-switch to tile view if few participants, unless manually set or pinned
  useEffect(() => {
    if (!pinnedUserId && totalParticipants <= 4) {
      setLayoutMode('tile');
    } else if (pinnedUserId || totalParticipants > 4) {
      setLayoutMode('stage');
    }
  }, [totalParticipants, pinnedUserId]);

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

  const shouldZoom = !pinnedUserId && totalParticipants > 1 && activeSpeakerId !== null;
  const zoomedId = shouldZoom ? activeSpeakerId : null;
  const spotlightId = pinnedUserId || zoomedId || 'local'; // Default to local in stage view if nobody speaking

  const controlsProps = { isAudioEnabled, isVideoEnabled, isScreenSharing, isMobile, isHandRaised, isRecording, isHost, isEndingMeeting, toggleAudio, toggleVideo, toggleScreenShare, toggleHand, startRecording, stopRecording, handleEndMeeting, leaveMeeting, triggerReaction: triggerReactionEvent, isIdle, layoutMode, toggleLayout: () => setLayoutMode(p => p === 'stage' ? 'tile' : 'stage') };
  const remoteProps = (uid) => ({ isMuted: participantMediaState[uid]?.audio === false, isCameraOff: participantMediaState[uid]?.video === false });

  return (
    <div className="h-screen bg-[var(--jitsi-bg)] text-white flex flex-col overflow-hidden relative font-sans">
      {reactions.map(r => (
        <div key={r.id} className="fixed bottom-24 right-6 text-3xl animate-bounce pointer-events-none z-50">
          {r.emoji}
        </div>
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

      {/* Jitsi Style Top Bar */}
      <header className={cn("absolute top-0 left-0 right-0 h-14 flex items-center justify-between px-6 z-40 bg-black/60 transition-opacity duration-300", isIdle && "opacity-0 pointer-events-none")}>
        <div className="flex items-center gap-4 pointer-events-auto">
          <div className="text-white font-bold text-xl tracking-tighter flex items-center gap-2">
            <div className="w-8 h-8 rounded-sm bg-[#00E676] flex items-center justify-center text-black text-lg">O</div>
            OrgyX
          </div>
          <div className="h-5 w-px bg-white/20" />
          <h1 className="font-medium text-white/90 text-sm">{meetingName || 'Meeting'}</h1>
          
          <div className="flex items-center gap-2 text-xs font-medium bg-black/40 px-2 py-1 rounded">
            {elapsedTime}
          </div>
          
          {isRecording && (<Badge className="bg-red-500/20 text-red-400 border border-red-500/30 flex items-center gap-1.5 animate-pulse rounded px-1.5 py-0.5 text-xs"><Circle className="h-2 w-2 fill-red-500" /> REC</Badge>)}
        </div>
        
        <div className="flex items-center gap-2 pointer-events-auto">
          {raisedHands.size > 0 && (
             <div className="flex items-center gap-1.5 text-[var(--jitsi-raised-hand)] text-xs font-medium bg-black/40 px-2 py-1 rounded border border-[var(--jitsi-raised-hand)]/30">
               ✋ {Array.from(raisedHands).slice(0, 1).map(id => id === myId ? 'You' : (participantNames[id] || 'Someone')).join(', ')} {raisedHands.size > 1 && `+${raisedHands.size - 1}`}
             </div>
          )}
          {networkWarning && (<div className="flex items-center gap-1 text-amber-500 text-xs bg-black/40 px-2 py-1 rounded"><WifiOff className="h-3 w-3" /> Unstable</div>)}
          
          <div className="flex items-center gap-1.5 text-white/80 text-xs font-medium bg-black/40 px-2 py-1 rounded">
            <Users className="h-3 w-3" /> {totalParticipants}
          </div>
          
          <button onClick={() => setChatOpen(p => !p)} className={cn('relative p-1.5 rounded transition-colors', chatOpen ? 'bg-white/20 text-white' : 'bg-black/40 text-white/80 hover:bg-black/60')}>
            <MessageSquare className="h-4 w-4" />
            {unreadCount > 0 && (<span className="absolute -top-1 -right-1 bg-red-500 text-white text-[9px] w-3.5 h-3.5 rounded-full flex items-center justify-center font-bold shadow-sm">{unreadCount > 9 ? '9+' : unreadCount}</span>)}
          </button>
        </div>
      </header>

      {networkWarning && (
        <div className="relative z-30 pt-12">
          <NetworkWarningBanner onDismiss={() => setNetworkWarning(false)} />
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 min-h-0 flex overflow-hidden relative pt-12 pb-24">
        <div className={cn('flex-1 min-w-0 overflow-hidden transition-all duration-200 h-full flex flex-col relative', chatOpen && !isMobile && 'md:mr-[350px]')}>
          
          {layoutMode === 'stage' ? (
            <div className="flex flex-col md:flex-row h-full w-full">
              {/* Stage Video */}
              <div className="flex-1 min-w-0 min-h-0 flex items-center justify-center p-3 relative">
                <div className="w-full h-full max-w-[1280px] aspect-video">
                  {spotlightId === 'local' ? (
                    <LocalTile videoRef={setLocalVideoRef} name={myName} isHost={isHost} isAudioEnabled={isAudioEnabled} isVideoEnabled={isVideoEnabled} isScreenSharing={isScreenSharing} isHandRaised={raisedHands.has(myId)} isPinned onPin={() => setPinnedUserId(null)} onFullscreen={() => handleFullscreen('local')} large stream={localStreamRef.current} audioEnabled={isAudioEnabled} isActiveSpeaker={activeSpeakerId === myId} audioLevel={ringLevels[myId] || 0} onAudioLevel={lvl => handleAudioLevel(myId, lvl)} />
                  ) : (
                    <RemoteTile userId={spotlightId} stream={remoteStreams[spotlightId]} name={getParticipantName(spotlightId)} isHandRaised={raisedHands.has(spotlightId)} isPinned onPin={() => setPinnedUserId(null)} onFullscreen={() => handleFullscreen(spotlightId)} large isActiveSpeaker={activeSpeakerId === spotlightId} audioLevel={ringLevels[spotlightId] || 0} onAudioLevel={lvl => handleAudioLevel(spotlightId, lvl)} {...remoteProps(spotlightId)} />
                  )}
                </div>
              </div>
              
              {/* Vertical Filmstrip */}
              <div className={cn("transition-all duration-300", isMobile ? "jitsi-horizontal-filmstrip h-[120px]" : "jitsi-vertical-filmstrip w-[220px]")}>
                {spotlightId !== 'local' && (
                  <div className="shrink-0 aspect-video w-full max-w-[200px] mx-auto">
                    <LocalTile videoRef={setLocalVideoRef} name="You" isHost={isHost} isAudioEnabled={isAudioEnabled} isVideoEnabled={isVideoEnabled} isScreenSharing={isScreenSharing} isHandRaised={raisedHands.has(myId)} isPinned={false} onPin={() => setPinnedUserId('local')} onFullscreen={() => handleFullscreen('local')} thumbnail stream={localStreamRef.current} audioEnabled={isAudioEnabled} isActiveSpeaker={activeSpeakerId === myId} audioLevel={ringLevels[myId] || 0} onAudioLevel={lvl => handleAudioLevel(myId, lvl)} />
                  </div>
                )}
                {remoteEntries.filter(([uid]) => uid !== spotlightId).map(([uid, st]) => (
                  <div key={uid} className="shrink-0 aspect-video w-full max-w-[200px] mx-auto">
                    <RemoteTile userId={uid} stream={st} name={getParticipantName(uid)} isHandRaised={raisedHands.has(uid)} isPinned={false} onPin={() => setPinnedUserId(uid)} onFullscreen={() => handleFullscreen(uid)} thumbnail isActiveSpeaker={activeSpeakerId === uid} audioLevel={ringLevels[uid] || 0} onAudioLevel={lvl => handleAudioLevel(uid, lvl)} {...remoteProps(uid)} />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            /* Tile View */
            <div className="jitsi-tile-grid overflow-y-auto custom-scrollbar content-center justify-items-center">
              <div className="w-full max-w-sm md:max-w-md lg:max-w-lg aspect-video shrink-0">
                <LocalTile videoRef={setLocalVideoRef} name={myName} isHost={isHost} isAudioEnabled={isAudioEnabled} isVideoEnabled={isVideoEnabled} isScreenSharing={isScreenSharing} isHandRaised={raisedHands.has(myId)} isPinned={pinnedUserId === 'local'} onPin={() => setPinnedUserId(p => p === 'local' ? null : 'local')} onFullscreen={() => handleFullscreen('local')} gallery stream={localStreamRef.current} audioEnabled={isAudioEnabled} isActiveSpeaker={activeSpeakerId === myId} audioLevel={ringLevels[myId] || 0} onAudioLevel={lvl => handleAudioLevel(myId, lvl)} />
              </div>
              {remoteEntries.map(([uid, st]) => (
                <div key={uid} className="w-full max-w-sm md:max-w-md lg:max-w-lg aspect-video shrink-0">
                  <RemoteTile userId={uid} stream={st} name={getParticipantName(uid)} isHandRaised={raisedHands.has(uid)} isPinned={pinnedUserId === uid} onPin={() => setPinnedUserId(p => p === uid ? null : uid)} onFullscreen={() => handleFullscreen(uid)} gallery isActiveSpeaker={activeSpeakerId === uid} audioLevel={ringLevels[uid] || 0} onAudioLevel={lvl => handleAudioLevel(uid, lvl)} {...remoteProps(uid)} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Chat Panel */}
        {chatOpen && (
          <div className={cn(
            "bg-[var(--jitsi-thumbnail-bg)] border-white/10 flex flex-col z-50 transition-all duration-300",
            isMobile ? "fixed inset-x-0 bottom-0 h-[75vh] rounded-t-xl border-t shadow-2xl" : "w-[350px] border-l shrink-0 absolute md:static right-0 top-0 bottom-0"
          )}>
            {isMobile && <div className="w-12 h-1 bg-white/20 rounded-full mx-auto mt-3 cursor-pointer" onClick={() => setChatOpen(false)} />}
            
            <div className="px-4 py-3 border-b border-white/5 flex items-center justify-between shrink-0">
              <span className="font-semibold text-white/90 text-sm">Chat</span>
              <button onClick={() => setChatOpen(false)} className="text-white/50 hover:text-white transition-all p-1.5 rounded bg-white/5 hover:bg-white/10">
                <X className="h-4 w-4" />
              </button>
            </div>
            
            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4 custom-scrollbar bg-black/20">
              {messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full opacity-30 py-8">
                  <MessageSquare className="h-8 w-8 mb-2" />
                  <p className="text-xs">No messages yet</p>
                </div>
              ) : messages.map((msg, idx) => {
                const prevMsg = messages[idx - 1];
                const showHeader = !prevMsg || prevMsg.userId !== msg.userId || (new Date(msg.timestamp) - new Date(prevMsg.timestamp) > 60000);
                return (
                  <div key={msg.id} className="flex flex-col gap-1 group">
                    {showHeader && (
                      <div className="flex items-baseline gap-2 mb-0.5">
                        <span className="text-[11px] font-bold text-white/80">{msg.isOwn ? 'Me' : msg.userName}</span>
                        <span className="text-[9px] text-white/40">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
                    )}
                    <div className={cn(
                      'px-3 py-2 text-[13px] break-words rounded leading-relaxed inline-block max-w-[90%]',
                      msg.isOwn ? 'bg-white/10 text-white/90' : 'bg-black/40 text-white/90 border border-white/5'
                    )}>
                      {msg.message}
                    </div>
                  </div>
                );
              })}
              <div ref={chatBottomRef} />
            </div>

            <form onSubmit={e => { e.preventDefault(); const message = chatInput.trim(); if (!message || !socketRef.current) return; setMessages(prev => [...prev, { id: Date.now(), userId: myId, userName: myName, message, timestamp: new Date().toISOString(), isOwn: true }]); socketRef.current.emit('chat-message', { meetingId, message }); setChatInput(''); }} className="p-3 shrink-0 bg-[var(--jitsi-thumbnail-bg)] border-t border-white/5">
              <div className="relative flex items-center bg-black/40 border border-white/10 rounded overflow-hidden focus-within:border-white/30 transition-colors">
                <input type="text" value={chatInput} onChange={e => setChatInput(e.target.value)} placeholder="Type a message..." className="flex-1 bg-transparent px-3 py-2 text-sm text-white placeholder:text-white/30 focus:outline-none" />
                <button type="submit" disabled={!chatInput.trim()} className="px-3 py-2 text-white/50 hover:text-white disabled:opacity-30 disabled:hover:text-white/50 transition-colors">
                  <MessageSquare className="h-4 w-4" />
                </button>
              </div>
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
  const initials = name.split(' ').map(n => n[0] || '').join('').slice(0, 2).toUpperCase() || 'Y';
  
  return (
    <div className={cn(
      'jitsi-video-tile h-full w-full flex items-center justify-center group',
      isHandRaised && 'jitsi-hand-raised',
      isActiveSpeaker && 'speaker-active'
    )}>
      <video ref={videoRef} autoPlay muted playsInline className="w-full h-full object-cover" />
      
      {!isVideoEnabled && (
        <div className="absolute inset-0 flex items-center justify-center bg-black">
          <div className="w-24 h-24 rounded-full bg-[#333] flex items-center justify-center border border-white/5">
            <span className="text-3xl font-medium text-white/80">{initials}</span>
          </div>
        </div>
      )}

      {/* Jitsi Hover Controls */}
      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
        <div className="absolute top-2 right-2 flex gap-1 pointer-events-auto">
          <TileBtn onClick={onPin} title={isPinned ? 'Unpin' : 'Pin'}>{isPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}</TileBtn>
          {!thumbnail && <TileBtn onClick={onFullscreen} title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}>{isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</TileBtn>}
        </div>
      </div>

      {/* Jitsi Indicators */}
      <div className="jitsi-top-indicators">
        {!isAudioEnabled && <div className="jitsi-indicator-icon text-red-500"><MicOff className="h-3 w-3" /></div>}
        {isAudioEnabled && isActiveSpeaker && <div className="jitsi-indicator-icon text-[#00E676]"><Mic className="h-3 w-3 animate-pulse" /></div>}
      </div>

      <div className="jitsi-name-badge">
        <span className="truncate">{name} {isScreenSharing ? '(Screen)' : ''}</span>
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

  const initials = name.split(' ').map(n => n[0] || '').join('').slice(0, 2).toUpperCase() || 'R';
  const showCameraOff = isCameraOff || !hasVideo;
  
  return (
    <div className={cn(
      'jitsi-video-tile h-full w-full flex items-center justify-center group',
      isHandRaised && 'jitsi-hand-raised',
      isActiveSpeaker && 'speaker-active'
    )}>
      <video ref={videoRef} autoPlay playsInline className={cn('w-full h-full object-cover', showCameraOff && 'hidden')} />
      
      {showCameraOff && (
        <div className="absolute inset-0 flex items-center justify-center bg-black">
          <div className="w-24 h-24 rounded-full bg-[#333] flex items-center justify-center border border-white/5">
            <span className="text-3xl font-medium text-white/80">{initials}</span>
          </div>
        </div>
      )}

      {/* Jitsi Hover Controls */}
      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
        <div className="absolute top-2 right-2 flex gap-1 pointer-events-auto">
          <TileBtn onClick={onPin} title={isPinned ? 'Unpin' : 'Pin'}>{isPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}</TileBtn>
          {!thumbnail && <TileBtn onClick={onFullscreen} title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}>{isFullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}</TileBtn>}
        </div>
      </div>

      {/* Jitsi Indicators */}
      <div className="jitsi-top-indicators">
        {isMuted && <div className="jitsi-indicator-icon text-red-500"><MicOff className="h-3 w-3" /></div>}
        {!isMuted && isActiveSpeaker && <div className="jitsi-indicator-icon text-[#00E676]"><Mic className="h-3 w-3 animate-pulse" /></div>}
      </div>

      <div className="jitsi-name-badge">
        <span className="truncate">{name}</span>
      </div>
    </div>
  );
}

function TileBtn({ onClick, title, children }) {
  return (<button onClick={onClick} title={title} className="bg-black/60 hover:bg-black/80 text-white p-1.5 rounded transition-colors">{children}</button>);
}

function CtrlBtn({ onClick, children, label, danger, highlight, warn, disabled }) {
  return (
    <div className="relative group flex flex-col items-center">
      <button disabled={disabled} onClick={onClick} className={cn(
        'h-12 w-12 rounded-full flex items-center justify-center transition-colors',
        disabled ? 'opacity-30 cursor-not-allowed' :
        danger ? 'bg-red-600 text-white hover:bg-red-700'
          : highlight ? 'bg-[#00E676] text-black hover:bg-[#00E676]/80'
            : 'bg-[#3D3D3D] text-white hover:bg-[#4D4D4D]'
      )}>{children}</button>
      <div className="absolute -top-10 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
        <div className="bg-black/80 text-white text-[11px] font-medium px-2 py-1 rounded whitespace-nowrap shadow-lg">
          {label}
        </div>
      </div>
    </div>
  );
}