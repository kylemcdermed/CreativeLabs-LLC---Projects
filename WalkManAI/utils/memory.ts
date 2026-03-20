// ============================================================
// WalkManAI — Julia Memory System
// Brain-anatomy based memory architecture
// ============================================================
// Storage key in AsyncStorage: "julia_memory"
// ============================================================

export interface MemoryEntry {
  text: string;
  saved_at: string;        // ISO timestamp
  frequency: number;       // how many times this has come up
  last_mentioned: string;  // ISO timestamp
  keywords: string[];      // extracted keywords
}

export interface KeywordEntry {
  word: string;
  description: string;     // 1 sentence context
  first_seen: string;
  times_seen: number;
  tier: "short" | "intermediate" | "long";
}

export interface UserProfile {
  // ── Neocortex — permanent general facts ──────────────────
  neocortex: {
    name?: string;
    age?: number;
    occupation?: string;
    location?: string;
    facts: MemoryEntry[];       // general facts about who they are
  };

  // ── Amygdala — emotional memory, permanent ────────────────
  amygdala: {
    traumas: MemoryEntry[];     // losses, fears, deep pain
    joys: MemoryEntry[];        // achievements, proud moments, excitement
    attachments: MemoryEntry[]; // people/things they deeply care about
  };

  // ── Basal Ganglia — habits + interests, permanent ─────────
  basal_ganglia: {
    habits: MemoryEntry[];      // daily routines, what they do regularly
    interests: MemoryEntry[];   // things they love, hobbies, passions
    dislikes: MemoryEntry[];    // things they hate or avoid
  };

  // ── Cerebellum — new skills, intermediate → long ──────────
  cerebellum: {
    skills: MemoryEntry[];      // new things they are learning or doing
  };

  // ── Hippocampus — personal events, fluid tier ────────────
  hippocampus: {
    events: MemoryEntry[];      // stories, things that happened
  };

  // ── Prefrontal Cortex — session only, never saved ─────────
  // (handled in component state, not persisted)

  // ── Keyword index ─────────────────────────────────────────
  keywords: KeywordEntry[];

  // ── Meta ──────────────────────────────────────────────────
  created_at: string;
  last_session: string;
  total_sessions: number;
  onboarding_complete: boolean;
}

// ── Default empty profile ─────────────────────────────────
export function createEmptyProfile(): UserProfile {
  const now = new Date().toISOString();
  return {
    neocortex: { facts: [] },
    amygdala:  { traumas: [], joys: [], attachments: [] },
    basal_ganglia: { habits: [], interests: [], dislikes: [] },
    cerebellum: { skills: [] },
    hippocampus: { events: [] },
    keywords: [],
    created_at: now,
    last_session: now,
    total_sessions: 0,
    onboarding_complete: false,
  };
}

// ── Tier expiry rules ─────────────────────────────────────
const TIER_EXPIRY_DAYS: Record<string, number | null> = {
  neocortex:     null,   // permanent
  amygdala:      null,   // permanent
  basal_ganglia: null,   // permanent
  cerebellum:    30,     // 30 days unless frequency promotes it
  hippocampus:   null,   // dynamic — see promotionCheck
  keywords:      7,      // 7 days if never promoted
};

// ── Frequency thresholds for promotion ────────────────────
// If a cerebellum or hippocampus entry is mentioned this many
// times it gets promoted to a permanent tier
const PROMOTION_THRESHOLD = 3;

// ── Build memory context string for Julia's system prompt ──
export function buildMemoryContext(profile: UserProfile): string {
  const lines: string[] = [];

  // Neocortex — who they are
  const { name, age, occupation, location, facts } = profile.neocortex;
  const basicInfo = [
    name       && `Name: ${name}`,
    age        && `Age: ${age}`,
    occupation && `Occupation: ${occupation}`,
    location   && `Location: ${location}`,
  ].filter(Boolean).join(" | ");

  if (basicInfo) lines.push(`WHO THEY ARE: ${basicInfo}`);
  if (facts.length) {
    lines.push("GENERAL FACTS:");
    facts.slice(-5).forEach(f => lines.push(`  • ${f.text}`));
  }

  // Amygdala — emotional core
  if (profile.amygdala.traumas.length) {
    lines.push("DEEP EMOTIONAL MEMORIES (traumas/losses):");
    profile.amygdala.traumas.slice(-3).forEach(t => lines.push(`  • ${t.text}`));
  }
  if (profile.amygdala.joys.length) {
    lines.push("PROUD MOMENTS / JOYS:");
    profile.amygdala.joys.slice(-3).forEach(j => lines.push(`  • ${j.text}`));
  }
  if (profile.amygdala.attachments.length) {
    lines.push("PEOPLE / THINGS THEY DEEPLY CARE ABOUT:");
    profile.amygdala.attachments.slice(-3).forEach(a => lines.push(`  • ${a.text}`));
  }

  // Basal ganglia — habits and interests
  if (profile.basal_ganglia.interests.length) {
    lines.push("INTERESTS / PASSIONS:");
    profile.basal_ganglia.interests.slice(-5).forEach(i => lines.push(`  • ${i.text}`));
  }
  if (profile.basal_ganglia.habits.length) {
    lines.push("DAILY HABITS / ROUTINES:");
    profile.basal_ganglia.habits.slice(-3).forEach(h => lines.push(`  • ${h.text}`));
  }

  // Cerebellum — things they are learning
  if (profile.cerebellum.skills.length) {
    lines.push("THINGS THEY ARE CURRENTLY LEARNING / WORKING ON:");
    profile.cerebellum.skills.slice(-3).forEach(s => lines.push(`  • ${s.text}`));
  }

  // Hippocampus — recent personal events
  if (profile.hippocampus.events.length) {
    lines.push("RECENT PERSONAL EVENTS:");
    profile.hippocampus.events.slice(-5).forEach(e => lines.push(`  • ${e.text}`));
  }

  // Keywords
  if (profile.keywords.length) {
    const topKeywords = profile.keywords
      .sort((a, b) => b.times_seen - a.times_seen)
      .slice(0, 8);
    lines.push("KEY TOPICS / PEOPLE / PLACES MENTIONED:");
    topKeywords.forEach(k => lines.push(`  • ${k.word}: ${k.description}`));
  }

  return lines.length > 0
    ? lines.join("\n")
    : "No profile built yet — this is the beginning. Listen carefully and start building a picture of who this person is.";
}

// ── Purge expired entries ─────────────────────────────────
export function purgeExpired(profile: UserProfile): UserProfile {
  const now = new Date();

  const isExpired = (entry: MemoryEntry, days: number) => {
    const saved = new Date(entry.saved_at);
    const diff  = (now.getTime() - saved.getTime()) / (1000 * 60 * 60 * 24);
    return diff > days && entry.frequency < PROMOTION_THRESHOLD;
  };

  // Purge cerebellum entries older than 30 days with low frequency
  profile.cerebellum.skills = profile.cerebellum.skills.filter(
    s => !isExpired(s, 30)
  );

  // Purge hippocampus events older than 30 days with low frequency
  profile.hippocampus.events = profile.hippocampus.events.filter(
    e => !isExpired(e, 30)
  );

  // Purge keywords older than 7 days with low frequency
  profile.keywords = profile.keywords.filter(k => {
    const saved = new Date(k.first_seen);
    const diff  = (now.getTime() - saved.getTime()) / (1000 * 60 * 60 * 24);
    return !(diff > 7 && k.times_seen < 2);
  });

  return profile;
}

// ── Promote frequently mentioned entries ──────────────────
export function checkPromotions(profile: UserProfile): UserProfile {
  const now = new Date().toISOString();

  // Cerebellum → Neocortex facts if mentioned 3+ times
  const toPromote = profile.cerebellum.skills.filter(
    s => s.frequency >= PROMOTION_THRESHOLD
  );
  toPromote.forEach(skill => {
    profile.neocortex.facts.push({ ...skill, saved_at: now });
  });
  profile.cerebellum.skills = profile.cerebellum.skills.filter(
    s => s.frequency < PROMOTION_THRESHOLD
  );

  // Hippocampus events mentioned 3+ times → amygdala joys or neocortex facts
  const importantEvents = profile.hippocampus.events.filter(
    e => e.frequency >= PROMOTION_THRESHOLD
  );
  importantEvents.forEach(event => {
    profile.neocortex.facts.push({ ...event, saved_at: now });
  });
  profile.hippocampus.events = profile.hippocampus.events.filter(
    e => e.frequency < PROMOTION_THRESHOLD
  );

  return profile;
}

// ── Increment frequency when topic comes up again ─────────
export function bumpFrequency(
  profile: UserProfile,
  keyword: string
): UserProfile {
  const k = profile.keywords.find(
    kw => kw.word.toLowerCase() === keyword.toLowerCase()
  );
  if (k) {
    k.times_seen++;
    k.tier = k.times_seen >= PROMOTION_THRESHOLD ? "long" : "intermediate";
  }

  // Also bump hippocampus and cerebellum entries that match
  profile.hippocampus.events = profile.hippocampus.events.map(e =>
    e.keywords.includes(keyword.toLowerCase())
      ? { ...e, frequency: e.frequency + 1, last_mentioned: new Date().toISOString() }
      : e
  );
  profile.cerebellum.skills = profile.cerebellum.skills.map(s =>
    s.keywords.includes(keyword.toLowerCase())
      ? { ...s, frequency: s.frequency + 1, last_mentioned: new Date().toISOString() }
      : s
  );

  return profile;
}

// ── Helper to create a new memory entry ───────────────────
export function newEntry(text: string, keywords: string[] = []): MemoryEntry {
  const now = new Date().toISOString();
  return {
    text,
    saved_at:       now,
    frequency:      1,
    last_mentioned: now,
    keywords:       keywords.map(k => k.toLowerCase()),
  };
}