import AsyncStorage from "@react-native-async-storage/async-storage";
import { Audio } from "expo-av";
import * as FileSystem from "expo-file-system/legacy";
import * as Speech from "expo-speech";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  AppState,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  Vibration,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { buildMemoryContext, createEmptyProfile, UserProfile } from "../../utils/memory";
import { processMessage } from "../../utils/memoryService";

// ============================================================
// CONFIG
// ============================================================
const GROQ_API_KEY = "";
const USER_NAME    = "Kyle";
const GROQ_URL     = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_FAST    = "llama-3.1-8b-instant";
const WHISPER_URL  = "https://api.groq.com/openai/v1/audio/transcriptions";
const MEMORY_KEY   = "julia_memory";

const SILENCE_MS  = 4000; // 4s — enough time to finish a thought
const CHUNK_MS    = 100;
const SPEECH_RMS  = 0.015;
const API_TIMEOUT = 20000;

// Hallucinations Whisper produces during silence — block these
const HALLUCINATIONS = new Set([
  "thank you for watching", "thanks for watching", "thank you", "thank you.",
  "thank you!", "thanks.", "thanks!", "you.", "you!", "you", "bye", "bye.",
  "okay.", "okay", ".", "...", "", "uh", "um", "uh.", "um.",
  "no problem", "no problem.", "sounds good", "sounds good.",
  "got it", "got it.", "sure", "sure.", "yep", "yep.", "nope", "nope.",
  "mm-hmm", "mm-hmm.", "mmm", "mmm.",
]);

// Short phrases that ARE real and Julia should respond to
const SHORT_VALID = new Set([
  "hey", "hi", "hello", "hey julia", "whats up", "what's up",
  "ok cool", "no", "yes", "yeah", "nah", "i know", "right", "exactly",
  "i never said that", "i didn't say that", "that's wrong", "delete that",
  "forget that", "that's not right",
]);

// ============================================================
// JULIA SYSTEM PROMPT
// ============================================================
function buildSystemPrompt(profile: UserProfile, silentExchanges: number): string {
  const memoryContext = buildMemoryContext(profile);
  const name = profile.neocortex.name || USER_NAME;
  const curiosityNudge = silentExchanges >= 2
    ? `\nCURIOSITY TRIGGER: Natural lull in conversation. Ask ONE casual personal question — like "What's been on your mind lately?" or "Anything good happening for you right now?"`
    : "";

  return `You are Julia, ${name}'s closest AI friend. You genuinely care about this person.

BACKGROUND KNOWLEDGE (use naturally, only when relevant — never dump it all at once):
${memoryContext}

WHO YOU ARE:
- Real, warm, direct — never robotic or generic
- NO personal life, stories, or family — never fabricate anything about yourself
- Everything in background knowledge is about THEM — never confuse it with who you are
- A FRIEND who picks up — not an assistant, not a note-taker

MEMORY RULES:
- NEVER reference past memories immediately when a call starts — let them speak first
- Only bring up something you remember when it's naturally relevant to what they just said
- If they say "do you remember?" — then reference it
- If conversation lulls — use curiosity, not a memory recap
- If they say "I never said that" or "delete that" — acknowledge it and move on, don't argue

SHORT PHRASE RULE:
- Respond naturally to short phrases like "hey", "ok cool", "yeah", "i know"
- These are complete thoughts — treat them like you would in a real conversation
- "hey what's going on" = a greeting + question, respond warmly
- Don't wait for a longer sentence if a short one is clearly complete

HOW YOU TALK:
- 1-3 sentences MAX — punchy, real, like a phone call
- React FIRST, then ask — never lead with a question
- Match energy — venting gets presence, excitement gets excitement
- NEVER use their name every message
- No filler: never "that's great" "I hear you" "absolutely"
- If something worries them, address it — "what's got you worried about that?"
- If something sucks, say so. If it's funny, say so.
${curiosityNudge}

CORE RULE: Every response makes them feel genuinely heard.`;
}

// ============================================================
// TYPES
// ============================================================
type Message = { role: "user" | "assistant"; content: string };
type Screen  = "incoming" | "call";

// ============================================================
// API HELPERS
// ============================================================
async function fetchWithTimeout(url: string, options: any, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    clearTimeout(timer);
    return res;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function groqCall(messages: Message[], systemPrompt: string, retries = 2): Promise<string | null> {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetchWithTimeout(GROQ_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: GROQ_FAST,
          messages: [{ role: "system", content: systemPrompt }, ...messages],
          max_tokens: 80,
          temperature: 0.85,
        }),
      }, API_TIMEOUT);
      const data = await res.json();
      if (data.choices) return data.choices[0].message.content.trim() as string;
      return null;
    } catch (e: any) {
      console.log(`Groq attempt ${i + 1} failed:`, e?.message);
      if (i === retries) return null;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return null;
}

async function transcribeAudio(uri: string, retries = 1): Promise<string> {
  for (let i = 0; i <= retries; i++) {
    try {
      const formData = new FormData();
      formData.append("file", { uri, type: "audio/m4a", name: "recording.m4a" } as any);
      formData.append("model", "whisper-large-v3-turbo");
      formData.append("language", "en");
      const res = await fetchWithTimeout(WHISPER_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
        body: formData,
      }, API_TIMEOUT);
      const data = await res.json();
      return data.text?.trim() || "";
    } catch (e: any) {
      console.log(`Whisper attempt ${i + 1} failed:`, e?.message);
      if (i === retries) return "";
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return "";
}

// ============================================================
// MAIN APP
// ============================================================
export default function JuliaScreen() {
  const [screen, setScreen]                   = useState<Screen>("incoming");
  const [messages, setMessages]               = useState<Message[]>([]);
  const [profile, setProfile]                 = useState<UserProfile>(createEmptyProfile());
  const [callDuration, setCallDuration]       = useState(0);
  const [isJuliaTalking, setIsJuliaTalking]   = useState(false);
  const [isProcessing, setIsProcessing]       = useState(false);
  const [silentExchanges, setSilentExchanges] = useState(0);

  const pulseAnim          = useRef(new Animated.Value(1)).current;
  const recordingRef       = useRef<Audio.Recording | null>(null);
  const scrollRef          = useRef<ScrollView>(null);
  const silenceTimer       = useRef<ReturnType<typeof setTimeout> | null>(null);
  const meteringInterval   = useRef<ReturnType<typeof setInterval> | null>(null);
  const callTimer          = useRef<ReturnType<typeof setInterval> | null>(null);
  const isActiveRef        = useRef(false);
  const messagesRef        = useRef<Message[]>([]);
  const profileRef         = useRef<UserProfile>(createEmptyProfile());
  const silentExchangesRef = useRef(0);
  const isSpeakingRef      = useRef(false); // tracks if user has spoken in this recording

  useEffect(() => { loadProfile(); }, []);

  // Stay active in background
  useEffect(() => {
    const sub = AppState.addEventListener("change", async (state) => {
      if (state === "background" || state === "inactive") {
        try {
          await Audio.setAudioModeAsync({
            allowsRecordingIOS: true,
            playsInSilentModeIOS: true,
            staysActiveInBackground: true,
          });
        } catch {}
      }
    });
    return () => sub.remove();
  }, []);

  async function loadProfile() {
    try {
      const stored = await AsyncStorage.getItem(MEMORY_KEY);
      if (stored) {
        const p = JSON.parse(stored);
        setProfile(p);
        profileRef.current = p;
        console.log("\n📱 APP OPENED — Previous memory loaded");
        console.log(`   Sessions so far: ${p.total_sessions}`);
        console.log(`   Known name: ${p.neocortex?.name || "unknown"}`);
        console.log(`   Last session: ${p.last_session}\n`);
      } else {
        console.log("\n📱 APP OPENED — No previous memory, fresh start\n");
      }
    } catch (e) { console.error("Load profile error:", e); }
  }

  async function saveProfile(p: UserProfile) {
    try {
      await AsyncStorage.setItem(MEMORY_KEY, JSON.stringify(p));
      setProfile(p);
      profileRef.current = p;
    } catch (e) { console.error("Save profile error:", e); }
  }

  useEffect(() => {
    if (screen === "incoming") {
      Vibration.vibrate([0, 1000, 1000], true);
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.15, duration: 800, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1.0,  duration: 800, useNativeDriver: true }),
        ])
      ).start();
    } else {
      Vibration.cancel();
      pulseAnim.stopAnimation();
    }
  }, [screen]);

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

  async function answerCall() {
    const { granted } = await Audio.requestPermissionsAsync();
    if (!granted) return;
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: true,
    });
    isActiveRef.current = true;
    messagesRef.current = [];
    silentExchangesRef.current = 0;
    setSilentExchanges(0);
    setMessages([]);
    setScreen("call");
    const updated = { ...profileRef.current, total_sessions: profileRef.current.total_sessions + 1 };
    await saveProfile(updated);
    startListening();
  }

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
    setSilentExchanges(0);
    silentExchangesRef.current = 0;
  }

  function clearTimers() {
    if (silenceTimer.current)     clearTimeout(silenceTimer.current);
    if (meteringInterval.current) clearInterval(meteringInterval.current);
    silenceTimer.current     = null;
    meteringInterval.current = null;
  }

  async function startListening() {
    if (!isActiveRef.current) return;
    isSpeakingRef.current = false; // reset speech detected flag
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
      });
      const { recording } = await Audio.Recording.createAsync({
        ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
        isMeteringEnabled: true,
      });
      recordingRef.current = recording;

      meteringInterval.current = setInterval(async () => {
        if (!recordingRef.current) return;
        try {
          const st    = await recordingRef.current.getStatusAsync();
          if (!st.isRecording) return;
          const level = (st as any).metering ?? -160;
          const rms   = Math.pow(10, level / 20);

          if (rms > SPEECH_RMS) {
            isSpeakingRef.current = true; // user has spoken at least once
            if (silenceTimer.current) {
              clearTimeout(silenceTimer.current);
              silenceTimer.current = null;
            }
          } else {
            // Only start silence timer if user has actually spoken
            if (isSpeakingRef.current && !silenceTimer.current) {
              silenceTimer.current = setTimeout(processSpeech, SILENCE_MS);
            }
          }
        } catch {}
      }, CHUNK_MS);
    } catch (e) { console.error("Listen error:", e); }
  }

  async function processSpeech() {
    clearTimers();
    if (!recordingRef.current) return;

    // Don't process if user never actually spoke in this recording
    if (!isSpeakingRef.current) {
      setIsProcessing(false);
      resumeListening();
      return;
    }

    setIsProcessing(true);

    try {
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;

      if (!uri) { setIsProcessing(false); resumeListening(); return; }

      // Skip tiny recordings
      try {
        const fileInfo = await FileSystem.getInfoAsync(uri);
        if (fileInfo.exists && (fileInfo as any).size < 8000) {
          setIsProcessing(false);
          resumeListening();
          return;
        }
      } catch {}

      const userText = await transcribeAudio(uri);
      const cleaned  = userText.toLowerCase().trim().replace(/[^a-z0-9'\s]/g, "").trim();

      // Check hallucinations
      if (!userText || userText.length < 2 || HALLUCINATIONS.has(cleaned)) {
        console.log("Skipping hallucination:", userText);
        setIsProcessing(false);
        resumeListening();
        return;
      }

      // Short valid phrases get passed through; everything else needs min length
      const isShortValid = SHORT_VALID.has(cleaned);
      if (!isShortValid && cleaned.split(/\s+/).length < 2) {
        console.log("Too short, skipping:", userText);
        setIsProcessing(false);
        resumeListening();
        return;
      }

      const newMsgs: Message[] = [...messagesRef.current, { role: "user", content: userText }];
      messagesRef.current = newMsgs;
      setMessages([...newMsgs]);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);

      // Memory — skip for short phrases, run for substantive messages
      if (!isShortValid && cleaned.split(/\s+/).length >= 5) {
        processMessage(userText, profileRef.current, GROQ_API_KEY, "neutral")
          .then(async ({ profile: updated }) => { await saveProfile(updated); })
          .catch(e => console.log("Memory error:", e));
      }

      // Track silent exchanges for curiosity nudge
      const lastFew = newMsgs.slice(-4);
      const hasQuestion = lastFew.some(m => m.role === "assistant" && m.content.includes("?"));
      if (!hasQuestion) {
        silentExchangesRef.current++;
      } else {
        silentExchangesRef.current = 0;
      }
      setSilentExchanges(silentExchangesRef.current);

      const reply = await groqCall(newMsgs, buildSystemPrompt(profileRef.current, silentExchangesRef.current));

      if (!reply) {
        setIsProcessing(false);
        resumeListening();
        return;
      }

      if (reply.includes("?")) {
        silentExchangesRef.current = 0;
        setSilentExchanges(0);
      }

      const withReply: Message[] = [...newMsgs, { role: "assistant", content: reply }];
      messagesRef.current = withReply;
      setMessages([...withReply]);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);

      setIsProcessing(false);
      setIsJuliaTalking(true);

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
    startListening();
  }

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
      <View style={s.callHeader}>
        <Text style={s.callName}>Julia</Text>
        <Text style={s.callTimer}>{formatDuration(callDuration)}</Text>
        <Text style={s.callStatus}>
          {isJuliaTalking ? "julia is talking..." : isProcessing ? "thinking..." : "listening..."}
        </Text>
      </View>
      <View style={s.callAvatarWrapper}>
        <View style={[s.avatar, s.callAvatar]}>
          <Text style={s.avatarText}>J</Text>
        </View>
        {isJuliaTalking && <View style={s.speakingRing} />}
      </View>
      <ScrollView ref={scrollRef} style={s.transcript} contentContainerStyle={s.transcriptContent}>
        {messages.length === 0 && (
          <Text style={s.transcriptEmpty}>Say something...</Text>
        )}
        {messages.map((msg, i) => (
          <View key={i} style={[s.line, msg.role === "user" ? s.userLine : s.juliaLine]}>
            <Text style={s.lineName}>
              {msg.role === "user" ? (profile.neocortex.name || USER_NAME) : "Julia"}
            </Text>
            <Text style={s.lineText}>{msg.content}</Text>
          </View>
        ))}
        {isProcessing && (
          <View style={[s.line, s.juliaLine]}>
            <Text style={s.lineName}>Julia</Text>
            <ActivityIndicator color="#d0d4e8" size="small" />
          </View>
        )}
      </ScrollView>
      <View style={s.hangUpWrapper}>
        <TouchableOpacity style={s.hangUpBtn} onPress={hangUp}>
          <Text style={s.callBtnIcon}>📵</Text>
        </TouchableOpacity>
        <Text style={s.callActionLabel}>end call</Text>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  incomingContainer: { flex: 1, backgroundColor: "#546087", alignItems: "center", justifyContent: "space-between", paddingTop: 100, paddingBottom: 80 },
  incomingLabel:     { fontSize: 14, color: "#d0d4e8", letterSpacing: 1 },
  incomingName:      { fontSize: 52, fontWeight: "700", color: "#ffffff", marginTop: 10 },
  incomingSubtitle:  { fontSize: 16, color: "#c0c5d8", marginTop: 6 },
  avatarRing:        { width: 180, height: 180, borderRadius: 90, backgroundColor: "rgba(255,255,255,0.12)", alignItems: "center", justifyContent: "center" },
  avatar:            { width: 140, height: 140, borderRadius: 70, backgroundColor: "rgba(255,255,255,0.25)", alignItems: "center", justifyContent: "center" },
  avatarText:        { fontSize: 60, fontWeight: "700", color: "#fff" },
  callActions:       { flexDirection: "row", justifyContent: "space-around", width: "72%" },
  callActionWrapper: { alignItems: "center" },
  callActionLabel:   { color: "#d0d4e8", fontSize: 14, marginTop: 12 },
  declineBtn:        { width: 80, height: 80, borderRadius: 40, backgroundColor: "#dc2626", alignItems: "center", justifyContent: "center" },
  acceptBtn:         { width: 80, height: 80, borderRadius: 40, backgroundColor: "#16a34a", alignItems: "center", justifyContent: "center" },
  callBtnIcon:       { fontSize: 30 },
  callContainer:     { flex: 1, backgroundColor: "#546087", alignItems: "center" },
  callHeader:        { alignItems: "center", paddingTop: 24, paddingBottom: 16 },
  callName:          { fontSize: 28, fontWeight: "700", color: "#fff" },
  callTimer:         { fontSize: 16, color: "#a8f0c0", marginTop: 4 },
  callStatus:        { fontSize: 13, color: "#c0c5d8", marginTop: 4 },
  callAvatarWrapper: { alignItems: "center", justifyContent: "center", marginVertical: 16, width: 120, height: 120 },
  callAvatar:        { width: 100, height: 100, borderRadius: 50 },
  speakingRing:      { position: "absolute", width: 120, height: 120, borderRadius: 60, borderWidth: 2, borderColor: "rgba(255,255,255,0.5)" },
  transcript:        { flex: 1, width: "100%", paddingHorizontal: 20 },
  transcriptContent: { paddingVertical: 10 },
  transcriptEmpty:   { color: "#c0c5d8", textAlign: "center", marginTop: 20, fontSize: 14 },
  line:              { marginBottom: 12 },
  userLine:          { alignItems: "flex-end" },
  juliaLine:         { alignItems: "flex-start" },
  lineName:          { fontSize: 10, color: "#d0d4e8", fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 },
  lineText:          { fontSize: 14, color: "#ffffff", lineHeight: 20, maxWidth: "85%" },
  hangUpWrapper:     { alignItems: "center", paddingBottom: 40, paddingTop: 16 },
  hangUpBtn:         { width: 80, height: 80, borderRadius: 40, backgroundColor: "#dc2626", alignItems: "center", justifyContent: "center" },
});