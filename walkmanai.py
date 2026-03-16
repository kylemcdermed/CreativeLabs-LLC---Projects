# ============================================================
# WalkManAI - Voice Chat with Claude AI
# ============================================================
# pip install sounddevice wavio openai-whisper requests edge-tts nest_asyncio ipywidgets
# ============================================================

import sounddevice as sd
import wavio
import whisper
import os
import requests
import glob
import datetime
import asyncio
import nest_asyncio
from pathlib import Path
from IPython.display import display
import ipywidgets as widgets
import edge_tts

# Fix asyncio in Jupyter
nest_asyncio.apply()

# ============================================================
# CONFIG - Edit these
# ============================================================
CLAUDE_API_KEY = os.environ.get("CLAUDE_API_KEY") 
SAVE_FOLDER    = r"S:\WalkManAI_Recordings"
LOG_FILE       = os.path.join(SAVE_FOLDER, "conversation_log.txt")
TTS_VOICE      = "en-US-JennyNeural"             # Edge TTS voice
FS             = 44100
MAX_SECONDS    = 15

os.makedirs(SAVE_FOLDER, exist_ok=True)

# ============================================================
# GLOBALS
# ============================================================
conversation = []
recording    = None

# ============================================================
# FIND AIRPODS (falls back to default mic if not found)
# ============================================================
airpods_index = None
for i, dev in enumerate(sd.query_devices()):
    if "AirPods" in dev["name"]:
        airpods_index = i
        print(f"✅ AirPods found: device index {i}")
        break
if airpods_index is None:
    print("⚠️  AirPods not found — using default microphone")

# ============================================================
# VERSION HELPER
# ============================================================
def get_next_version():
    files = glob.glob(os.path.join(SAVE_FOLDER, "input_v*.wav"))
    if files:
        nums = [int(Path(f).stem.split("_v")[1]) for f in files]
        return max(nums) + 1
    return 1

# ============================================================
# STEP 1 — RECORD AUDIO
# ============================================================
def start_record(b):
    global recording
    recording = sd.rec(
        int(MAX_SECONDS * FS),
        samplerate=FS,
        channels=1,
        device=airpods_index
    )
    print("🎙️  Recording... click Stop when done.")

def stop_record(b):
    global recording

    # --- Stop & save WAV ---
    sd.stop()
    version    = get_next_version()
    input_file = os.path.join(SAVE_FOLDER, f"input_v{version}.wav")
    wavio.write(input_file, recording, FS, sampwidth=2)
    print(f"✅ Saved recording: {input_file}")

    # --- Transcribe ---
    user_text = transcribe(input_file)
    if not user_text:
        print("❌ Could not transcribe audio. Try again.")
        return

    # --- Ask Claude ---
    conversation.append({"role": "user", "content": user_text})
    ai_reply = ask_claude(conversation)
    conversation.append({"role": "assistant", "content": ai_reply})

    # --- Text-to-Speech ---
    output_file = os.path.join(SAVE_FOLDER, f"output_v{version}.mp3")
    asyncio.run(save_and_play(ai_reply, output_file))

    # --- Log ---
    log_conversation(version, user_text, ai_reply)

# ============================================================
# STEP 2 — TRANSCRIBE WITH WHISPER
# ============================================================
def transcribe(filename):
    print("⏳ Transcribing...")
    model  = whisper.load_model("base")
    result = model.transcribe(filename)
    text   = result["text"].strip()
    print(f"🗣️  You said: {text}")
    return text

# ============================================================
# STEP 3 — CALL CLAUDE API
# ============================================================
def ask_claude(convo):
    print("⏳ Asking Claude...")
    url     = "https://api.anthropic.com/v1/messages"
    headers = {
        "x-api-key":         CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type":      "application/json"
    }
    payload = {
        "model":      "claude-haiku-4-5-20251001",
        "max_tokens": 500,
        "messages":   convo
    }

    try:
        r        = requests.post(url, headers=headers, json=payload, timeout=30)
        response = r.json()

        if "content" in response:
            answer = response["content"][0]["text"].strip()
            print(f"🤖 Claude: {answer}")
            return answer
        else:
            error = response.get("error", {}).get("message", str(response))
            print(f"❌ Claude API error: {error}")
            return "Sorry, I had trouble getting a response from Claude."

    except Exception as e:
        print(f"❌ Request failed: {e}")
        return "Sorry, there was a network error reaching Claude."

# ============================================================
# STEP 4 — TEXT TO SPEECH + PLAY
# ============================================================
async def save_and_play(text, filename):
    print("⏳ Generating voice response...")
    communicate = edge_tts.Communicate(text, voice=TTS_VOICE)
    await communicate.save(filename)
    print(f"✅ Audio saved: {filename}")
    os.system(f'start "" "{filename}"')   # plays on Windows

# ============================================================
# STEP 5 — LOG CONVERSATION
# ============================================================
def log_conversation(version, user_text, ai_text):
    timestamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"\n[{timestamp}] v{version}\n")
        f.write(f"You : {user_text}\n")
        f.write(f"AI  : {ai_text}\n")
        f.write("-" * 60 + "\n")
    print(f"📝 Logged to: {LOG_FILE}")

# ============================================================
# BUTTONS
# ============================================================
start_btn = widgets.Button(
    description="🎙️ Start Recording",
    button_style="success",
    layout=widgets.Layout(width="200px", height="40px")
)
stop_btn = widgets.Button(
    description="⏹️ Stop & Ask Claude",
    button_style="danger",
    layout=widgets.Layout(width="200px", height="40px")
)

start_btn.on_click(start_record)
stop_btn.on_click(stop_record)

display(widgets.HBox([start_btn, stop_btn]))
print("Ready! Press Start to record your question.")
