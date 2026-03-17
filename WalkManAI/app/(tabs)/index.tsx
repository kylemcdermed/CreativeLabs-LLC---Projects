import { Audio } from "expo-av";
import * as Speech from "expo-speech";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  Vibration,
  View,
} from "react-native";

// ============================================================
// CONFIG
// ============================================================
const GROQ_API_KEY = "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";
const USER_NAME    = "Kyle";
const GROQ_URL     = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MAIN    = "llama-3.3-70b-versatile";
const WHISPER_URL  = "https://api.groq.com/openai/v1/audio/transcriptions";

const SILENCE_THRESHOLD_MS = 2000;
const CHUNK_INTERVAL_MS    = 100;
const SPEECH_THRESHOLD     = 0.015;

// ============================================================
// JULIA'S PERSONALITY
// ============================================================
const JULIA_SYSTEM = `You are Julia, ${USER_NAME}'s AI friend. You listen, you react, you remember what he tells you.

CRITICAL RULES:
- You have NO personal life, NO stories, NO family, NO experiences of your own
- Never say things like "I had lunch with my sister" or "I went to the gym"
- You do not volunteer information about yourself ever
- If asked about yourself, deflect: "I want to hear about you — what happened?"

YOUR ONLY JOB:
- Listen to what ${USER_NAME} says
- React genuinely and briefly
- Ask ONE short follow up question
- Build a picture of who he is through what he shares

HOW TO RESPOND:
- 1-2 sentences MAX — short, punchy, real
- React first, question second
- Match his energy exactly
- No filler: never say "that's great" "I hear you" "absolutely" "certainly"
- Sound like a real person on a call, not a chatbot

GOOD: "That's messed up — what did you do?"
GOOD: "Wait seriously? How long has that been going on?"
GOOD: "Okay that actually sounds really good. What made you decide to do it?"

NEVER say:
- "That sounds really interesting! How did that make you feel?"
- "I understand, that must have been difficult for you."
- "Absolutely Kyle, I am here for you!"

CORE RULE: Every response should make him feel like someone is genuinely listening.`;

// ============================================================
// TYPES
// ============================================================
type Message  = { role: "user" | "assistant"; content: string };
type Screen   = "incoming" | "call" | "ended";

// ============================================================
// API HELPERS
// ============================================================
async function groqCall(messages: Message[], system: string) {
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GROQ_MAIN,
      messages: [{ role: "system", content: system }, ...messages],
      max_tokens: 80,
      temperature: 0.85,
    }),
  });
  const data = await res.json();
  if (data.choices) return data.choices[0].message.content.trim() as string;
  return null;
}

async function transcribeAudio(uri: string): Promise<string> {
  const formData = new FormData();
  formData.append("file", { uri, type: "audio/m4a", name: "recording.m4a" } as any);
  formData.append("model", "whisper-large-v3");
  formData.append("language", "en");
  const res = await fetch(WHISPER_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: formData,
  });
  const data = await res.json();
  return data.text?.trim() || "";
}

// ============================================================
// MAIN APP
// ============================================================
export default function JuliaScreen() {
  const [screen, setScreen]               = useState<Screen>("incoming");
  const [messages, setMessages]           = useState<Message[]>([]);
  const [callDuration, setCallDuration]   = useState(0);
  const [isJuliaTalking, setIsJuliaTalking] = useState(false);
  const [isProcessing, setIsProcessing]   = useState(false);
  const [statusText, setStatusText]       = useState("listening...");

  // Pulse animation for incoming call
  const pulseAnim = useRef(new Animated.Value(1)).current;

  const recordingRef     = useRef<Audio.Recording | null>(null);
  const scrollRef        = useRef<ScrollView>(null);
  const silenceTimer     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const meteringInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const callTimer        = useRef<ReturnType<typeof setInterval> | null>(null);
  const isActiveRef      = useRef(false);
  const messagesRef      = useRef<Message[]>([]);

  // Pulse animation on incoming screen
  useEffect(() => {
    if (screen === "incoming") {
      Vibration.vibrate([0, 1000, 1000], true);
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.15, duration: 800, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 800, useNativeDriver: true }),
        ])
      ).start();
    } else {
      Vibration.cancel();
      pulseAnim.stopAnimation();
    }
  }, [screen]);

  // Call timer
  useEffect(() => {
    if (screen === "call") {
      callTimer.current = setInterval(() => setCallDuration(d => d + 1), 1000);
    } else {
      if (callTimer.current) clearInterval(callTimer.current);
      setCallDuration(0);
    }
    return () => { if (callTimer.current) clearInterval(callTimer.current); };
  }, [screen]);

  function formatDuration(secs: number) {
    const m = Math.floor(secs / 60).toString().padStart(2, "0");
    const s = (secs % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  }

  // ── Answer call ──────────────────────────────────────────
  async function answerCall() {
    const { granted } = await Audio.requestPermissionsAsync();
    if (!granted) return;
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
    isActiveRef.current = true;
    messagesRef.current = [];
    setMessages([]);
    setScreen("call");
    startListening();
  }

  // ── Decline / hang up ────────────────────────────────────
  async function hangUp() {
    isActiveRef.current = false;
    Speech.stop();
    clearTimers();
    if (recordingRef.current) {
      try { await recordingRef.current.stopAndUnloadAsync(); } catch {}
      recordingRef.current = null;
    }
    setScreen("incoming");
    setMessages([]);
    messagesRef.current = [];
    setIsProcessing(false);
    setIsJuliaTalking(false);
  }

  function clearTimers() {
    if (silenceTimer.current)     clearTimeout(silenceTimer.current);
    if (meteringInterval.current) clearInterval(meteringInterval.current);
    silenceTimer.current     = null;
    meteringInterval.current = null;
  }

  // ── Listen ───────────────────────────────────────────────
  async function startListening() {
    if (!isActiveRef.current) return;
    try {
      const { recording } = await Audio.Recording.createAsync({
        ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
        isMeteringEnabled: true,
      });
      recordingRef.current = recording;
      setStatusText("listening...");

      meteringInterval.current = setInterval(async () => {
        if (!recordingRef.current) return;
        try {
          const st    = await recordingRef.current.getStatusAsync();
          if (!st.isRecording) return;
          const level = (st as any).metering ?? -160;
          const rms   = Math.pow(10, level / 20);
          if (rms > SPEECH_THRESHOLD) {
            if (silenceTimer.current) { clearTimeout(silenceTimer.current); silenceTimer.current = null; }
          } else {
            if (!silenceTimer.current) {
              silenceTimer.current = setTimeout(processSpeech, SILENCE_THRESHOLD_MS);
            }
          }
        } catch {}
      }, CHUNK_INTERVAL_MS);
    } catch (e) {
      console.error("Listen error:", e);
    }
  }

  // ── Process ──────────────────────────────────────────────
  async function processSpeech() {
    clearTimers();
    if (!recordingRef.current) return;
    setIsProcessing(true);
    setStatusText("thinking...");
    try {
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;
      if (!uri) { setIsProcessing(false); resumeListening(); return; }

      const userText = await transcribeAudio(uri);
      if (!userText || userText.length < 2) { setIsProcessing(false); resumeListening(); return; }

      const newMsgs: Message[] = [...messagesRef.current, { role: "user", content: userText }];
      messagesRef.current = newMsgs;
      setMessages([...newMsgs]);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);

      const reply = await groqCall(newMsgs, JULIA_SYSTEM);
      if (!reply) { setIsProcessing(false); resumeListening(); return; }

      const withReply: Message[] = [...newMsgs, { role: "assistant", content: reply }];
      messagesRef.current = withReply;
      setMessages([...withReply]);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);

      setIsProcessing(false);
      setIsJuliaTalking(true);
      setStatusText("julia is talking...");

      Speech.speak(reply, {
        language: "en-US",
        pitch: 1.0,
        rate: 1.0,
        onDone:  () => { setIsJuliaTalking(false); if (isActiveRef.current) resumeListening(); },
        onError: () => { setIsJuliaTalking(false); if (isActiveRef.current) resumeListening(); },
      });
    } catch (e) {
      console.error("Process error:", e);
      setIsProcessing(false);
      resumeListening();
    }
  }

  function resumeListening() {
    if (!isActiveRef.current) return;
    setStatusText("listening...");
    startListening();
  }

  const addMessage = (msg: Message) => {
    const updated = [...messagesRef.current, msg];
    messagesRef.current = updated;
    setMessages(updated);
  };

  // ============================================================
  // INCOMING CALL SCREEN
  // ============================================================
  if (screen === "incoming") {
    return (
      <SafeAreaView style={s.incomingContainer}>
        <Text style={s.incomingLabel}>incoming call</Text>
        <Text style={s.incomingName}>Julia</Text>
        <Text style={s.incomingSubtitle}>your AI friend</Text>

        <Animated.View style={[s.avatarRing, { transform: [{ scale: pulseAnim }] }]}>
          <View style={s.avatar}>
            <Text style={s.avatarText}>J</Text>
          </View>
        </Animated.View>

        <View style={s.callActions}>
          <View style={s.callActionWrapper}>
            <TouchableOpacity style={s.declineBtn} onPress={hangUp}>
              <Text style={s.callBtnIcon}>📵</Text>
            </TouchableOpacity>
            <Text style={s.callActionLabel}>decline</Text>
          </View>
          <View style={s.callActionWrapper}>
            <TouchableOpacity style={s.acceptBtn} onPress={answerCall}>
              <Text style={s.callBtnIcon}>📞</Text>
            </TouchableOpacity>
            <Text style={s.callActionLabel}>accept</Text>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  // ============================================================
  // ACTIVE CALL SCREEN
  // ============================================================
  return (
    <SafeAreaView style={s.callContainer}>

      {/* Call header */}
      <View style={s.callHeader}>
        <Text style={s.callName}>Julia</Text>
        <Text style={s.callTimer}>{formatDuration(callDuration)}</Text>
        <Text style={s.callStatus}>
          {isJuliaTalking ? "julia is talking..." : isProcessing ? "thinking..." : "listening..."}
        </Text>
      </View>

      {/* Avatar */}
      <View style={s.callAvatarWrapper}>
        <View style={[s.avatar, s.callAvatar]}>
          <Text style={s.avatarText}>J</Text>
        </View>
        {isJuliaTalking && (
          <View style={s.speakingRing} />
        )}
      </View>

      {/* Transcript */}
      <ScrollView ref={scrollRef} style={s.transcript} contentContainerStyle={s.transcriptContent}>
        {messages.length === 0 && (
          <Text style={s.transcriptEmpty}>Say something...</Text>
        )}
        {messages.map((msg, i) => (
          <View key={i} style={[s.line, msg.role === "user" ? s.userLine : s.juliaLine]}>
            <Text style={s.lineName}>{msg.role === "user" ? USER_NAME : "Julia"}</Text>
            <Text style={s.lineText}>{msg.content}</Text>
          </View>
        ))}
        {isProcessing && (
          <View style={[s.line, s.juliaLine]}>
            <Text style={s.lineName}>Julia</Text>
            <ActivityIndicator color="#a78bfa" size="small" />
          </View>
        )}
      </ScrollView>

      {/* Hang up */}
      <View style={s.hangUpWrapper}>
        <TouchableOpacity style={s.hangUpBtn} onPress={hangUp}>
          <Text style={s.callBtnIcon}>📵</Text>
        </TouchableOpacity>
        <Text style={s.callActionLabel}>end call</Text>
      </View>

    </SafeAreaView>
  );
}

// ============================================================
// STYLES
// ============================================================
const s = StyleSheet.create({
  // ── Incoming ──
  incomingContainer: {
    flex: 1,
    backgroundColor: "#546087",
    alignItems: "center",
    justifyContent: "space-around",
    paddingTop: 80,
    paddingBottom: 60,
  },
  incomingLabel: {
    fontSize: 14,
    color: "#d0d4e8",
    letterSpacing: 1,
    textTransform: "lowercase",
  },
  incomingName: {
    fontSize: 52,
    fontWeight: "700",
    color: "#ffffff",
    marginTop: 10,
  },
  incomingSubtitle: {
    fontSize: 16,
    color: "#c0c5d8",
    marginTop: 6,
  },
  avatarRing: {
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  avatar: {
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: "rgba(255,255,255,0.25)",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontSize: 60,
    fontWeight: "700",
    color: "#fff",
  },
  callActions: {
    flexDirection: "row",
    justifyContent: "space-around",
    width: "72%",
  },
  callActionWrapper: {
    alignItems: "center",
  },
  callActionLabel: {
    color: "#d0d4e8",
    fontSize: 14,
    marginTop: 12,
  },
  declineBtn: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "#dc2626",
    alignItems: "center",
    justifyContent: "center",
  },
  acceptBtn: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: "#16a34a",
    alignItems: "center",
    justifyContent: "center",
  },
  callBtnIcon: {
    fontSize: 30,
  },

  // ── Active call ──
  callContainer: {
    flex: 1,
    backgroundColor: "#546087",
    alignItems: "center",
  },
  callHeader: {
    alignItems: "center",
    paddingTop: 24,
    paddingBottom: 16,
  },
  callName: {
    fontSize: 28,
    fontWeight: "700",
    color: "#fff",
  },
  callTimer: {
    fontSize: 16,
    color: "#a8f0c0",
    marginTop: 4,
    fontVariant: ["tabular-nums"],
  },
  callStatus: {
    fontSize: 13,
    color: "#555",
    marginTop: 4,
  },
  callAvatarWrapper: {
    alignItems: "center",
    justifyContent: "center",
    marginVertical: 16,
    width: 120,
    height: 120,
  },
  callAvatar: {
    width: 100,
    height: 100,
    borderRadius: 50,
  },
  speakingRing: {
    position: "absolute",
    width: 120,
    height: 120,
    borderRadius: 60,
    borderWidth: 2,
    borderColor: "#7c3aed",
    opacity: 0.6,
  },

  // ── Transcript ──
  transcript: {
    flex: 1,
    width: "100%",
    paddingHorizontal: 20,
  },
  transcriptContent: {
    paddingVertical: 10,
  },
  transcriptEmpty: {
    color: "#c0c5d8",
    textAlign: "center",
    marginTop: 20,
    fontSize: 14,
  },
  line: {
    marginBottom: 12,
  },
  userLine: {
    alignItems: "flex-end",
  },
  juliaLine: {
    alignItems: "flex-start",
  },
  lineName: {
    fontSize: 10,
    color: "#d0d4e8",
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  lineText: {
    fontSize: 14,
    color: "#ffffff",
    lineHeight: 20,
    maxWidth: "85%",
  },

  // ── Hang up ──
  hangUpWrapper: {
    alignItems: "center",
    paddingBottom: 40,
    paddingTop: 16,
  },
  hangUpBtn: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: "#dc2626",
    alignItems: "center",
    justifyContent: "center",
  },
});