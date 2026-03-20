// ============================================================
// WalkManAI — Memory Service
// Single Groq call, clean terminal output
// ============================================================

import {
  UserProfile,
  checkPromotions,
  newEntry,
  purgeExpired,
} from "./memory";

const GROQ_URL  = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_FAST = "llama-3.1-8b-instant";

const BRAIN_LABELS: Record<string, string> = {
  neocortex:     "NEOCORTEX        — Long term | Permanent | General facts about who you are",
  amygdala:      "AMYGDALA         — Long term | Permanent | Emotional memories (trauma, joy, attachments)",
  basal_ganglia: "BASAL GANGLIA    — Long term | Permanent | Habits, interests, dislikes",
  cerebellum:    "CEREBELLUM       — Intermediate | ~30 days | New skills being learned",
  hippocampus:   "HIPPOCAMPUS      — Fluid | Short→Mid→Long | Personal events and stories",
  keywords:      "KEYWORD INDEX    — Short term | 7 days | Named people, places, companies",
};

// ── Single Groq call to extract all memory ────────────────
async function extractMemory(text: string, apiKey: string): Promise<any | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);

    const res = await fetch(GROQ_URL, {
      method: "POST",
      signal: controller.signal,
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
            content: `You are a memory extraction system listening to what a HUMAN USER says to an AI friend.
Extract facts about the HUMAN SPEAKER ONLY — never about the AI named Julia.
The human may say they are building an app, doing a project, taking a test — those are facts about THEM.
Return ONLY raw JSON, no markdown, no explanation.

{
  "name": null,
  "age": null,
  "occupation": null,
  "location": null,
  "general_fact": null,
  "trauma": null,
  "joy": null,
  "attachment": null,
  "habit": null,
  "interest": null,
  "dislike": null,
  "skill": null,
  "event": null,
  "keywords": []
}

Rules:
- Only extract clear, definitive facts — not guesses
- name: speaker's first name if they say it
- age: only if they clearly state their current age
- occupation: their job
- location: where they live
- general_fact: permanent fact about who they are
- trauma: deep pain or loss they experienced
- joy: proud moment or achievement
- attachment: person or thing they deeply love
- habit: something they do regularly
- interest: passion or hobby
- dislike: something they hate
- skill: something they are learning or building right now
- event: a specific story or thing that happened to them
- keywords: named people, places, companies (max 3, never "you", never "Julia", never "I")
- If the message is too short or unclear to extract anything meaningful, return all nulls and empty array`
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

// ── Clean formatted memory snapshot ──────────────────────
function printMemorySnapshot(profile: UserProfile, newItems: string[]) {
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("🧠 JULIA MEMORY PROFILE");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  console.log(`\n📌 ${BRAIN_LABELS.neocortex}`);
  console.log(`   Name: ${profile.neocortex.name || "unknown"}`);
  console.log(`   Age: ${profile.neocortex.age || "unknown"}`);
  console.log(`   Occupation: ${profile.neocortex.occupation || "unknown"}`);
  console.log(`   Location: ${profile.neocortex.location || "unknown"}`);
  if (profile.neocortex.facts.length > 0) {
    console.log(`   Facts:`);
    profile.neocortex.facts.slice(-5).forEach(f => console.log(`     • ${f.text}`));
  }

  console.log(`\n❤️  ${BRAIN_LABELS.amygdala}`);
  if (profile.amygdala.traumas.length > 0) {
    console.log(`   Traumas/Pain:`);
    profile.amygdala.traumas.forEach(t => console.log(`     • ${t.text}`));
  }
  if (profile.amygdala.joys.length > 0) {
    console.log(`   Joys/Achievements:`);
    profile.amygdala.joys.forEach(j => console.log(`     • ${j.text}`));
  }
  if (profile.amygdala.attachments.length > 0) {
    console.log(`   Attachments:`);
    profile.amygdala.attachments.forEach(a => console.log(`     • ${a.text}`));
  }
  if (profile.amygdala.traumas.length === 0 && profile.amygdala.joys.length === 0 && profile.amygdala.attachments.length === 0) {
    console.log(`   (none yet)`);
  }

  console.log(`\n🎯 ${BRAIN_LABELS.basal_ganglia}`);
  if (profile.basal_ganglia.habits.length > 0) {
    console.log(`   Habits:`);
    profile.basal_ganglia.habits.forEach(h => console.log(`     • ${h.text}`));
  }
  if (profile.basal_ganglia.interests.length > 0) {
    console.log(`   Interests:`);
    profile.basal_ganglia.interests.forEach(i => console.log(`     • ${i.text}`));
  }
  if (profile.basal_ganglia.dislikes.length > 0) {
    console.log(`   Dislikes:`);
    profile.basal_ganglia.dislikes.forEach(d => console.log(`     • ${d.text}`));
  }
  if (profile.basal_ganglia.habits.length === 0 && profile.basal_ganglia.interests.length === 0 && profile.basal_ganglia.dislikes.length === 0) {
    console.log(`   (none yet)`);
  }

  console.log(`\n🏋️  ${BRAIN_LABELS.cerebellum}`);
  if (profile.cerebellum.skills.length > 0) {
    profile.cerebellum.skills.forEach(s => console.log(`     • ${s.text}`));
  } else {
    console.log(`   (none yet)`);
  }

  console.log(`\n📖 ${BRAIN_LABELS.hippocampus}`);
  if (profile.hippocampus.events.length > 0) {
    profile.hippocampus.events.slice(-5).forEach(e => console.log(`     • ${e.text}`));
  } else {
    console.log(`   (none yet)`);
  }

  console.log(`\n🔑 ${BRAIN_LABELS.keywords}`);
  const filtered = profile.keywords.filter(
    k => !["you", "julia", "i", "me", "we"].includes(k.word.toLowerCase())
  );
  if (filtered.length > 0) {
    filtered.forEach(k => console.log(`     • ${k.word} (seen ${k.times_seen}x, tier: ${k.tier})`));
  } else {
    console.log(`   (none yet)`);
  }

  if (newItems.length > 0) {
    console.log(`\n✨ NEW FROM THIS MESSAGE:`);
    newItems.forEach(item => console.log(`     + ${item}`));
  } else {
    console.log(`\n💭 Nothing new detected`);
  }

  console.log(`\n   Sessions: ${profile.total_sessions} | Last active: ${profile.last_session}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}

// ── Main process function ─────────────────────────────────
export async function processMessage(
  userText: string,
  profile: UserProfile,
  apiKey: string,
  tone: string = "neutral"
): Promise<{ profile: UserProfile; newMemories: string[] }> {
  const newMemories: string[] = [];
  const now = new Date().toISOString();

  // Skip very short messages — not enough content to extract memory from
  const wordCount = userText.trim().split(/\s+/).length;
  if (wordCount < 5) {
    printMemorySnapshot(profile, []);
    return { profile, newMemories };
  }

  const extracted = await extractMemory(userText, apiKey);
  if (!extracted) {
    printMemorySnapshot(profile, []);
    return { profile, newMemories };
  }

  // ── Neocortex ─────────────────────────────────────────
  if (extracted.name && !profile.neocortex.name) {
    profile.neocortex.name = extracted.name;
    newMemories.push(`[NEOCORTEX] Name: ${extracted.name}`);
  }
  if (extracted.age && !profile.neocortex.age) {
    profile.neocortex.age = extracted.age;
    newMemories.push(`[NEOCORTEX] Age: ${extracted.age}`);
  }
  if (extracted.occupation && !profile.neocortex.occupation) {
    profile.neocortex.occupation = extracted.occupation;
    newMemories.push(`[NEOCORTEX] Occupation: ${extracted.occupation}`);
  }
  if (extracted.location && !profile.neocortex.location) {
    profile.neocortex.location = extracted.location;
    newMemories.push(`[NEOCORTEX] Location: ${extracted.location}`);
  }
  if (extracted.general_fact) {
    const exists = profile.neocortex.facts.some(f =>
      f.text.toLowerCase().includes(extracted.general_fact.toLowerCase().slice(0, 20))
    );
    if (!exists) {
      profile.neocortex.facts.push(newEntry(extracted.general_fact));
      newMemories.push(`[NEOCORTEX] Fact: ${extracted.general_fact}`);
    }
  }

  // ── Amygdala ──────────────────────────────────────────
  if (extracted.trauma) {
    profile.amygdala.traumas.push(newEntry(extracted.trauma));
    newMemories.push(`[AMYGDALA] Trauma: ${extracted.trauma}`);
  }
  if (extracted.joy) {
    profile.amygdala.joys.push(newEntry(extracted.joy));
    newMemories.push(`[AMYGDALA] Joy: ${extracted.joy}`);
  }
  if (extracted.attachment) {
    const exists = profile.amygdala.attachments.some(a =>
      a.text.toLowerCase().includes(extracted.attachment.toLowerCase().slice(0, 20))
    );
    if (!exists) {
      profile.amygdala.attachments.push(newEntry(extracted.attachment));
      newMemories.push(`[AMYGDALA] Attachment: ${extracted.attachment}`);
    }
  }

  // ── Basal Ganglia ─────────────────────────────────────
  if (extracted.habit) {
    const exists = profile.basal_ganglia.habits.some(h =>
      h.text.toLowerCase().includes(extracted.habit.toLowerCase().slice(0, 20))
    );
    if (!exists) {
      profile.basal_ganglia.habits.push(newEntry(extracted.habit));
      newMemories.push(`[BASAL GANGLIA] Habit: ${extracted.habit}`);
    }
  }
  if (extracted.interest) {
    const exists = profile.basal_ganglia.interests.some(i =>
      i.text.toLowerCase().includes(extracted.interest.toLowerCase().slice(0, 20))
    );
    if (!exists) {
      profile.basal_ganglia.interests.push(newEntry(extracted.interest));
      newMemories.push(`[BASAL GANGLIA] Interest: ${extracted.interest}`);
    }
  }
  if (extracted.dislike) {
    profile.basal_ganglia.dislikes.push(newEntry(extracted.dislike));
    newMemories.push(`[BASAL GANGLIA] Dislike: ${extracted.dislike}`);
  }

  // ── Cerebellum ────────────────────────────────────────
  if (extracted.skill) {
    const exists = profile.cerebellum.skills.some(s =>
      s.text.toLowerCase().includes(extracted.skill.toLowerCase().slice(0, 20))
    );
    if (!exists) {
      profile.cerebellum.skills.push(newEntry(extracted.skill));
      newMemories.push(`[CEREBELLUM] Skill: ${extracted.skill}`);
    }
  }

  // ── Hippocampus ───────────────────────────────────────
  if (extracted.event) {
    profile.hippocampus.events.push(newEntry(extracted.event));
    newMemories.push(`[HIPPOCAMPUS] Event: ${extracted.event}`);
  }

  // ── Keywords ─────────────────────────────────────────
  const stopWords = ["you", "julia", "i", "me", "we", "he", "she", "they", "it"];
  if (extracted.keywords && extracted.keywords.length > 0) {
    extracted.keywords
      .filter((w: string) => w && w.length > 1 && !stopWords.includes(w.toLowerCase()))
      .forEach((word: string) => {
        const existing = profile.keywords.find(
          k => k.word.toLowerCase() === word.toLowerCase()
        );
        if (existing) {
          existing.times_seen++;
          existing.tier = existing.times_seen >= 3 ? "long" : "intermediate";
          newMemories.push(`[KEYWORDS] Bumped: ${word} (${existing.times_seen}x)`);
        } else {
          profile.keywords.push({
            word,
            description: "mentioned in conversation",
            first_seen: now,
            times_seen: 1,
            tier: "short",
          });
          newMemories.push(`[KEYWORDS] New: ${word}`);
        }
      });
  }

  profile = purgeExpired(profile);
  profile = checkPromotions(profile);
  profile.last_session = now;

  printMemorySnapshot(profile, newMemories);
  return { profile, newMemories };
}

export async function detectTone(
  messages: string[],
  apiKey: string
): Promise<"venting" | "calm" | "excited" | "neutral"> {
  return "neutral";
}

export async function getOnboardingQuestion(
  profile: UserProfile,
  recentMessages: string[],
  apiKey: string
): Promise<string | null> {
  return null;
}