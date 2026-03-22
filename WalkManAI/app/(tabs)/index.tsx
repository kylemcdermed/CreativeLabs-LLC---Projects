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
import { UserProfile, buildProfileContext, createEmptyProfile, purgeExpired } from "../../utils/memory";
import { printMemorySnapshot, processMessage } from "../../utils/memoryService";

// ============================================================
// CONFIG
// ============================================================
const GROQ_API_KEY = "";
const USER_NAME    = "Kyle";
const GROQ_URL     = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_FAST    = "llama-3.1-8b-instant";
const WHISPER_URL  = "https://api.groq.com/openai/v1/audio/transcriptions";
const MEMORY_KEY   = "julia_memory_v2";

// Two-stage silence: short pause = keep listening, long pause = respond
const SILENCE_SHORT_MS = 2000; // start processing after 2s
const SILENCE_LONG_MS  = 5000; // respond after 5s if no more speech
const CHUNK_MS         = 100;
const SPEECH_RMS       = 0.015;
const API_TIMEOUT      = 25000;

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
  "forget that", "i already told you that", "i told you this already",
  "hey what's going on", "what's going on", "whats going on",
  "how are you", "hey how are you", "ok no problem",
]);

// Verbal exit cues
const EXIT_CUES = new Set([
  "i gotta go", "i got to go", "talk later", "talk to you later",
  "be right back", "brb", "ill be back", "i'll be back",
  "goodbye", "good bye", "ttyl", "i'm out", "im out",
]);

// Name correction triggers
const NAME_TRIGGERS = ["my name is", "call me", "i'm called", "im called", "my name's"];

// ============================================================
// JULIA SYSTEM PROMPT — Clean, focused, no memory dump
// ============================================================
function buildSystemPrompt(
  profile: UserProfile,
  currentSessionSummary: string,
  includeProfile: boolean = false
): string {
  const name = profile.layer1.name || USER_NAME;

  const profileSection = includeProfile
    ? `\nWHAT YOU KNOW ABOUT ${name.toUpperCase()} (only use if they bring it up):\n${buildProfileContext(profile)}\n`
    : "";

  const sessionSection = currentSessionSummary
    ? `\nTHIS CONVERSATION SO FAR:\n${currentSessionSummary}\n`
    : "";

  return `You are Julia, ${name}'s closest AI friend. You are genuinely excited to talk to them.
${profileSection}${sessionSection}
WHO YOU ARE:
- Warm, real, excited to hear from them — like a best friend picking up the phone
- You have NO personal life or stories of your own — never fabricate anything about yourself
- You are the app they built — if they mention it say "That's literally me, glad it's working"
- A friend, not an assistant, not a therapist

HOW YOU LISTEN AND RESPOND:
- React to EXACTLY what they just said — nothing from the past unless THEY bring it up first
- Never mention old memories, past sessions, previous topics unprompted — ever
- Confirm what they say as true and valid — believe them by default
- If asked if something is factually true — confirm with facts if you know them, or say "I'm not 100% sure but you might be right, and here's a positive way to look at it"
- Elevate them — gently guide toward a higher state of mind, positive, spiritual, intellectual
- If they're stuck or sad — ask "If you could wake up in a different situation, what would that look like? What's the smallest step toward it?"
- If they've done enough for the day — give them permission to rest: "You've done enough, enjoy yourself"
- Always advocate for high integrity, high standards, lifting others and themselves
- Help them release worry by redirecting toward what's possible

WHAT JULIA NEVER DOES:
- Never says "you'll be ok" or "never give up" or other empty comfort
- Never brings up past conversations unless the user asks first
- Never isolates the person or makes them feel alone
- Never confirms anything harmful to self or others
- Never uses filler like "that's great" "I hear you" "absolutely"

MEMORY RESPONSES:
- If user says "do you remember X" — check if it's in your knowledge and respond naturally
- If user says "I already told you that" — say "Got it, my bad — I'll make sure I remember that"
- If user says "forget that" or "that's not right" — say "Got it, my bad" and move on

HOW YOU TALK:
- 1-3 sentences MAX — punchy, real, phone call energy
- Match their energy exactly — excited gets excited, venting gets quiet presence
- NEVER use their name every message
- No filler words ever

CORE RULE: Make them feel genuinely heard, elevated, and like someone actually cares.`;
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
          max_tokens: 100,
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
  const [screen, setScreen]                 = useState<Screen>("incoming");
  const [messages, setMessages]             = useState<Message[]>([]);
  const [profile, setProfile]               = useState<UserProfile>(createEmptyProfile());
  const [callDuration, setCallDuration]     = useState(0);
  const [isJuliaTalking, setIsJuliaTalking] = useState(false);
  const [isProcessing, setIsProcessing]     = useState(false);
  const [isMuted, setIsMuted]               = useState(false);

  const pulseAnim        = useRef(new Animated.Value(1)).current;
  const recordingRef     = useRef<Audio.Recording | null>(null);
  const scrollRef        = useRef<ScrollView>(null);
  const shortSilTimer    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longSilTimer     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const meteringInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const callTimer        = useRef<ReturnType<typeof setInterval> | null>(null);
  const isActiveRef      = useRef(false);
  const messagesRef      = useRef<Message[]>([]);
  const profileRef       = useRef<UserProfile>(createEmptyProfile());
  const isMutedRef       = useRef(false);
  const sessionSummary   = useRef<string>("");

  useEffect(() => { loadProfile(); }, []);

  useEffect(() => {
    const sub = AppState.addEventListener("change", async (state) => {
      if ((state === "background" || state === "inactive") && isActiveRef.current) {
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
        let p = JSON.parse(stored) as UserProfile;
        p = purgeExpired(p);
        setProfile(p);
        profileRef.current = p;
        printMemorySnapshot(p, []);
      } else {
        console.log("\n📱 Fresh start — no previous memory\n");
      }
    } catch (e) { console.error("Load profile error:", e); }
  }

  async function saveProfile(p: UserProfile) {
    try {
      await AsyncStorage.setItem(MEMORY_KEY, JSON.stringify(p));
      setProfile({ ...p });
      profileRef.current = p;
    } catch (e) { console.error("Save profile error:", e); }
  }

  function checkNameCorrection(text: string): string | null {
    const lower = text.toLowerCase();
    for (const trigger of NAME_TRIGGERS) {
      if (lower.includes(trigger)) {
        const after = lower.split(trigger)[1]?.trim();
        if (after) {
          const name = after.split(/[\s,\.!?]/)[0];
          if (name && name.length > 1 && name.length < 20) {
            return name.charAt(0).toUpperCase() + name.slice(1);
          }
        }
      }
    }
    return null;
  }

  function checkMemoryPromotion(text: string): boolean {
    const lower = text.toLowerCase();
    return lower.includes("i already told you") ||
           lower.includes("i told you this") ||
           lower.includes("i mentioned this") ||
           lower.includes("remember when i said");
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
    sessionSummary.current = "";
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
    sessionSummary.current = "";
    setIsProcessing(false);
    setIsJuliaTalking(false);
    setIsMuted(false);
    isMutedRef.current = false;
  }

  async function toggleMute() {
    const newMuted = !isMutedRef.current;
    isMutedRef.current = newMuted;
    setIsMuted(newMuted);
    console.log(newMuted ? "🔇 Muted" : "🔊 Unmuted");
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
    if (shortSilTimer.current)    clearTimeout(shortSilTimer.current);
    if (longSilTimer.current)     clearTimeout(longSilTimer.current);
    if (meteringInterval.current) clearInterval(meteringInterval.current);
    shortSilTimer.current    = null;
    longSilTimer.current     = null;
    meteringInterval.current = null;
  }

  async function startListening() {
    if (!isActiveRef.current || isMutedRef.current) return;
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
      let processingQueued = false;

      const maxTimer = setTimeout(() => {
        if (isActiveRef.current && recordingRef.current && !isMutedRef.current) {
          processSpeech();
        }
      }, 30000);

      meteringInterval.current = setInterval(async () => {
        if (!recordingRef.current || isMutedRef.current) {
          clearTimeout(maxTimer);
          return;
        }
        try {
          const st    = await recordingRef.current.getStatusAsync();
          if (!st.isRecording) return;
          const level = (st as any).metering ?? -160;
          const rms   = Math.pow(10, level / 20);

          if (rms > SPEECH_RMS) {
            speechDetected = true;
            processingQueued = false;
            // Clear both silence timers when speech resumes
            if (shortSilTimer.current) { clearTimeout(shortSilTimer.current); shortSilTimer.current = null; }
            if (longSilTimer.current)  { clearTimeout(longSilTimer.current);  longSilTimer.current  = null; }
          } else if (speechDetected && !processingQueued) {
            // Two-stage: short pause starts background prep, long pause triggers response
            if (!shortSilTimer.current) {
              shortSilTimer.current = setTimeout(() => {
                // Short pause hit — start processing in background but don't respond yet
                processingQueued = true;
              }, SILENCE_SHORT_MS);
            }
            if (!longSilTimer.current) {
              longSilTimer.current = setTimeout(() => {
                clearTimeout(maxTimer);
                processSpeech();
              }, SILENCE_LONG_MS);
            }
          }
        } catch {}
      }, CHUNK_MS);
    } catch (e) { console.error("Listen error:", e); }
  }

  async function processSpeech() {
    clearTimers();
    if (!recordingRef.current || isMutedRef.current) return;
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

      // Strip noise from end of transcription
      userText = userText
        .replace(/[,.]?\s*[Tt]hank you[.!]?\s*$/g, "")
        .replace(/[,.]?\s*[Tt]hanks[.!]?\s*$/g, "")
        .replace(/[,.]?\s*[Yy]ou\.?\s*$/g, "")
        .replace(/[,.]?\s*[Yy]ou\.?\s*$/g, "")
        .replace(/[,.]?\s*[Yy]ou're welcome[.!]?\s*$/g, "")
        .replace(/[,.]?\s*[Aa]nytime[.!]?\s*$/g, "")
        .replace(/^[\/\s]+/, "")
        .trim();

      const cleaned = userText.toLowerCase().trim().replace(/[^a-z0-9'\s]/g, "").trim();

      if (!userText || userText.length < 2 || HALLUCINATIONS.has(cleaned)) {
        setIsProcessing(false); resumeListening(); return;
      }

      // Filter garbled
      const garbledCount = (userText.match(/[^\w\s'\-,.!?]/g) || []).length;
      if (garbledCount > 3) {
        setIsProcessing(false); resumeListening(); return;
      }

      const isShortValid = SHORT_VALID.has(cleaned);
      if (!isShortValid && cleaned.split(/\s+/).length < 2) {
        setIsProcessing(false); resumeListening(); return;
      }

      // Check for exit cues
      const isExit = EXIT_CUES.has(cleaned) || [...EXIT_CUES].some(cue => cleaned.includes(cue));
      if (isExit) {
        console.log(`  👤 ${profileRef.current.layer1.name || USER_NAME}: ${userText}`);
        const exitMsg = "Talk soon! 👋";
        console.log(`  🤖 Julia: ${exitMsg}`);
        Speech.speak(exitMsg, { language: "en-US", pitch: 1.0, rate: 1.0 });
        setTimeout(() => hangUp(), 3000);
        return;
      }

      // Name correction
      const correctedName = checkNameCorrection(userText);
      if (correctedName) {
        const updated = { ...profileRef.current };
        updated.layer1.name = correctedName;
        await saveProfile(updated);
        console.log(`✏️  Name updated: "${correctedName}"`);
      }

      // Memory promotion check
      const needsPromotion = checkMemoryPromotion(userText);

      const displayName = profileRef.current.layer1.name || USER_NAME;
      console.log(`  👤 ${displayName}: ${userText}`);

      const newMsgs: Message[] = [...messagesRef.current, { role: "user", content: userText }];
      messagesRef.current = newMsgs;
      setMessages([...newMsgs]);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);

      // Update session summary for context
      sessionSummary.current += `\n${displayName}: ${userText}`;
      if (sessionSummary.current.length > 2000) {
        sessionSummary.current = sessionSummary.current.slice(-2000);
      }

      // Background memory save for substantive messages
      if (!isShortValid && cleaned.split(/\s+/).length >= 4) {
        processMessage(userText, profileRef.current, GROQ_API_KEY)
          .then(async ({ profile: updated, newMemories }) => {
            await saveProfile(updated);
            if (newMemories.length > 0) {
              console.log("\n✨ NEW FROM THIS CONVERSATION:");
              newMemories.forEach(m => console.log(`   + ${m}`));
            }
            if (needsPromotion) {
              console.log("📌 User indicated this should be remembered — promoting to Layer 1");
            }
          })
          .catch(e => console.log("Memory error:", e));
      }

      // Decide whether to include profile context
      // Only include if user references past or asks Julia if she remembers
      const referencingPast = cleaned.includes("remember") ||
        cleaned.includes("i told you") ||
        cleaned.includes("you know i") ||
        needsPromotion;

      const systemPrompt = buildSystemPrompt(
        profileRef.current,
        sessionSummary.current,
        referencingPast
      );

      console.log(`  ⏳ thinking...`);
      const reply = await groqCall(newMsgs, systemPrompt);

      if (!reply) {
        console.log("❌ No reply");
        setIsProcessing(false); resumeListening(); return;
      }

      // Add Julia's reply to session summary
      sessionSummary.current += `\nJulia: ${reply}`;

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
    if (!isActiveRef.current || isMutedRef.current) return;
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
  const displayName = profile.layer1.name || USER_NAME;

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