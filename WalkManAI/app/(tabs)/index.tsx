import { Audio } from "expo-av";
import * as Speech from "expo-speech";
import { useRef, useState } from "react";
import {
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";

const GROQ_API_KEY = "GROQ_KEY_HERE";
const USER_NAME    = "Kyle";
const GROQ_URL     = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MAIN    = "llama-3.3-70b-versatile";
const WHISPER_URL  = "https://api.groq.com/openai/v1/audio/transcriptions";

const SILENCE_THRESHOLD_MS = 2000;
const CHUNK_INTERVAL_MS    = 100;
const SPEECH_THRESHOLD     = 0.015;

const JULIA_SYSTEM = `You are Julia, ${USER_NAME}'s AI friend. You listen, you react, you remember what he tells you.

CRITICAL RULES:
- You have NO personal life, NO stories, NO family, NO experiences of your own
- Never say things that infer you have a background because you do not, you are a companion, a friend listening to another friend
- You are building an profile of the person who is speaking so in the future you can bring up topics relating to previous interests or stories mentioned
- If asked questions, respond with positive cheerful advice relating to the topic at hand

YOUR ONLY JOB:
- Listen to what ${USER_NAME} says
- React genuinely and briefly
- Ask ONE short follow up question
- Build a picture of who he is over time through what he shares

HOW TO RESPOND:
- 1-2 sentences MAX — short, punchy, real
- React first, question second
- Match his energy exactly
- No filler: drop "that's great" "I hear you" "absolutely" "certainly"
- Sound like a real person on a call, not a chatbot

GOOD: "That's messed up — what did you do?"
GOOD: "Wait seriously? How long has that been going on?"
GOOD: "Okay that actually sounds really good. What made you decide to do it?"

BAD: "I totally understand, I had a similar experience with my sister last week!"
BAD: "That sounds really interesting! How did that make you feel?"
BAD: "Absolutely Kyle, I am here for you!"`;

type Message = { role: "user" | "assistant"; content: string };

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
  console.error("Groq error:", JSON.stringify(data));
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

export default function JuliaScreen() {
  const [messages, setMessages]             = useState<Message[]>([]);
  const [status, setStatus]                 = useState("Tap to start talking to Julia");
  const [isCallActive, setIsCallActive]     = useState(false);
  const [isJuliaTalking, setIsJuliaTalking] = useState(false);
  const [isProcessing, setIsProcessing]     = useState(false);

  const recordingRef      = useRef<Audio.Recording | null>(null);
  const scrollRef         = useRef<ScrollView>(null);
  const silenceTimer      = useRef<ReturnType<typeof setTimeout> | null>(null);
  const meteringInterval  = useRef<ReturnType<typeof setInterval> | null>(null);
  const isListeningRef    = useRef(false);
  const isCallActiveRef   = useRef(false);
  const messagesRef       = useRef<Message[]>([]);

  const addMessage = (msg: Message) => {
    const updated = [...messagesRef.current, msg];
    messagesRef.current = updated;
    setMessages(updated);
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
  };

  async function startCall() {
    const { granted } = await Audio.requestPermissionsAsync();
    if (!granted) { setStatus("Microphone permission needed"); return; }
    await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
    isCallActiveRef.current = true;
    setIsCallActive(true);
    setStatus("Listening...");
    messagesRef.current = [];
    setMessages([]);
    startListening();
  }

  async function endCall() {
    isCallActiveRef.current = false;
    setIsCallActive(false);
    setIsJuliaTalking(false);
    setIsProcessing(false);
    isListeningRef.current = false;
    Speech.stop();
    clearTimers();
    if (recordingRef.current) {
      try { await recordingRef.current.stopAndUnloadAsync(); } catch {}
      recordingRef.current = null;
    }
    setStatus("Tap to start talking to Julia");
  }

  function clearTimers() {
    if (silenceTimer.current)     clearTimeout(silenceTimer.current);
    if (meteringInterval.current) clearInterval(meteringInterval.current);
    silenceTimer.current     = null;
    meteringInterval.current = null;
  }

  async function startListening() {
    if (!isCallActiveRef.current) return;
    isListeningRef.current = true;
    try {
      const { recording } = await Audio.Recording.createAsync({
        ...Audio.RecordingOptionsPresets.HIGH_QUALITY,
        isMeteringEnabled: true,
      });
      recordingRef.current = recording;
      setStatus("Listening...");

      meteringInterval.current = setInterval(async () => {
        if (!recordingRef.current) return;
        try {
          const st = await recordingRef.current.getStatusAsync();
          if (!st.isRecording) return;
          const level = (st as any).metering ?? -160;
          const rms   = Math.pow(10, level / 20);
          const isSpeaking = rms > SPEECH_THRESHOLD;
          if (isSpeaking) {
            if (silenceTimer.current) { clearTimeout(silenceTimer.current); silenceTimer.current = null; }
            setStatus("Listening...");
          } else {
            if (!silenceTimer.current) {
              silenceTimer.current = setTimeout(() => { processSpeech(); }, SILENCE_THRESHOLD_MS);
            }
          }
        } catch {}
      }, CHUNK_INTERVAL_MS);
    } catch (e) {
      console.error("Listen error:", e);
      setStatus("Mic error — try ending and restarting");
    }
  }

  async function processSpeech() {
    clearTimers();
    isListeningRef.current = false;
    if (!recordingRef.current) return;
    setIsProcessing(true);
    setStatus("Got it, thinking...");
    try {
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;
      if (!uri) { setIsProcessing(false); resumeListening(); return; }

      const userText = await transcribeAudio(uri);
      if (!userText || userText.length < 2) { setIsProcessing(false); resumeListening(); return; }

      addMessage({ role: "user", content: userText });

      const reply = await groqCall(messagesRef.current, JULIA_SYSTEM);
      if (!reply) { setIsProcessing(false); resumeListening(); return; }

      addMessage({ role: "assistant", content: reply });
      setIsProcessing(false);
      setIsJuliaTalking(true);
      setStatus("Julia is talking...");

      Speech.speak(reply, {
        language: "en-US",
        pitch: 1.2,
        rate: 1.1,
        onDone:  () => { setIsJuliaTalking(false); if (isCallActiveRef.current) resumeListening(); },
        onError: () => { setIsJuliaTalking(false); if (isCallActiveRef.current) resumeListening(); },
      });
    } catch (e) {
      console.error("Process error:", e);
      setIsProcessing(false);
      resumeListening();
    }
  }

  function resumeListening() {
    if (!isCallActiveRef.current) return;
    setStatus("Listening...");
    startListening();
  }

  return (
    <SafeAreaView style={s.container}>
      <View style={s.header}>
        <Text style={s.title}>Julia</Text>
        <Text style={s.subtitle}>
          {isCallActive
            ? isJuliaTalking ? "speaking..." : isProcessing ? "thinking..." : "listening..."
            : "your AI friend"}
        </Text>
      </View>

      <ScrollView ref={scrollRef} style={s.chat} contentContainerStyle={s.chatContent}>
        {messages.length === 0 && (
          <Text style={s.empty}>
            {isCallActive
              ? "Go ahead, I am listening..."
              : `Hey ${USER_NAME}. Tap the button and just start talking.`}
          </Text>
        )}
        {messages.map((msg, i) => (
          <View key={i} style={[s.bubble, msg.role === "user" ? s.userBubble : s.juliaBubble]}>
            <Text style={s.bubbleName}>{msg.role === "user" ? USER_NAME : "Julia"}</Text>
            <Text style={s.bubbleText}>{msg.content}</Text>
          </View>
        ))}
        {isProcessing && (
          <View style={[s.bubble, s.juliaBubble]}>
            <Text style={s.bubbleName}>Julia</Text>
            <ActivityIndicator color="#a78bfa" size="small" style={{ marginTop: 4 }} />
          </View>
        )}
      </ScrollView>

      <Text style={s.status}>{status}</Text>

      <View style={s.controls}>
        {!isCallActive ? (
          <TouchableOpacity style={s.startBtn} onPress={startCall}>
            <Text style={s.btnText}>🎙️  Start Talking</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity style={s.endBtn} onPress={endCall}>
            <Text style={s.btnText}>📵  End Call</Text>
          </TouchableOpacity>
        )}
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container:    { flex: 1, backgroundColor: "#0f0f13" },
  header:       { paddingTop: 20, paddingBottom: 16, alignItems: "center", borderBottomWidth: 1, borderBottomColor: "#1e1e2e" },
  title:        { fontSize: 28, fontWeight: "700", color: "#a78bfa", letterSpacing: 1 },
  subtitle:     { fontSize: 13, color: "#666", marginTop: 2 },
  chat:         { flex: 1, paddingHorizontal: 16 },
  chatContent:  { paddingTop: 20, paddingBottom: 10 },
  empty:        { color: "#555", textAlign: "center", marginTop: 60, fontSize: 15, lineHeight: 26 },
  bubble:       { marginBottom: 14, padding: 14, borderRadius: 16, maxWidth: "88%" },
  userBubble:   { backgroundColor: "#1e1b4b", alignSelf: "flex-end", borderBottomRightRadius: 4 },
  juliaBubble:  { backgroundColor: "#1a1a2e", alignSelf: "flex-start", borderBottomLeftRadius: 4, borderLeftWidth: 3, borderLeftColor: "#a78bfa" },
  bubbleName:   { fontSize: 11, fontWeight: "600", color: "#a78bfa", marginBottom: 4, textTransform: "uppercase", letterSpacing: 0.5 },
  bubbleText:   { fontSize: 15, color: "#e2e2f0", lineHeight: 22 },
  status:       { textAlign: "center", color: "#555", fontSize: 13, paddingVertical: 10 },
  controls:     { paddingHorizontal: 24, paddingBottom: 36, paddingTop: 8 },
  startBtn:     { backgroundColor: "#7c3aed", borderRadius: 50, paddingVertical: 18, alignItems: "center" },
  endBtn:       { backgroundColor: "#991b1b", borderRadius: 50, paddingVertical: 18, alignItems: "center" },
  btnText:      { color: "#fff", fontSize: 17, fontWeight: "600" },
});