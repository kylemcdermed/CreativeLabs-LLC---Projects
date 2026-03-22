// ============================================================
// WalkManAI — Memory Service
// Single Groq call extracts and classifies memory
// ============================================================

import {
  UserProfile,
  addMemory,
  purgeExpired
} from "./memory";

const GROQ_URL  = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_FAST = "llama-3.1-8b-instant";

async function extractMemory(text: string, apiKey: string): Promise<any | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);

    const res = await fetch(GROQ_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_FAST,
        max_tokens: 400,
        temperature: 0.1,
        messages: [
          {
            role: "system",
            content: `You extract memory from what a HUMAN says to an AI friend. Focus on the HUMAN SPEAKER only.

Return ONLY raw JSON — no markdown, no explanation:
{
  "name": null,
  "age": null,
  "occupation": null,
  "location": null,
  "goal": null,
  "value": null,
  "fear": null,
  "achievement": null,
  "relationship": null,
  "identity_fact": null,
  "intermediate_topic": null,
  "fleeting_note": null,
  "keywords": []
}

Rules:
- name/age/occupation/location: basic profile facts about the speaker
- goal: something they are working toward or want to achieve
- value: something they deeply care about or believe in
- fear: a deep worry, trauma, or thing that troubles them
- achievement: a win, proud moment, or milestone they accomplished
- relationship: a person important to them (family, friend, colleague)
- identity_fact: a permanent fact that defines who they are as a person
- intermediate_topic: an ongoing topic/vent/situation (not permanent but recurring)
- fleeting_note: something said in passing, daily event, not important long term
- keywords: named people, places, companies mentioned (max 3)
- If nothing found for a field return null
- Never extract facts about the AI named Julia`
          },
          { role: "user", content: text }
        ]
      })
    });

    clearTimeout(timer);
    const data = await res.json();
    if (!data.choices) return null;
    const raw = data.choices[0].message.content.trim();
    return JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch (e) {
    return null;
  }
}

// ── Main memory processor ─────────────────────────────────
export async function processMessage(
  userText: string,
  profile: UserProfile,
  apiKey: string
): Promise<{ profile: UserProfile; newMemories: string[] }> {
  const newMemories: string[] = [];

  // Skip short messages
  if (userText.trim().split(/\s+/).length < 4) {
    return { profile, newMemories };
  }

  const extracted = await extractMemory(userText, apiKey);
  if (!extracted) return { profile, newMemories };

  // Layer 1 — permanent profile
  if (extracted.name && !profile.layer1.name) {
    profile.layer1.name = extracted.name;
    newMemories.push(`[PROFILE] Name: ${extracted.name}`);
  }
  if (extracted.age && !profile.layer1.age) {
    profile.layer1.age = extracted.age;
    newMemories.push(`[PROFILE] Age: ${extracted.age}`);
  }
  if (extracted.occupation && !profile.layer1.occupation) {
    profile.layer1.occupation = extracted.occupation;
    newMemories.push(`[PROFILE] Occupation: ${extracted.occupation}`);
  }
  if (extracted.location && !profile.layer1.location) {
    profile.layer1.location = extracted.location;
    newMemories.push(`[PROFILE] Location: ${extracted.location}`);
  }
  if (extracted.goal) {
    const exists = profile.layer1.goals.some(g => g.text.toLowerCase().includes(extracted.goal.toLowerCase().slice(0, 20)));
    if (!exists) {
      const { profile: p } = addMemory(profile, extracted.goal, "layer1", "goals");
      profile = p;
      newMemories.push(`[LAYER 1 — GOAL] ${extracted.goal}`);
    }
  }
  if (extracted.value) {
    const exists = profile.layer1.values.some(v => v.text.toLowerCase().includes(extracted.value.toLowerCase().slice(0, 20)));
    if (!exists) {
      const { profile: p } = addMemory(profile, extracted.value, "layer1", "values");
      profile = p;
      newMemories.push(`[LAYER 1 — VALUE] ${extracted.value}`);
    }
  }
  if (extracted.fear) {
    const { profile: p } = addMemory(profile, extracted.fear, "layer1", "fears");
    profile = p;
    newMemories.push(`[LAYER 1 — FEAR/TRAUMA] ${extracted.fear}`);
  }
  if (extracted.achievement) {
    const { profile: p } = addMemory(profile, extracted.achievement, "layer1", "achievements");
    profile = p;
    newMemories.push(`[LAYER 1 — ACHIEVEMENT] ${extracted.achievement}`);
  }
  if (extracted.relationship) {
    const exists = profile.layer1.relationships.some(r => r.text.toLowerCase().includes(extracted.relationship.toLowerCase().slice(0, 20)));
    if (!exists) {
      const { profile: p } = addMemory(profile, extracted.relationship, "layer1", "relationships");
      profile = p;
      newMemories.push(`[LAYER 1 — RELATIONSHIP] ${extracted.relationship}`);
    }
  }
  if (extracted.identity_fact) {
    const exists = profile.layer1.identity.some(i => i.text.toLowerCase().includes(extracted.identity_fact.toLowerCase().slice(0, 20)));
    if (!exists) {
      const { profile: p } = addMemory(profile, extracted.identity_fact, "layer1", "identity");
      profile = p;
      newMemories.push(`[LAYER 1 — IDENTITY] ${extracted.identity_fact}`);
    }
  }

  // Intermediate — 3 week
  if (extracted.intermediate_topic) {
    const exists = profile.intermediate.some(e => e.text.toLowerCase().includes(extracted.intermediate_topic.toLowerCase().slice(0, 20)));
    if (!exists) {
      const { profile: p } = addMemory(profile, extracted.intermediate_topic, "intermediate");
      profile = p;
      newMemories.push(`[INTERMEDIATE — 3 weeks] ${extracted.intermediate_topic}`);
    }
  }

  // Layer 2 — 3 day
  if (extracted.fleeting_note) {
    const { profile: p } = addMemory(profile, extracted.fleeting_note, "layer2");
    profile = p;
    newMemories.push(`[LAYER 2 — 3 days] ${extracted.fleeting_note}`);
  }

  // Keywords
  const stopWords = new Set(["you", "julia", "i", "me", "we", "he", "she", "they", "it"]);
  if (extracted.keywords?.length > 0) {
    extracted.keywords
      .filter((w: string) => w && w.length > 1 && !stopWords.has(w.toLowerCase()))
      .forEach((word: string) => {
        newMemories.push(`[KEYWORD] ${word}`);
      });
  }

  // Purge expired
  profile = purgeExpired(profile);
  profile.last_session = new Date().toISOString();

  return { profile, newMemories };
}

// ── Print clean memory snapshot ───────────────────────────
export function printMemorySnapshot(profile: UserProfile, newItems: string[]) {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("🧠 JULIA MEMORY PROFILE");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const { layer1 } = profile;
  console.log(`\n📌 LAYER 1 — PERMANENT PROFILE`);
  console.log(`   Name: ${layer1.name || "unknown"} | Age: ${layer1.age || "unknown"} | Occupation: ${layer1.occupation || "unknown"} | Location: ${layer1.location || "unknown"}`);
  if (layer1.identity.length)       { console.log(`   Identity:`);      layer1.identity.slice(-4).forEach(e => console.log(`     • ${e.text}`)); }
  if (layer1.goals.length)          { console.log(`   Goals:`);         layer1.goals.slice(-4).forEach(e => console.log(`     • ${e.text}`)); }
  if (layer1.values.length)         { console.log(`   Values:`);        layer1.values.slice(-3).forEach(e => console.log(`     • ${e.text}`)); }
  if (layer1.achievements.length)   { console.log(`   Achievements:`);  layer1.achievements.slice(-4).forEach(e => console.log(`     • ${e.text}`)); }
  if (layer1.fears.length)          { console.log(`   Fears/Trauma:`);  layer1.fears.slice(-3).forEach(e => console.log(`     • ${e.text}`)); }
  if (layer1.relationships.length)  { console.log(`   Relationships:`); layer1.relationships.slice(-4).forEach(e => console.log(`     • ${e.text}`)); }

  console.log(`\n🔄 INTERMEDIATE — Ongoing topics (3 weeks)`);
  if (profile.intermediate.length) {
    profile.intermediate.forEach(e => {
      const exp = e.expires_at ? `expires ${new Date(e.expires_at).toLocaleDateString()}` : "";
      console.log(`     • ${e.text} ${exp ? `(${exp})` : ""}`);
    });
  } else console.log(`   (none)`);

  console.log(`\n💬 LAYER 2 — Recent conversation (3 days)`);
  if (profile.layer2.length) {
    profile.layer2.forEach(e => {
      const exp = e.expires_at ? `expires ${new Date(e.expires_at).toLocaleDateString()}` : "";
      console.log(`     • ${e.text} ${exp ? `(${exp})` : ""}`);
    });
  } else console.log(`   (none)`);

  if (newItems.length > 0) {
    console.log(`\n✨ NEW FROM THIS CONVERSATION:`);
    newItems.forEach(item => console.log(`   + ${item}`));
  }

  console.log(`\n   Sessions: ${profile.total_sessions} | Last: ${profile.last_session}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}