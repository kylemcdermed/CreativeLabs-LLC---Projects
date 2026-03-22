// ============================================================
// WalkManAI — Memory System
// Three-tier architecture based on our alignment session
// ============================================================

export interface MemoryEntry {
  id: string;
  text: string;
  saved_at: string;
  last_mentioned: string;
  times_mentioned: number;
  tier: "layer1" | "intermediate" | "layer2";
  expires_at: string | null; // null = permanent
  keywords: string[];
}

export interface UserProfile {
  // ── LAYER 1 — Permanent profile (who they are) ───────────
  layer1: {
    // Public identity
    name?: string;
    age?: number;
    occupation?: string;
    location?: string;
    // Private/personal
    values: MemoryEntry[];       // what they care about deeply
    goals: MemoryEntry[];        // what they are working toward
    fears: MemoryEntry[];        // deep worries or traumas
    achievements: MemoryEntry[]; // proud moments, wins
    relationships: MemoryEntry[]; // people important to them
    identity: MemoryEntry[];     // general facts defining who they are
  };

  // ── INTERMEDIATE — 3 week memory (ongoing topics) ────────
  intermediate: MemoryEntry[];

  // ── LAYER 2 — 3 day memory (fleeting conversation) ───────
  layer2: MemoryEntry[];

  // ── Meta ──────────────────────────────────────────────────
  created_at: string;
  last_session: string;
  total_sessions: number;
}

export function createEmptyProfile(): UserProfile {
  const now = new Date().toISOString();
  return {
    layer1: {
      values: [],
      goals: [],
      fears: [],
      achievements: [],
      relationships: [],
      identity: [],
    },
    intermediate: [],
    layer2: [],
    created_at: now,
    last_session: now,
    total_sessions: 0,
  };
}

function newEntry(
  text: string,
  tier: "layer1" | "intermediate" | "layer2",
  keywords: string[] = []
): MemoryEntry {
  const now = new Date();
  let expires_at: string | null = null;

  if (tier === "layer2") {
    const exp = new Date(now);
    exp.setDate(exp.getDate() + 3);
    expires_at = exp.toISOString();
  } else if (tier === "intermediate") {
    const exp = new Date(now);
    exp.setDate(exp.getDate() + 21);
    expires_at = exp.toISOString();
  }

  return {
    id: Math.random().toString(36).slice(2, 10),
    text,
    saved_at: now.toISOString(),
    last_mentioned: now.toISOString(),
    times_mentioned: 1,
    tier,
    expires_at,
    keywords: keywords.map(k => k.toLowerCase()),
  };
}

// ── Purge expired entries ─────────────────────────────────
export function purgeExpired(profile: UserProfile): UserProfile {
  const now = new Date();
  const alive = (e: MemoryEntry) => !e.expires_at || new Date(e.expires_at) > now;
  profile.intermediate = profile.intermediate.filter(alive);
  profile.layer2 = profile.layer2.filter(alive);
  return profile;
}

// ── Promote entry from layer2/intermediate to layer1 ─────
export function promoteToLayer1(
  profile: UserProfile,
  entryId: string,
  category: keyof UserProfile["layer1"]
): UserProfile {
  // Find in layer2 or intermediate
  let entry = profile.layer2.find(e => e.id === entryId)
    || profile.intermediate.find(e => e.id === entryId);

  if (!entry) return profile;

  // Remove from current tier
  profile.layer2 = profile.layer2.filter(e => e.id !== entryId);
  profile.intermediate = profile.intermediate.filter(e => e.id !== entryId);

  // Add to layer1
  const promoted = { ...entry, tier: "layer1" as const, expires_at: null };
  if (Array.isArray(profile.layer1[category])) {
    (profile.layer1[category] as MemoryEntry[]).push(promoted);
  }

  return profile;
}

// ── Build compact profile context for Julia ───────────────
// Only called when user prompts memory — not on every response
export function buildProfileContext(profile: UserProfile): string {
  const lines: string[] = [];
  const { layer1 } = profile;

  const basic = [
    layer1.name && `Name: ${layer1.name}`,
    layer1.age && `Age: ${layer1.age}`,
    layer1.occupation && `Occupation: ${layer1.occupation}`,
    layer1.location && `Location: ${layer1.location}`,
  ].filter(Boolean).join(" | ");

  if (basic) lines.push(basic);

  if (layer1.goals.length) {
    lines.push("Goals: " + layer1.goals.slice(-3).map(g => g.text).join("; "));
  }
  if (layer1.values.length) {
    lines.push("Values: " + layer1.values.slice(-3).map(v => v.text).join("; "));
  }
  if (layer1.achievements.length) {
    lines.push("Wins: " + layer1.achievements.slice(-3).map(a => a.text).join("; "));
  }
  if (layer1.fears.length) {
    lines.push("Deep concerns: " + layer1.fears.slice(-2).map(f => f.text).join("; "));
  }
  if (layer1.relationships.length) {
    lines.push("People: " + layer1.relationships.slice(-3).map(r => r.text).join("; "));
  }
  if (layer1.identity.length) {
    lines.push("Who they are: " + layer1.identity.slice(-3).map(i => i.text).join("; "));
  }

  return lines.length > 0 ? lines.join("\n") : "No profile built yet.";
}

// ── Add to memory ─────────────────────────────────────────
export function addMemory(
  profile: UserProfile,
  text: string,
  tier: "layer1" | "intermediate" | "layer2",
  layer1Category?: keyof UserProfile["layer1"],
  keywords: string[] = []
): { profile: UserProfile; entry: MemoryEntry } {
  const entry = newEntry(text, tier, keywords);

  if (tier === "layer1" && layer1Category && Array.isArray(profile.layer1[layer1Category])) {
    (profile.layer1[layer1Category] as MemoryEntry[]).push(entry);
  } else if (tier === "intermediate") {
    profile.intermediate.push(entry);
  } else if (tier === "layer2") {
    profile.layer2.push(entry);
  }

  return { profile, entry };
}