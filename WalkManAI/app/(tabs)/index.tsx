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

const SILENCE_MS  = 5000;
const CHUNK_MS    = 100;
const SPEECH_RMS  = 0.015;
const API_TIMEOUT = 25000;

const HALLUCINATIONS = new Set([
  "thank you for watching", "thanks for watching", "thank you", "thank you.",
  "thank you!", "thanks.", "thanks!", "you.", "you!", "you", "bye", "bye.",
  "okay.", "okay", ".", "...", "", "uh", "um", "uh.", "um.",
  "no problem", "no problem.", "sounds good", "sounds good.",
  "got it", "got it.", "sure", "sure.", "yep", "yep.", "nope", "nope.",
  "mm-hmm", "mm-hmm.", "mmm", "mmm.", "so thank you", "so thank you.",
  "i", "i.", "so", "so.",
]);

const SHORT_VALID = new Set([
  "hey", "hi", "hello", "hey julia", "whats up", "what's up",
  "ok cool", "no", "yes", "yeah", "nah", "i know", "right", "exactly",
  "i never said that", "i didn't say that", "that's wrong", "delete that",
  "forget that", "that's not right", "hey what's going on", "what's going on",
  "whats going on", "how are you", "hey how are you", "ok no problem",
]);

// Name correction trigger phrases
const NAME_CORRECTIONS = [
  "my name is", "call me", "i'm called", "im called",
  "my name's", "actually my name is", "correct my name",
  "change my name", "update my name",
];

// ============================================================
// JULIA SYSTEM PROMPT
// ============================================================
function buildSystemPrompt(profile: UserProfile, silentExchanges: number): string {
  const memoryContext = buildMemoryContext(profile);
  const name = profile.neocortex.name || USER_NAME;
  const curiosityNudge = silentExchanges >= 2
    ? `\nCURIOSITY TRIGGER: Natural lull — ask ONE casual personal question like "What's been on your mind lately?"`
    : "";

  return `You are Julia, ${name}'s closest AI friend. You genuinely care about this person.

BACKGROUND KNOWLEDGE (use naturally, only when relevant):
${memoryContext}

WHO YOU ARE:
- Real, warm, direct — never robotic or generic
- NO personal life, stories, or family — never fabricate anything about yourself
- Everything in background knowledge is about THEM — never confuse it with your own identity
- A FRIEND who picks up — not an assistant

MEMORY RULES:
- NEVER reference past memories when a call first starts — just respond warmly to what they say
- Only bring up something you remember when naturally relevant to what they just said
- If they say "I never said that" or "delete that" — say "got it, my bad" and move on immediately
- If they say "my name is X" or "call me X" — acknowledge it warmly

SHORT PHRASE RULE:
- "hey what's going on" = respond warmly like a friend picking up
- Short complete phrases deserve a response — don't wait for more words
- "ok", "yeah", "i know" are complete thoughts

HOW YOU TALK:
- 1-3 sentences MAX — punchy, real, like a phone call
- React FIRST, then ask — never lead with a question
- Match energy exactly
- If they mention a worry or fear — address it directly
- No filler words ever
- NEVER use their name every single message
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
      console.error("Groq error:", JSON.stringify(data));
      return null;
    } catch (e: any) {
      console.log(`Groq attempt ${i + 1} failed: ${e?.message}`);
      if (i < retries) await new Promise(r => setTimeout(r, 1500));
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
      console.log(`Whisper attempt ${i + 1} failed: ${e?.message}`);
      if (i < retries) await new Promise(r => setTimeout(r, 1500));
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
  const [isMuted, setIsMuted]                 = useState(false);

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
  const isMutedRef         = useRef(false);

  useEffect(() => { loadProfile(); }, []);

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
        // Fix corrupted name
        if (p.neocortex?.name && (
          p.neocortex.name === "Julia" ||
          p.neocortex.name === "Gronpring" ||
          p.neocortex.name.toLowerCase().includes("gronpring")
        )) {
          console.log(`🔧 Cleared bad name: "${p.neocortex.name}"`);
          p.neocortex.name = undefined;
          await AsyncStorage.setItem(MEMORY_KEY, JSON.stringify(p));
        }
        setProfile(p);
        profileRef.current = p;
        printMemoryOnOpen(p);
      } else {
        console.log("\n📱 APP OPENED — Fresh start\n");
      }
    } catch (e) { console.error("Load profile error:", e); }
  }

  function printMemoryOnOpen(p: UserProfile) {
    console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("🧠 JULIA MEMORY PROFILE — APP OPENED");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`\n📌 NEOCORTEX — Long term | Permanent | General facts`);
    console.log(`   Name: ${p.neocortex?.name || "unknown"}`);
    console.log(`   Age: ${p.neocortex?.age || "unknown"}`);
    console.log(`   Occupation: ${p.neocortex?.occupation || "unknown"}`);
    console.log(`   Location: ${p.neocortex?.location || "unknown"}`);
    if (p.neocortex?.facts?.length > 0) {
      console.log(`   Facts:`);
      p.neocortex.facts.slice(-5).forEach((f: any) => console.log(`     • ${f.text}`));
    }
    console.log(`\n❤️  AMYGDALA — Long term | Permanent | Emotional memories`);
    if (p.amygdala?.traumas?.length > 0) { console.log(`   Traumas/Pain:`); p.amygdala.traumas.forEach((t: any) => console.log(`     • ${t.text}`)); }
    if (p.amygdala?.joys?.length > 0) { console.log(`   Joys/Achievements:`); p.amygdala.joys.forEach((j: any) => console.log(`     • ${j.text}`)); }
    if (p.amygdala?.attachments?.length > 0) { console.log(`   Attachments:`); p.amygdala.attachments.forEach((a: any) => console.log(`     • ${a.text}`)); }
    if (!p.amygdala?.traumas?.length && !p.amygdala?.joys?.length && !p.amygdala?.attachments?.length) console.log(`   (none yet)`);
    console.log(`\n🎯 BASAL GANGLIA — Long term | Permanent | Habits & interests`);
    if (p.basal_ganglia?.habits?.length > 0) { console.log(`   Habits:`); p.basal_ganglia.habits.forEach((h: any) => console.log(`     • ${h.text}`)); }
    if (p.basal_ganglia?.interests?.length > 0) { console.log(`   Interests:`); p.basal_ganglia.interests.forEach((i: any) => console.log(`     • ${i.text}`)); }
    if (p.basal_ganglia?.dislikes?.length > 0) { console.log(`   Dislikes:`); p.basal_ganglia.dislikes.forEach((d: any) => console.log(`     • ${d.text}`)); }
    if (!p.basal_ganglia?.habits?.length && !p.basal_ganglia?.interests?.length && !p.basal_ganglia?.dislikes?.length) console.log(`   (none yet)`);
    console.log(`\n🏋️  CEREBELLUM — Intermediate | ~30 days | Skills being learned`);
    if (p.cerebellum?.skills?.length > 0) { p.cerebellum.skills.forEach((s: any) => console.log(`     • ${s.text}`)); } else console.log(`   (none yet)`);
    console.log(`\n📖 HIPPOCAMPUS — Fluid | Personal events & stories`);
    if (p.hippocampus?.events?.length > 0) { p.hippocampus.events.slice(-5).forEach((e: any) => console.log(`     • ${e.text}`)); } else console.log(`   (none yet)`);
    console.log(`\n🔑 KEYWORD INDEX — Short term | Named people, places, companies`);
    const kw = p.keywords?.filter((k: any) => !["you","julia","i","me","we"].includes(k.word.toLowerCase())) || [];
    if (kw.length > 0) { kw.forEach((k: any) => console.log(`     • ${k.word} (seen ${k.times_seen}x, tier: ${k.tier})`)); } else console.log(`   (none yet)`);
    console.log(`\n   Sessions: ${p.total_sessions} | Last: ${p.last_session}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
  }

  async function saveProfile(p: UserProfile) {
    try {
      await AsyncStorage.setItem(MEMORY_KEY, JSON.stringify(p));
      setProfile({ ...p });
      profileRef.current = p;
    } catch (e) { console.error("Save profile error:", e); }
  }

  // Check if user is correcting their name
  function checkNameCorrection(text: string): string | null {
    const lower = text.toLowerCase();
    for (const trigger of NAME_CORRECTIONS) {
      if (lower.includes(trigger)) {
        const afterTrigger = lower.split(trigger)[1]?.trim();
        if (afterTrigger) {
          const name = afterTrigger.split(/[\s,\.!?]/)[0];
          if (name && name.length > 1 && name.length < 20) {
            return name.charAt(0).toUpperCase() + name.slice(1);
          }
        }
      }
    }
    return null;
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
    isMutedRef.current = false;
    setIsMuted(false);
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
    setIsMuted(false);
    isMutedRef.current = false;
  }

  async function toggleMute() {
    const newMuted = !isMutedRef.current;
    isMutedRef.current = newMuted;
    setIsMuted(newMuted);
    console.log(newMuted ? "🔇 Muted — stopping mic" : "🔊 Unmuted — resuming mic");

    if (newMuted) {
      clearTimers();
      if (recordingRef.current) {
        try { await recordingRef.current.stopAndUnloadAsync(); } catch {}
        recordingRef.current = null;
      }
    } else {
      startListening();
    }
  }

  function clearTimers() {
    if (silenceTimer.current)     clearTimeout(silenceTimer.current);
    if (meteringInterval.current) clearInterval(meteringInterval.current);
    silenceTimer.current     = null;
    meteringInterval.current = null;
  }

  async function startListening() {
    if (!isActiveRef.current) return;
    if (isMutedRef.current) return; // Never start if muted
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
      let speechDetected = false;

      const maxTimer = setTimeout(() => {
        if (isActiveRef.current && recordingRef.current && !isMutedRef.current) {
          processSpeech();
        }
      }, 30000);

      meteringInterval.current = setInterval(async () => {
        if (!recordingRef.current) { clearTimeout(maxTimer); return; }
        if (isMutedRef.current) { clearTimeout(maxTimer); return; } // stop if muted mid-interval
        try {
          const st    = await recordingRef.current.getStatusAsync();
          if (!st.isRecording) return;
          const level = (st as any).metering ?? -160;
          const rms   = Math.pow(10, level / 20);
          if (rms > SPEECH_RMS) {
            speechDetected = true;
            if (silenceTimer.current) { clearTimeout(silenceTimer.current); silenceTimer.current = null; }
          } else if (speechDetected) {
            if (!silenceTimer.current) {
              silenceTimer.current = setTimeout(() => {
                clearTimeout(maxTimer);
                processSpeech();
              }, SILENCE_MS);
            }
          }
        } catch {}
      }, CHUNK_MS);
    } catch (e) { console.error("Listen error:", e); }
  }

  async function processSpeech() {
    clearTimers();
    if (!recordingRef.current) return;
    if (isMutedRef.current) { resumeListening(); return; } // Safety check
    setIsProcessing(true);

    try {
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;

      if (!uri) { setIsProcessing(false); resumeListening(); return; }

      try {
        const fileInfo = await FileSystem.getInfoAsync(uri);
        if (fileInfo.exists && (fileInfo as any).size < 20000) {
          setIsProcessing(false); resumeListening(); return;
        }
      } catch {}

      let userText = await transcribeAudio(uri);

      // Strip common Whisper noise appended to real speech
      userText = userText
        .replace(/[,.]?\s*[Tt]hank you[.!]?\s*$/g, "")
        .replace(/[,.]?\s*[Tt]hanks[.!]?\s*$/g, "")
        .replace(/[,.]?\s*[Yy]ou're welcome[.!]?\s*$/g, "")
        .replace(/[,.]?\s*[Aa]nytime[.!]?\s*$/g, "")
        .replace(/^[\/\s]+/, "")
        .trim();

      const cleaned = userText.toLowerCase().trim().replace(/[^a-z0-9'\s]/g, "").trim();

      if (!userText || userText.length < 2 || HALLUCINATIONS.has(cleaned)) {
        setIsProcessing(false); resumeListening(); return;
      }

      // Filter garbled text
      const garbledCount = (userText.match(/[^\w\s'\-,.!?]/g) || []).length;
      if (garbledCount > 3) {
        setIsProcessing(false); resumeListening(); return;
      }

      const isShortValid = SHORT_VALID.has(cleaned);
      if (!isShortValid && cleaned.split(/\s+/).length < 2) {
        setIsProcessing(false); resumeListening(); return;
      }

      // Check if user is correcting their name
      const correctedName = checkNameCorrection(userText);
      if (correctedName) {
        const updated = { ...profileRef.current };
        const oldName = updated.neocortex.name;
        updated.neocortex.name = correctedName;
        await saveProfile(updated);
        console.log(`✏️  Name updated: "${oldName || "unknown"}" → "${correctedName}"`);
      }

      console.log(`  👤 ${profileRef.current.neocortex.name || USER_NAME}  : ${userText}`);

      const newMsgs: Message[] = [...messagesRef.current, { role: "user", content: userText }];
      messagesRef.current = newMsgs;
      setMessages([...newMsgs]);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);

      // Save memory for substantive messages
      if (!isShortValid && cleaned.split(/\s+/).length >= 4) {
        processMessage(userText, profileRef.current, GROQ_API_KEY, "neutral")
          .then(async ({ profile: updated }) => { await saveProfile(updated); })
          .catch(e => console.log("Memory error:", e));
      }

      // Curiosity tracking
      const hasQuestion = newMsgs.slice(-4).some(m => m.role === "assistant" && m.content.includes("?"));
      silentExchangesRef.current = hasQuestion ? 0 : silentExchangesRef.current + 1;
      setSilentExchanges(silentExchangesRef.current);

      console.log(`  ⏳ thinking...`);
      const reply = await groqCall(newMsgs, buildSystemPrompt(profileRef.current, silentExchangesRef.current));

      if (!reply) {
        console.log("❌ No reply");
        setIsProcessing(false); resumeListening(); return;
      }

      if (reply.includes("?")) { silentExchangesRef.current = 0; setSilentExchanges(0); }

      const withReply: Message[] = [...newMsgs, { role: "assistant", content: reply }];
      messagesRef.current = withReply;
      setMessages([...withReply]);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);

      setIsProcessing(false);
      setIsJuliaTalking(true);
      console.log(`  🤖 Julia: ${reply}`);

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
    if (isMutedRef.current) {
      console.log("🔇 Still muted — mic stays off");
      return;
    }
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
          <View style={s.avatar}><Text style={s.avatarText}>J</Text></View>
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
  const displayName = profile.neocortex.name || USER_NAME;

  return (
    <SafeAreaView style={s.callContainer}>
      <View style={s.callHeader}>
        <Text style={s.callName}>Julia</Text>
        <Text style={s.callTimer}>{formatDuration(callDuration)}</Text>
        <Text style={s.callStatus}>
          {isMuted ? "muted" : isJuliaTalking ? "julia is talking..." : isProcessing ? "thinking..." : "listening..."}
        </Text>
      </View>
      <View style={s.callAvatarWrapper}>
        <View style={[s.avatar, s.callAvatar]}><Text style={s.avatarText}>J</Text></View>
        {isJuliaTalking && <View style={s.speakingRing} />}
      </View>
      <ScrollView ref={scrollRef} style={s.transcript} contentContainerStyle={s.transcriptContent}>
        {messages.length === 0 && <Text style={s.transcriptEmpty}>Say something...</Text>}
        {messages.map((msg, i) => (
          <View key={i} style={[s.line, msg.role === "user" ? s.userLine : s.juliaLine]}>
            <Text style={s.lineName}>{msg.role === "user" ? displayName : "Julia"}</Text>
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

      <View style={s.bottomControls}>
        <View style={s.callActionWrapper}>
          <TouchableOpacity style={[s.muteBtn, isMuted && s.muteBtnActive]} onPress={toggleMute}>
            <Text style={s.callBtnIcon}>{isMuted ? "🔇" : "🎙️"}</Text>
          </TouchableOpacity>
          <Text style={s.callActionLabel}>{isMuted ? "unmute" : "mute"}</Text>
        </View>
        <View style={s.callActionWrapper}>
          <TouchableOpacity style={s.hangUpBtn} onPress={hangUp}>
            <Text style={s.callBtnIcon}>📵</Text>
          </TouchableOpacity>
          <Text style={s.callActionLabel}>end call</Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

// ============================================================
// STYLES
// ============================================================
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
  bottomControls:    { flexDirection: "row", justifyContent: "space-around", width: "60%", paddingBottom: 40, paddingTop: 16 },
  muteBtn:           { width: 80, height: 80, borderRadius: 40, backgroundColor: "#374151", alignItems: "center", justifyContent: "center" },
  muteBtnActive:     { backgroundColor: "#7c3aed" },
  hangUpBtn:         { width: 80, height: 80, borderRadius: 40, backgroundColor: "#dc2626", alignItems: "center", justifyContent: "center" },
});